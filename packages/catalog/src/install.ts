// Installation / désinstallation symétrique. Règle : ne jamais effacer ce que Novabot n'a pas installé.
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readlinkSync, copyFileSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { CatalogManifest } from "@novabot/shared";
import type { Paths, Runner } from "./paths.ts";
import { skillDirName, isSymlink } from "./sources.ts";

export const WRAPPER = new URL("../bin/with-secrets.sh", import.meta.url).pathname;

export interface SkillInstall { kind: "skill"; dir: string; codexLink: string | null }
export interface McpInstall { kind: "mcp"; name: string; builtin: string | null; claudeAdded: boolean; codexAdded: boolean; secretsAdded: string[] }
export interface AgentInstall { kind: "agent"; projectId: string; createdProject: boolean; marker: string }
export type InstallDetail = SkillInstall | McpInstall | AgentInstall;

// ---------------- skills ----------------
export function installSkill(paths: Paths, m: CatalogManifest, opts: { force?: boolean } = {}): SkillInstall {
  if (m.type !== "skill" || !m.skill) throw new Error("pas un skill");
  const name = skillDirName(m);
  const dir = join(paths.claudeSkills, name);
  if (existsSync(dir) && !opts.force) throw new Error(`un skill « ${name} » existe déjà dans ${paths.claudeSkills} (non écrasé)`);
  for (const [rel, content] of Object.entries(m.skill.files)) {
    const p = resolve(dir, rel);
    if (!p.startsWith(dir + "/")) throw new Error(`chemin interdit : ${rel}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  // Codex : ~/.codex/skills/<nom> -> ~/.claude/skills/<nom> (une seule source, comme chef-orchestre)
  let codexLink: string | null = null;
  const link = join(paths.codexSkills, name);
  if (existsSync(paths.codexSkills) || existsSync(dirname(paths.codexSkills))) {
    mkdirSync(paths.codexSkills, { recursive: true });
    if (!existsSync(link) && !isSymlink(link)) { symlinkSync(dir, link); codexLink = link; }
  }
  return { kind: "skill", dir, codexLink };
}

export function uninstallSkill(paths: Paths, d: SkillInstall) {
  const root = resolve(paths.claudeSkills);
  if (!resolve(d.dir).startsWith(root + "/")) throw new Error("dossier hors de ~/.claude/skills : refus");
  if (d.codexLink && isSymlink(d.codexLink) && readlinkSync(d.codexLink) === d.dir) unlinkSync(d.codexLink);
  if (existsSync(d.dir)) rmSync(d.dir, { recursive: true, force: true });
}

// ---------------- secrets ----------------
export function readSecretKeys(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean) as string[]);
}

/** Ajoute des secrets (jamais d'écrasement). Retourne les clés ajoutées. */
export function appendSecrets(file: string, values: Record<string, string>): string[] {
  const existing = readSecretKeys(file);
  const added: string[] = [];
  let out = "";
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(k)) throw new Error(`clé de secret invalide : ${k}`);
    if (typeof v !== "string" || !v || /[\n\r]/.test(v)) throw new Error(`valeur invalide pour ${k}`);
    if (existing.has(k)) continue;
    out += `${k}=${/^[A-Za-z0-9._\-\/+=:@]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`}\n`;
    added.push(k);
  }
  if (out) {
    mkdirSync(dirname(file), { recursive: true });
    const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, (prev && !prev.endsWith("\n") ? prev + "\n" : prev) + out, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return added;
}

// ---------------- MCP ----------------
function claudeHasMcp(paths: Paths, name: string): boolean {
  const f = join(paths.home, ".claude.json");
  if (!existsSync(f)) return false;
  try { return !!JSON.parse(readFileSync(f, "utf8")).mcpServers?.[name]; } catch { return false; }
}
function codexHasMcp(paths: Paths, name: string): boolean {
  if (!existsSync(paths.codexConfig)) return false;
  return new RegExp(`^\\[mcp_servers\\.${name.replace(/[.-]/g, "\\$&")}\\]`, "m").test(readFileSync(paths.codexConfig, "utf8"));
}
export function mcpName(m: CatalogManifest) { return m.id.replace(/^mcp-/, ""); }
export function isMcpInstalled(paths: Paths, m: CatalogManifest) {
  if (m.mcp && (m.mcp as any).builtin) return false; // géré par l'état des intégrations
  const n = mcpName(m);
  return claudeHasMcp(paths, n) || codexHasMcp(paths, n);
}

function backup(file: string) {
  if (!existsSync(file)) return;
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  copyFileSync(file, `${file}.bak-novabot-${ts}`);
}

const tomlStr = (s: string) => JSON.stringify(s);
const BEGIN = (n: string) => `# novabot:begin ${n}`;
const END = (n: string) => `# novabot:end ${n}`;

export async function installMcp(paths: Paths, run: Runner, m: CatalogManifest, secrets: Record<string, string> = {}): Promise<McpInstall> {
  if (m.type !== "mcp" || !m.mcp) throw new Error("pas un connecteur MCP");
  const name = mcpName(m);
  const missing = (m.secrets ?? []).map((s) => s.key).filter((k) => !secrets[k] && !readSecretKeys(paths.secretsFile).has(k));
  if (missing.length) throw new Error(`secrets requis manquants : ${missing.join(", ")}`);
  const secretsAdded = appendSecrets(paths.secretsFile, Object.fromEntries(Object.entries(secrets).filter(([k]) => (m.secrets ?? []).some((s) => s.key === k))));
  const builtin = (m.mcp as any).builtin ?? null;
  if (builtin) return { kind: "mcp", name, builtin, claudeAdded: false, codexAdded: false, secretsAdded };

  const env = m.mcp.env ?? {};
  const useWrapper = (m.secrets ?? []).length > 0;
  const cmd = m.mcp.url ? null : useWrapper ? ["bash", WRAPPER, m.mcp.command, ...(m.mcp.args ?? [])] : [m.mcp.command, ...(m.mcp.args ?? [])];

  let claudeAdded = false;
  if (!claudeHasMcp(paths, name)) {
    const args = m.mcp.url
      ? ["claude", "mcp", "add", "--scope", "user", "--transport", "http", name, m.mcp.url]
      : ["claude", "mcp", "add", "--scope", "user", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), name, "--", ...cmd!];
    const r = await run(args);
    if (r.code !== 0) throw new Error(`claude mcp add a échoué : ${(r.stderr || r.stdout).slice(0, 300)}`);
    claudeAdded = true;
  }
  let codexAdded = false;
  if (!codexHasMcp(paths, name)) {
    backup(paths.codexConfig);
    const lines = [BEGIN(name), `[mcp_servers.${name}]`];
    if (m.mcp.url) lines.push(`url = ${tomlStr(m.mcp.url)}`);
    else { lines.push(`command = ${tomlStr(cmd![0])}`, `args = [${cmd!.slice(1).map(tomlStr).join(", ")}]`); }
    if (Object.keys(env).length) lines.push(`env = { ${Object.entries(env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(", ")} }`);
    lines.push(END(name));
    const prev = existsSync(paths.codexConfig) ? readFileSync(paths.codexConfig, "utf8") : "";
    mkdirSync(dirname(paths.codexConfig), { recursive: true });
    // ajouté en fin de fichier entre marqueurs : un en-tête [table] ferme la table précédente, donc rien n est hérité
    writeFileSync(paths.codexConfig, prev.trimEnd() + "\n\n" + lines.join("\n") + "\n");
    codexAdded = true;
  }
  return { kind: "mcp", name, builtin: null, claudeAdded, codexAdded, secretsAdded };
}

export async function uninstallMcp(paths: Paths, run: Runner, d: McpInstall) {
  if (d.claudeAdded) {
    const r = await run(["claude", "mcp", "remove", "--scope", "user", d.name]);
    if (r.code !== 0 && !/not found|No MCP server/i.test(r.stderr + r.stdout)) throw new Error(`claude mcp remove : ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  if (d.codexAdded && existsSync(paths.codexConfig)) {
    const s = readFileSync(paths.codexConfig, "utf8");
    const re = new RegExp(`\\n*${BEGIN(d.name).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[\\s\\S]*?${END(d.name).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\n?`);
    if (re.test(s)) { backup(paths.codexConfig); writeFileSync(paths.codexConfig, s.replace(re, "\n")); }
  }
  // les secrets ajoutés restent (suppression de secret = action réservée au propriétaire)
}
