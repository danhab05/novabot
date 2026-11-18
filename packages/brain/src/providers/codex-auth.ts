// Identifiants OAuth ChatGPT (Codex) pour les appels directs du cerveau.
//
// Stratégie (rotation des refresh tokens : ils sont à usage unique, deux programmes qui rafraîchissent
// le même login se déconnectent mutuellement — c'est pour ça que Hermes a son propre login device-code) :
//  1. Login PROPRE à Novabot (~/.novabot/codex-auth.json), créé par le flux device-code
//     (POST /api/brain/codex/login ou `bun packages/brain/src/providers/codex-login.ts`).
//     Novabot est le seul à le rafraîchir → aucun conflit.
//  2. À défaut, EMPRUNT en lecture seule de ~/.codex/auth.json (login de la CLI Codex).
//     Novabot n'y écrit JAMAIS et ne consomme jamais son refresh token. Si l'access token expire,
//     on relit le fichier ; s'il est toujours expiré, on fait tourner la CLI (`codex exec` minimal),
//     qui le rafraîchit elle-même, puis on relit.
import { readFileSync, existsSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOME, NOVA_DIR, jwtPayload } from "../util.ts";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const SKEW_S = 120;

export const OWN_FILE = join(NOVA_DIR, "codex-auth.json");
export const CLI_FILE = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "auth.json");

export interface CodexCreds { accessToken: string; accountId: string | null; source: "novabot" | "codex-cli" }

const expiresAt = (tok: string) => (jwtPayload(tok)?.exp ?? 0) as number;
const expiring = (tok: string) => expiresAt(tok) - Date.now() / 1000 < SKEW_S;
const accountOf = (tok: string, fallback?: string | null) => jwtPayload(tok)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? fallback ?? null;

function readJson(path: string): any { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function writeOwn(d: any) {
  const tmp = OWN_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  renameSync(tmp, OWN_FILE);
  chmodSync(OWN_FILE, 0o600);
}

let refreshing: Promise<CodexCreds> | null = null;
let cliRefreshing: Promise<void> | null = null;

async function refreshOwn(d: any): Promise<CodexCreds> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: d.refresh_token, client_id: CODEX_CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`refresh Codex (login Novabot) refusé : HTTP ${r.status} — refais le login (/api/brain/codex/login)`);
  const j: any = await r.json();
  const next = { ...d, access_token: j.access_token, refresh_token: j.refresh_token || d.refresh_token, id_token: j.id_token ?? d.id_token, last_refresh: new Date().toISOString() };
  writeOwn(next);
  return { accessToken: next.access_token, accountId: accountOf(next.access_token, next.account_id), source: "novabot" };
}

/** Fait rafraîchir le login de la CLI par la CLI elle-même (jamais par Novabot). */
function nudgeCli(): Promise<void> {
  cliRefreshing ??= (async () => {
    const p = Bun.spawn(["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "gpt-6-luna", "Réponds uniquement: ok"], {
      cwd: "/tmp", stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    const t = setTimeout(() => p.kill(), 90_000);
    await p.exited; clearTimeout(t);
  })().finally(() => { cliRefreshing = null; });
  return cliRefreshing;
}

export async function getCodexCreds(): Promise<CodexCreds> {
  const own = existsSync(OWN_FILE) ? readJson(OWN_FILE) : null;
  if (own?.access_token && own?.refresh_token) {
    if (!expiring(own.access_token)) return { accessToken: own.access_token, accountId: accountOf(own.access_token, own.account_id), source: "novabot" };
    refreshing ??= refreshOwn(own).finally(() => { refreshing = null; });
    return refreshing;
  }
  const read = () => readJson(CLI_FILE)?.tokens as { access_token?: string; account_id?: string } | undefined;
  let t = read();
  if (!t?.access_token) throw new Error("Aucun login Codex : ni ~/.novabot/codex-auth.json ni ~/.codex/auth.json");
  if (expiring(t.access_token)) {
    await nudgeCli();
    t = read();
    if (!t?.access_token || expiring(t.access_token)) throw new Error("Login Codex CLI expiré et non rafraîchi : lance `codex login` ou le login Novabot");
  }
  return { accessToken: t.access_token, accountId: accountOf(t.access_token, t.account_id), source: "codex-cli" };
}

/** Force la relecture après un 401 (le token a pu être tourné par la CLI entre-temps). */
export async function onUnauthorized(creds: CodexCreds) {
  if (creds.source === "codex-cli") await nudgeCli();
  else { const own = readJson(OWN_FILE); if (own) { refreshing ??= refreshOwn(own).finally(() => { refreshing = null; }); await refreshing; } }
}

// ---------- Login device-code (propre à Novabot) ----------
export interface DeviceLogin { url: string; userCode: string; done: Promise<void>; status: () => "pending" | "ok" | "error"; error: () => string | null }

export async function startDeviceLogin(): Promise<DeviceLogin> {
  const r = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: CODEX_CLIENT_ID }) });
  if (!r.ok) throw new Error(`demande de code device refusée : HTTP ${r.status}`);
  const d: any = await r.json();
  const interval = Math.max(3, Number(d.interval ?? 5)) * 1000;
  let st: "pending" | "ok" | "error" = "pending"; let err: string | null = null;
  const done = (async () => {
    const start = Date.now();
    while (Date.now() - start < 15 * 60_000) {
      await Bun.sleep(interval);
      const p = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_auth_id: d.device_auth_id, user_code: d.user_code }) }).catch(() => null);
      if (!p) continue;
      if (p.status === 403 || p.status === 404) continue;
      if (!p.ok) throw new Error(`polling device : HTTP ${p.status}`);
      const code: any = await p.json();
      const tr = await fetch(TOKEN_URL, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: code.authorization_code, redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: code.code_verifier }),
      });
      if (!tr.ok) throw new Error(`échange du code : HTTP ${tr.status}`);
      const tok: any = await tr.json();
      writeOwn({ access_token: tok.access_token, refresh_token: tok.refresh_token, id_token: tok.id_token, account_id: accountOf(tok.access_token), last_refresh: new Date().toISOString() });
      return;
    }
    throw new Error("login expiré (15 min)");
  })().then(() => { st = "ok"; }, (e) => { st = "error"; err = String(e?.message ?? e); });
  return { url: `${ISSUER}/codex/device`, userCode: d.user_code, done, status: () => st, error: () => err };
}
