// Surveillance (tout vient de la config et des fiches projets, rien n'est codé en dur) :
// - Coolify (optionnel, COOLIFY_URL + jeton) : HTTP du domaine principal + dernier déploiement de chaque app ;
// - URL supplémentaires (NOVABOT_HEALTH_URLS) et lignes « url: … » des fiches projets ;
// - services systemd/docker cités dans les fiches projets (ligne « services: a, b »).
import type { HealthCheck } from "@novabot/shared";

export interface Target { kind: HealthCheck["kind"]; target: string; projectId: string | null; probe: () => Promise<ProbeResult> }
export interface ProbeResult { status: "ok" | "warn" | "down"; detail: string | null }

export interface CoolifyOpts {
  url: string; token: string | null;
  /** app Coolify -> projet Novabot quand le nom diffère (NOVABOT_COOLIFY_APP_MAP) */
  appProjectMap?: Record<string, string>;
  /** suffixe des domaines de test à ignorer pour le check HTTP (COOLIFY_IGNORE_DOMAIN_SUFFIX) */
  ignoreDomainSuffix?: string;
}

export async function httpProbe(url: string, timeoutMs = 12_000): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "NovabotHealth/0.1" } });
    try { await r.body?.cancel(); } catch {}
    const ms = Date.now() - t0;
    if (r.status >= 500) return { status: "down", detail: `HTTP ${r.status} (${ms} ms)` };
    if (r.status >= 400) return { status: "warn", detail: `HTTP ${r.status} (${ms} ms)` };
    return { status: ms > 6000 ? "warn" : "ok", detail: `HTTP ${r.status} (${ms} ms)` };
  } catch (e: any) {
    return { status: "down", detail: e?.name === "TimeoutError" ? `timeout ${timeoutMs} ms` : String(e?.message ?? e).slice(0, 200) };
  }
}

async function sh(cmd: string[], timeoutMs = 8000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const out = await new Response(p.stdout).text();
  const code = await p.exited; clearTimeout(timer);
  return { code, out: out.trim() };
}

export async function serviceProbe(name: string): Promise<ProbeResult | null> {
  const a = await sh(["systemctl", "is-active", `${name}.service`]);
  if (a.out === "active") return { status: "ok", detail: "systemd active" };
  const exists = await sh(["systemctl", "list-unit-files", "--no-legend", `${name}.service`]);
  if (exists.out) return { status: "down", detail: `systemd ${a.out || "inactive"}` };
  const d = await sh(["docker", "inspect", "-f", "{{.State.Status}}", name]);
  if (d.code === 0) return d.out === "running" ? { status: "ok", detail: "docker running" } : { status: "down", detail: `docker ${d.out}` };
  return null; // ni unité ni conteneur : on ne surveille pas
}

/** Construit la liste des cibles. projects = fiches projets (id, notes). */
export async function buildTargets(opts: { coolify?: CoolifyOpts | null; projects: { id: string; notes: string | null }[]; extraUrls?: string[] }): Promise<Target[]> {
  const out: Target[] = [];
  const known = new Set(opts.projects.map((p) => p.id));
  const proj = (appName: string) => {
    const cand = opts.coolify?.appProjectMap?.[appName] ?? appName;
    if (known.has(cand)) return cand;
    if (known.has(cand.replace(/-/g, ""))) return cand.replace(/-/g, "");
    return known.has("infra") ? "infra" : null;
  };
  const cf = opts.coolify;
  const token = cf?.url ? cf.token : null;
  const seen = new Set<string>();
  if (cf && token) {
    const H = { authorization: `Bearer ${token}` };
    try {
      const apps = (await (await fetch(`${cf.url}/api/v1/applications`, { headers: H, signal: AbortSignal.timeout(15_000) })).json()) as any[];
      for (const a of apps) {
        const domains = String(a.fqdn ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        // domaine principal : le premier hors domaines de test, sinon le premier
        const sfx = cf.ignoreDomainSuffix;
        const main = (sfx ? domains.find((d) => !d.includes(sfx)) : undefined) ?? domains[0];
        const pid = proj(a.name);
        if (main && !seen.has(main)) { seen.add(main); out.push({ kind: "http", target: main, projectId: pid, probe: () => httpProbe(main) }); }
        out.push({
          kind: "coolify", target: `coolify:${a.name}`, projectId: pid,
          probe: async () => {
            try {
              const d = (await (await fetch(`${cf.url}/api/v1/deployments/applications/${a.uuid}?take=1`, { headers: H, signal: AbortSignal.timeout(15_000) })).json()) as any;
              const last = d.deployments?.[0];
              if (!last) return { status: "ok", detail: "aucun déploiement" };
              const st = String(last.status);
              const info = `${st} ${String(last.commit ?? "").slice(0, 7)} ${last.updated_at ?? ""}`.trim();
              if (st === "failed") return { status: "down", detail: `dernier déploiement échoué (${info})` };
              if (st === "finished") return { status: "ok", detail: info };
              return { status: "ok", detail: info }; // queued / in_progress
            } catch (e: any) { return { status: "warn", detail: `API Coolify : ${String(e?.message ?? e).slice(0, 120)}` }; }
          },
        });
      }
    } catch { /* API Coolify injoignable : on garde les autres cibles */ }
  }
  for (const u of opts.extraUrls ?? []) if (!seen.has(u)) { seen.add(u); out.push({ kind: "http", target: u, projectId: known.has("infra") ? "infra" : null, probe: () => httpProbe(u) }); }
  // URL et services cités dans les fiches projets
  for (const p of opts.projects) {
    for (const line of (p.notes ?? "").split("\n")) {
      const u = line.match(/^(?:url|health)\s*:\s*(https?:\/\/\S+)\s*$/i);
      if (u && !seen.has(u[1])) { const url = u[1]; seen.add(url); out.push({ kind: "http", target: url, projectId: p.id, probe: () => httpProbe(url) }); }
      const s = line.match(/^services\s*:\s*(.+)$/i);
      if (s) for (const name of s[1].split(",").map((x) => x.trim()).filter((x) => /^[\w@.-]+$/.test(x))) {
        out.push({ kind: "service", target: `service:${name}`, projectId: p.id, probe: async () => (await serviceProbe(name)) ?? { status: "ok", detail: "non surveillé (introuvable)" } });
      }
    }
  }
  return out;
}

// ---- machine à états (pure, testée) ----
export interface CheckState { status: HealthCheck["status"]; fails: number }
/** 2 échecs consécutifs avant de passer down ; un succès remet à ok. */
export function evaluate(prev: CheckState | undefined, r: ProbeResult): { next: CheckState; transition: "down" | "up" | null } {
  const was = prev?.status ?? "ok";
  if (r.status === "down") {
    const fails = (prev?.fails ?? 0) + 1;
    const status = fails >= 2 ? "down" : was === "down" ? "down" : "warn";
    return { next: { status, fails }, transition: status === "down" && was !== "down" ? "down" : null };
  }
  return { next: { status: r.status, fails: 0 }, transition: was === "down" ? "up" : null };
}

/** Anti-boucle auto-fix : pas de tâche ouverte pour cette cible et la dernière date de plus d'une heure. */
export function canAutofix(last: { createdAt: number; taskStatus: string | null } | null, now = Date.now()): boolean {
  if (!last) return true;
  if (last.taskStatus && !["done", "failed", "cancelled"].includes(last.taskStatus)) return false;
  return now - last.createdAt >= 3600_000;
}
