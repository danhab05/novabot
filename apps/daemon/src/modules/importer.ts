// Migration optionnelle depuis OpenBot : fiches projets + passations, en lecture seule, une seule fois.
// Chemins : NOVABOT_IMPORT_OPENBOT_SETUP (fichiers markdown « openbot-setup », séparés par virgules)
// et NOVABOT_IMPORT_OPENBOT_HANDOFFS (dossiers de passations <projet>.md). Ignoré silencieusement si absent.
// Idempotent : un projet déjà en base n'est jamais recréé ni modifié ; une passation existante n'est jamais écrasée.
// Relançable : POST /api/admin/import.
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Module, Ctx } from "../core/context.ts";
import { insert } from "../core/db.ts";
import { id, now } from "@novabot/shared";
import type { Autonomy } from "@novabot/shared";


interface Draft { id: string; name: string; folder: string; path: string | null; stack: string | null; lines: string[]; autonomy: Autonomy }

export function parseSetup(md: string): Draft[] {
  const out: Draft[] = [];
  let folder = "Divers"; let cur: Draft | null = null;
  for (const line of md.split("\n")) {
    const f = line.match(/^### Dossier « (.+) »/);
    if (f) { folder = f[1]; cur = null; continue; }
    const a = line.match(/^#### Agent `([a-z0-9-]+)`/);
    if (a) { cur = { id: a[1], name: a[1], folder, path: null, stack: null, lines: [], autonomy: "full" }; out.push(cur); continue; }
    if (!cur) continue;
    const kv = line.match(/^- (\w[\w ]*?) : (.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "Projet") cur.name = v.trim();
    else if (k === "Dossier") cur.path = v.trim();
    else if (k === "stack") cur.stack = v.trim();
    else cur.lines.push(`${k} : ${v.trim()}`);
  }
  return out;
}

export function parseSetup2(md: string): Draft[] {
  const out: Draft[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\| ([a-z0-9-]+) \| ([^|]+) \| (\/[^|(]+?)\s*(\([^)]*\))? \| ([^|]+) \|$/);
    if (!m || m[1] === "Agent") continue;
    out.push({ id: m[1], name: m[1], folder: m[2].trim(), path: m[3].trim(), stack: null, lines: m[4] ? [`note : ${m[4]}`] : [], autonomy: "full" });
  }
  return out;
}

export function runImport(ctx: Ctx) {
  const { db } = ctx;
  const setups = ctx.config.import?.openbotSetup ?? [];
  const HANDOFF_DIRS = ctx.config.import?.openbotHandoffs ?? [];
  // les deux formats de fiche sont essayés sur chaque fichier (sections « #### Agent » ou tableau)
  const drafts = setups.filter((f) => existsSync(f)).flatMap((f) => { const md = readFileSync(f, "utf8"); return [...parseSetup(md), ...parseSetup2(md)]; });
  const folderIds = new Map<string, string>();
  for (const r of db.query("SELECT id, name FROM folders").all() as any[]) folderIds.set(r.name, r.id);
  const handoffDir = join(ctx.config.dataDir, "handoffs");
  mkdirSync(handoffDir, { recursive: true });

  let created = 0;
  for (const d of drafts) {
    if (db.query("SELECT 1 FROM projects WHERE id = ?").get(d.id)) continue;
    if (!folderIds.has(d.folder)) {
      const fid = id("f_");
      insert(db, "folders", { id: fid, name: d.folder, position: folderIds.size });
      folderIds.set(d.folder, fid);
    }
    insert(db, "projects", { id: d.id, name: d.name, folderId: folderIds.get(d.folder)!, path: d.path, stack: d.stack, notes: d.lines.join("\n"), discordChannelId: null, autonomy: d.autonomy, defaultAgent: null, createdAt: now() });
    created++;
    // passation : copiée une fois dans ~/.novabot/handoffs/<id>.md (Novabot la tient à jour ensuite)
    const dst = join(handoffDir, `${d.id}.md`);
    if (!existsSync(dst)) for (const dir of HANDOFF_DIRS) { const src = join(dir, `${d.id}.md`); if (existsSync(src)) { copyFileSync(src, dst); break; } }
  }
  // passations orphelines (projet sans fiche OpenBot) -> projet minimal dans « Divers »
  for (const dir of HANDOFF_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const pid = f.replace(/\.md$/, "");
      if (!f.endsWith(".md") || !/^[a-z0-9-]+$/.test(pid)) continue;
      const dst = join(handoffDir, f);
      if (!existsSync(dst)) copyFileSync(join(dir, f), dst);
    }
  }
  ctx.db.query("INSERT INTO settings (key, value) VALUES ('import.openbot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now()));
  ctx.log("importer", `${created} projets importés`);
  return { created, total: drafts.length };
}

const mod: Module & { publicRoutes?: unknown } = {
  name: "importer",
  init(ctx) {
    const done = ctx.db.query("SELECT value FROM settings WHERE key = 'import.openbot'").get();
    const configured = (ctx.config.import?.openbotSetup ?? []).some((f) => existsSync(f));
    if (!done && configured) runImport(ctx);
  },
  routes(app, ctx) {
    app.post("/api/admin/import", (c) => c.get("user").role === "admin" ? c.json(runImport(ctx)) : c.json({ error: "forbidden" }, 403));
  },
};
export default mod;
