// Module « memory » : mémoire persistante (FTS5) + journal + contexte injecté + passations.
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Module, Ctx, MemoryService } from "@novabot/daemon/core";
import { fromRow, insert, update, canAccessProject } from "@novabot/daemon/core";
import type { Memory, MemoryKind, MemoryScope, Project, MemoryJournalEntry } from "@novabot/shared";
import { id, now } from "@novabot/shared";
import { HOME, clip } from "./util.ts";

const KINDS: MemoryKind[] = ["fact", "decision", "preference", "pitfall"];

export function soulPath(dataDir: string) { return join(dataDir, "SOUL.md"); }
export function handoffPath(dataDir: string, projectId: string) { return join(dataDir, "handoffs", `${projectId.replace(/[^a-z0-9-]/gi, "")}.md`); }

/** Dossier Hermes Agent pour la migration optionnelle (NOVABOT_IMPORT_HERMES_DIR, ex-NOVABOT_HERMES_DIR). */
export const hermesDir = () => process.env.NOVABOT_IMPORT_HERMES_DIR ?? process.env.NOVABOT_HERMES_DIR ?? join(HOME, ".hermes");

/** Crée SOUL.md au 1er démarrage : copie celui de Hermes s'il existe (identité Hermes remplacée par Novabot), sinon un défaut. */
export function ensureSoul(dataDir: string, hermesSoul = join(hermesDir(), "SOUL.md"), owner = process.env.NOVABOT_OWNER_NAME || "Owner") {
  const dst = soulPath(dataDir);
  if (existsSync(dst)) return;
  mkdirSync(dataDir, { recursive: true });
  let s = existsSync(hermesSoul) ? readFileSync(hermesSoul, "utf8") : `Tu es Novabot, l'assistant personnel de ${owner}. Tutoie-le, sois direct.`;
  s = s.replace(/You are Hermes Agent, built by Nous Research\./g, `You are Novabot, ${owner}'s personal harness and assistant.`).replace(/Hermes Agent/g, "Novabot");
  writeFileSync(dst, s);
}

/** Découpe une mémoire Hermes : entrées séparées par « § » (MEMORY/USER) ou sections « ## » (project-memory). */
export function splitHermesMemory(text: string): string[] {
  const parts = text.includes("\n§") || text.trim().startsWith("§") ? text.split(/^\s*§\s*$/m) : text.split(/^(?=## )/m);
  return parts.map((p) => p.trim()).filter((p) => p.length > 20).map((p) => p.slice(0, 4000));
}

export function createMemoryService(ctx: Ctx): MemoryService & {
  get(id: string): Memory | null; patch(id: string, p: { content?: string; pinned?: boolean }, actor: string): Memory; remove(id: string, actor: string): void;
} {
  const { db } = ctx;
  const journal = (memoryId: string, action: MemoryJournalEntry["action"], before: string | null, after: string | null, actor: string) =>
    insert(db, "memory_journal", { id: id("j_"), memoryId, action, before, after, actor, createdAt: now() });
  const get = (mid: string) => fromRow<Memory>(db.query("SELECT * FROM memories WHERE id = ? AND deleted = 0").get(mid)) ?? null;

  return {
    get,
    search(q, opts = {}) {
      const limit = opts.limit ?? 20;
      const pid = opts.projectId;
      const scopeSql = pid === undefined ? "" : pid === null ? " AND m.scope = 'global'" : " AND (m.scope = 'global' OR m.project_id = $pid)";
      const terms = q.normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 12);
      const args: any = { limit, ...(pid ? { pid } : {}) };
      let rows: any[];
      if (terms.length) {
        args.q = terms.map((t) => `"${t}"*`).join(" OR ");
        rows = db.query(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH $q AND m.deleted = 0${scopeSql} ORDER BY m.pinned DESC, bm25(memories_fts) LIMIT $limit`).all(args) as any[];
      } else {
        rows = db.query(`SELECT m.* FROM memories m WHERE m.deleted = 0${scopeSql} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT $limit`).all(args) as any[];
      }
      return rows.map((r) => fromRow<Memory>(r));
    },
    write(m, actor) {
      const content = m.content.trim();
      const pid = m.scope === "project" ? m.projectId ?? null : null;
      const dup = db.query("SELECT * FROM memories WHERE deleted = 0 AND lower(content) = lower(?) AND coalesce(project_id,'') = coalesce(?,'')").get(content, pid);
      if (dup) return fromRow<Memory>(dup);
      const mem: Memory = { id: id("mem_"), scope: pid ? "project" : "global", projectId: pid, kind: KINDS.includes(m.kind) ? m.kind : "fact", content, sourceMessageId: m.sourceMessageId ?? null, pinned: false, createdAt: now(), updatedAt: now() };
      insert(db, "memories", mem as any);
      journal(mem.id, "create", null, content, actor);
      ctx.bus.emit({ type: "memory", memory: mem, action: "create" });
      return mem;
    },
    patch(mid, p, actor) {
      const before = get(mid); if (!before) throw new Error("mémoire introuvable");
      const patch: any = { updatedAt: now() };
      if (p.content !== undefined) patch.content = p.content.trim();
      if (p.pinned !== undefined) patch.pinned = p.pinned;
      update(db, "memories", "id", mid, patch);
      const after = get(mid)!;
      const action = p.content !== undefined ? "update" : p.pinned ? "pin" : "unpin";
      journal(mid, action, before.content, after.content, actor);
      ctx.bus.emit({ type: "memory", memory: after, action });
      return after;
    },
    remove(mid, actor) {
      const before = get(mid); if (!before) return;
      update(db, "memories", "id", mid, { deleted: true, updatedAt: now() });
      journal(mid, "delete", before.content, null, actor);
      ctx.bus.emit({ type: "memory", memory: before, action: "delete" });
    },
    contextFor(projectId) {
      const dataDir = ctx.config.dataDir;
      const parts: string[] = [];
      const soul = soulPath(dataDir);
      if (existsSync(soul)) parts.push(`# Personnalité (SOUL.md)\n${clip(readFileSync(soul, "utf8"), 9000)}`);
      const rules = ctx.config.globalRulesFile;
      if (rules && existsSync(rules)) parts.push(`# Règles globales de ${ctx.config.ownerName} (${rules})\n${clip(readFileSync(rules, "utf8"), 9000)}`);
      const fmt = (ms: Memory[]) => ms.map((m) => `- [${m.kind}${m.pinned ? ", épinglé" : ""}] ${clip(m.content, 600)}`).join("\n");
      const global = (db.query("SELECT * FROM memories WHERE deleted = 0 AND scope = 'global' ORDER BY pinned DESC, updated_at DESC LIMIT 40").all() as any[]).map((r) => fromRow<Memory>(r));
      if (global.length) parts.push(`# Mémoire globale (épinglée puis récente)\n${fmt(global)}`);
      if (projectId) {
        const p = fromRow<Project>(db.query("SELECT * FROM projects WHERE id = ?").get(projectId));
        if (p) parts.push(`# Projet courant : ${p.name} (id ${p.id})\n- Dossier : ${p.path ?? "?"}\n- Stack : ${p.stack ?? "?"}\n- Autonomie : ${p.autonomy}\n${p.notes ?? ""}`);
        const pm = (db.query("SELECT * FROM memories WHERE deleted = 0 AND project_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 30").all(projectId) as any[]).map((r) => fromRow<Memory>(r));
        if (pm.length) parts.push(`# Mémoire du projet\n${fmt(pm)}`);
        const h = handoffPath(dataDir, projectId);
        if (existsSync(h)) parts.push(`# Passation du projet (${h})\n${clip(readFileSync(h, "utf8"), 8000)}`);
      }
      return parts.join("\n\n");
    },
  };
}

/** Import unique des mémoires Hermes (setting import.hermes.memory). */
export function importHermesMemory(ctx: Ctx, svc: MemoryService, dir = hermesDir()) {
  if (ctx.db.query("SELECT 1 FROM settings WHERE key = 'import.hermes.memory'").get()) return 0;
  if (!existsSync(dir)) return 0; // pas de Hermes : ignoré silencieusement (sera tenté au prochain démarrage)
  let n = 0;
  const projects = new Set((ctx.db.query("SELECT id FROM projects").all() as any[]).map((r) => r.id));
  for (const f of ["MEMORY.md", "USER.md"]) {
    const p = join(dir, "memories", f);
    if (!existsSync(p)) continue;
    for (const c of splitHermesMemory(readFileSync(p, "utf8"))) { svc.write({ scope: "global", kind: f === "USER.md" ? "preference" : "fact", content: c }, "import:hermes"); n++; }
  }
  const pmDir = join(dir, "project-memory");
  if (existsSync(pmDir)) for (const f of readdirSync(pmDir)) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const scope: MemoryScope = name !== "_global" && projects.has(name) ? "project" : "global";
    const prefix = scope === "global" && name !== "_global" ? `[${name}] ` : "";
    for (const c of splitHermesMemory(readFileSync(join(pmDir, f), "utf8"))) { svc.write({ scope, projectId: scope === "project" ? name : null, kind: "fact", content: prefix + c }, "import:hermes"); n++; }
  }
  ctx.db.query("INSERT INTO settings (key, value) VALUES ('import.hermes.memory', ?)").run(String(now()));
  ctx.log("memory", `${n} mémoires importées depuis Hermes`);
  return n;
}

const mod: Module = {
  name: "memory",
  init(ctx) {
    ensureSoul(ctx.config.dataDir, undefined, ctx.config.ownerName);
    const svc = createMemoryService(ctx);
    ctx.services.memory = svc;
    (ctx.services as any).memoryAdmin = svc;
    try { importHermesMemory(ctx, svc); } catch (e) { ctx.log("memory", "import Hermes échoué", e); }

    ctx.tools.register({
      name: "memory_search", description: "Cherche dans la mémoire de Novabot (faits, décisions, préférences, pièges). Global + projet courant.",
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, projectId: { type: "string" }, limit: { type: "integer" } } },
      async run(i: { query: string; projectId?: string; limit?: number }, tc) {
        return svc.search(i.query, { projectId: i.projectId ?? tc.projectId ?? undefined, limit: i.limit ?? 15 }).map((m) => ({ id: m.id, kind: m.kind, scope: m.scope, projectId: m.projectId, content: m.content }));
      },
    });
    ctx.tools.register({
      name: "memory_write", description: "Retient un fait/décision/préférence/piège durable (pas de secrets). scope project = lié au projet courant.",
      inputSchema: { type: "object", required: ["content", "kind"], properties: { content: { type: "string" }, kind: { type: "string", enum: KINDS }, scope: { type: "string", enum: ["global", "project"] }, projectId: { type: "string" } } },
      async run(i: { content: string; kind: MemoryKind; scope?: MemoryScope; projectId?: string }, tc) {
        const pid = i.projectId ?? tc.projectId;
        const m = svc.write({ scope: i.scope ?? (pid ? "project" : "global"), projectId: pid, kind: i.kind, content: i.content }, tc.caller === "mcp" ? "agent" : "brain");
        return { id: m.id };
      },
    });
    ctx.tools.register({
      name: "handoff_read", description: "Lit la passation (handoff.md) d'un projet : contexte, état, décisions, pièges, prochaines étapes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
      async run(i: { projectId?: string }, tc) {
        const pid = i.projectId ?? tc.projectId; if (!pid) throw new Error("projectId requis");
        const h = handoffPath(ctx.config.dataDir, pid);
        return existsSync(h) ? readFileSync(h, "utf8") : "(pas encore de passation pour ce projet)";
      },
    });
    ctx.tools.register({
      name: "handoff_write", description: "Réécrit la passation complète d'un projet (markdown : Contexte, Fait dans cette session, État actuel, Décisions et préférences du propriétaire, Prochaines étapes, Pièges connus). À faire en fin de tâche.",
      inputSchema: { type: "object", required: ["content"], properties: { projectId: { type: "string" }, content: { type: "string" } } },
      async run(i: { projectId?: string; content: string }, tc) {
        const pid = i.projectId ?? tc.projectId; if (!pid) throw new Error("projectId requis");
        const h = handoffPath(ctx.config.dataDir, pid);
        mkdirSync(join(ctx.config.dataDir, "handoffs"), { recursive: true });
        if (existsSync(h)) copyFileSync(h, h + ".prev");
        writeFileSync(h, i.content);
        return { ok: true, path: h };
      },
    });
  },
  routes(app, ctx) {
    const svc = (ctx.services as any).memoryAdmin as ReturnType<typeof createMemoryService>;
    const db = ctx.db;
    app.get("/api/memories", (c) => {
      const user = c.get("user");
      const projectId = c.req.query("projectId");
      if (projectId ? !canAccessProject(db, user, projectId) : user.role !== "admin") return c.json({ error: "forbidden" }, 403);
      const kind = c.req.query("kind");
      let list = svc.search(c.req.query("q") ?? "", { projectId: projectId ?? undefined, limit: Number(c.req.query("limit") ?? 100) });
      if (projectId) list = list.filter((m) => m.projectId === projectId || (user.role === "admin" && m.scope === "global"));
      if (kind) list = list.filter((m) => m.kind === kind);
      return c.json(list);
    });
    app.post("/api/memories", async (c) => {
      const user = c.get("user");
      const b = await c.req.json<{ scope: MemoryScope; projectId?: string; kind: MemoryKind; content: string }>();
      if (b.scope === "project" ? !canAccessProject(db, user, b.projectId ?? null) : user.role !== "admin") return c.json({ error: "forbidden" }, 403);
      if (!b.content?.trim()) return c.json({ error: "empty" }, 400);
      return c.json(svc.write(b, `user:${user.id}`));
    });
    const guard = (c: any, mid: string) => {
      const m = svc.get(mid); const user = c.get("user");
      if (!m) return null;
      if (m.scope === "global" ? user.role !== "admin" : !canAccessProject(db, user, m.projectId)) return null;
      return m;
    };
    app.patch("/api/memories/:id", async (c) => {
      if (!guard(c, c.req.param("id"))) return c.json({ error: "not_found" }, 404);
      const b = await c.req.json<{ content?: string; pinned?: boolean }>();
      return c.json(svc.patch(c.req.param("id"), b, `user:${c.get("user").id}`));
    });
    app.delete("/api/memories/:id", (c) => {
      if (!guard(c, c.req.param("id"))) return c.json({ error: "not_found" }, 404);
      svc.remove(c.req.param("id"), `user:${c.get("user").id}`);
      return c.json({ ok: true });
    });
    app.get("/api/memory/journal", (c) => {
      if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
      const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
      const rows = db.query(`SELECT j.*, m.content AS current, m.kind AS kind, m.scope AS scope, m.project_id AS project_id, m.pinned AS pinned, m.deleted AS deleted
        FROM memory_journal j LEFT JOIN memories m ON m.id = j.memory_id ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`).all(limit) as any[];
      return c.json(rows.map((r) => fromRow(r)));
    });
  },
};
export default mod;
