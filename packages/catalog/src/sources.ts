// Lecture des sources du catalogue : skills (Claude, Hermes, OpenBot) et registre de manifestes.
import { readdirSync, readFileSync, statSync, existsSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import type { CatalogManifest, CatalogItem } from "@novabot/shared";
import { validateManifest } from "./manifest.ts";
import type { Paths } from "./paths.ts";

const MAX_FILE = 100 * 1024;
const MAX_TOTAL = 480 * 1024;

export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Lit les fichiers texte d'un dossier de skill (sans binaires, sans fichiers cachés, bornés en taille). */
export function readSkillFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
      const p = join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      const rel = relative(dir, p);
      if (!/^[A-Za-z0-9._\/-]+$/.test(rel) || st.size > MAX_FILE || total + st.size > MAX_TOTAL || Object.keys(files).length >= 50) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue; // binaire
      files[rel] = buf.toString("utf8");
      total += st.size;
    }
  };
  walk(dir, 0);
  return files;
}

export function skillToManifest(dir: string, prefix: string, author: string): CatalogManifest | null {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  const md = readFileSync(skillMd, "utf8");
  const fm = parseFrontmatter(md);
  const base = (fm.name || dir.split("/").pop() || "skill").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 50);
  try {
    return validateManifest({
      id: `${prefix}${base}`, type: "skill", name: fm.name || base, version: /^\d+\.\d+\.\d+/.test(fm.version ?? "") ? fm.version : "1.0.0",
      description: (fm.description || "Skill sans description").slice(0, 2000), author,
      skill: { files: readSkillFiles(dir) },
    });
  } catch { return null; }
}

/** Dossiers de skills directs (dir/<nom>/SKILL.md) ou récursifs (Hermes : dir/<catégorie>/<nom>/SKILL.md). */
export function findSkillDirs(root: string, recursive: boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue; // .archive, .system…
      const p = join(d, n);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      if (existsSync(join(p, "SKILL.md"))) out.push(p);
      else if (recursive && depth < 3) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export interface ScannedItem { manifest: CatalogManifest; source: CatalogItem["source"]; installed: boolean; localPath?: string }

export function scanSources(paths: Paths, isMcpInstalled: (id: string, m: CatalogManifest) => boolean): ScannedItem[] {
  const items: ScannedItem[] = [];
  const seen = new Set<string>();
  const push = (it: ScannedItem) => { if (!seen.has(it.manifest.id)) { seen.add(it.manifest.id); items.push(it); } };

  // 1) skills installés côté Claude (source « local »)
  for (const d of findSkillDirs(paths.claudeSkills, false)) {
    const m = skillToManifest(d, "skill-", "local");
    if (m) push({ manifest: m, source: "local", installed: true, localPath: d });
  }
  const installedNames = new Set(findSkillDirs(paths.claudeSkills, false).map((d) => d.split("/").pop()!));
  // 2) Hermes (importables)
  for (const d of findSkillDirs(paths.hermesSkills, true)) {
    const m = skillToManifest(d, "hermes-", "Hermes");
    if (m) push({ manifest: m, source: "hermes", installed: installedNames.has(skillDirName(m)), localPath: d });
  }
  // 3) OpenBot
  for (const d of paths.openbotSkills ? findSkillDirs(paths.openbotSkills, false) : []) {
    const m = skillToManifest(d, "openbot-", "OpenBot");
    if (m) push({ manifest: m, source: "openbot", installed: installedNames.has(skillDirName(m)), localPath: d });
  }
  // 3b) dossiers supplémentaires (NOVABOT_SKILL_DIRS)
  for (const root of paths.extraSkills ?? []) for (const d of findSkillDirs(root, true)) {
    const m = skillToManifest(d, "skill-", "local");
    if (m) push({ manifest: m, source: "local", installed: installedNames.has(skillDirName(m)), localPath: d });
  }
  // 4) registre Novabot (MCP + agents)
  for (const sub of ["", "agents"]) {
    const dir = join(paths.registryDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = validateManifest(JSON.parse(readFileSync(join(dir, f), "utf8")));
        push({ manifest: m, source: "local", installed: m.type === "mcp" ? isMcpInstalled(m.id, m) : false });
      } catch (e) { console.error(`[catalog] manifeste invalide ${f}:`, (e as Error).message); }
    }
  }
  return items;
}

/** Nom du dossier d'installation d'un skill : id sans préfixe de source. */
export function skillDirName(m: CatalogManifest): string {
  return m.id.replace(/^(skill|hermes|openbot|pub)-/, "");
}

export function isSymlink(p: string) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
