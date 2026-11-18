import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Ctx } from "../core/context.ts";
import { fromRow, insert, update } from "../core/db.ts";
import { canAccessProject, accessibleProjectIds, destroySession, createSession, adminUser } from "../core/auth.ts";
import type { User, Project, Thread, Message, Task, Folder, NovaEvent } from "@novabot/shared";
import { id, now } from "@novabot/shared";

type App = Hono<{ Variables: { user: User } }>;

export function eventProjectId(e: NovaEvent): string | null | undefined {
  switch (e.type) {
    case "message": case "message.delta": case "task.event": case "notify": return e.projectId;
    case "task": return e.task.projectId;
    case "memory": return e.memory.projectId;
    case "idea": return e.idea.projectId;
    case "project": return e.project.id;
    default: return undefined; // global : admin seulement
  }
}

export function coreRoutes(app: App, ctx: Ctx) {
  const { db } = ctx;

  app.get("/api/me", (c) => c.json(c.get("user")));
  app.post("/api/auth/logout", (c) => { destroySession(db, c); return c.json({ ok: true }); });

  app.get("/api/bootstrap", (c) => {
    const user = c.get("user");
    const acc = accessibleProjectIds(db, user);
    const folders = (db.query("SELECT * FROM folders ORDER BY position, name").all() as any[]).map((r) => fromRow<Folder>(r));
    let projects = (db.query("SELECT * FROM projects ORDER BY name").all() as any[]).map((r) => fromRow<Project>(r));
    if (acc !== "all") projects = projects.filter((p) => acc.includes(p.id));
    const activeTasks = (db.query("SELECT * FROM tasks WHERE status IN ('queued','running','verifying','waiting','blocked') ORDER BY priority, created_at").all() as any[])
      .map((r) => fromRow<Task>(r)).filter((t) => canAccessProject(db, user, t.projectId));
    return c.json({ user, folders, projects, activeTasks, features: Object.keys(ctx.services).filter((k) => !!(ctx.services as any)[k]) });
  });

  // ---- dossiers / projets ----
  app.post("/api/folders", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const b = await c.req.json<{ name: string; position?: number }>();
    const f = { id: id("f_"), name: b.name, position: b.position ?? 0 };
    insert(db, "folders", f);
    return c.json(f);
  });
  app.post("/api/projects", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const b = await c.req.json<Partial<Project> & { id: string; name: string }>();
    const p: Project = { id: b.id, name: b.name, folderId: b.folderId ?? null, path: b.path ?? null, stack: b.stack ?? null, notes: b.notes ?? null, discordChannelId: null, autonomy: b.autonomy ?? "full", defaultAgent: b.defaultAgent ?? null, createdAt: now() };
    insert(db, "projects", p as any);
    ctx.bus.emit({ type: "project", project: p });
    return c.json(p);
  });
  app.patch("/api/projects/:id", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const b = await c.req.json<Partial<Project>>();
    delete (b as any).id; delete (b as any).createdAt;
    update(db, "projects", "id", c.req.param("id"), b as any);
    const p = fromRow<Project>(db.query("SELECT * FROM projects WHERE id = ?").get(c.req.param("id")));
    ctx.bus.emit({ type: "project", project: p });
    return c.json(p);
  });
  app.get("/api/projects/:id/members", (c) => {
    if (!canAccessProject(db, c.get("user"), c.req.param("id"))) return c.json({ error: "forbidden" }, 403);
    return c.json((db.query("SELECT u.* FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?").all(c.req.param("id")) as any[]).map((r) => fromRow<User>(r)));
  });

  // ---- fils ----
  app.get("/api/threads", (c) => {
    const user = c.get("user");
    const projectId = c.req.query("projectId") ?? null;
    if (!canAccessProject(db, user, projectId)) return c.json({ error: "forbidden" }, 403);
    const rows = projectId
      ? db.query("SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100").all(projectId)
      : db.query("SELECT * FROM threads WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 100").all();
    return c.json((rows as any[]).map((r) => fromRow<Thread>(r)));
  });
  app.post("/api/threads", async (c) => {
    const b = await c.req.json<{ projectId?: string | null; title?: string }>();
    if (!canAccessProject(db, c.get("user"), b.projectId ?? null)) return c.json({ error: "forbidden" }, 403);
    return c.json(createThread(ctx, b.projectId ?? null, b.title ?? "Nouvelle conversation"));
  });
  app.get("/api/threads/:id/messages", (c) => {
    const t = getThread(ctx, c.req.param("id"));
    if (!t || !canAccessProject(db, c.get("user"), t.projectId)) return c.json({ error: "not_found" }, 404);
    const before = Number(c.req.query("before") ?? Date.now() + 1);
    const rows = db.query("SELECT * FROM messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 80").all(t.id, before) as any[];
    return c.json(rows.reverse().map((r) => fromRow<Message>(r)));
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const user = c.get("user");
    const t = getThread(ctx, c.req.param("id"));
    if (!t || !canAccessProject(db, user, t.projectId)) return c.json({ error: "not_found" }, 404);
    const b = await c.req.json<{ content: string; meta?: Record<string, unknown> }>();
    if (!b.content?.trim() && !b.meta?.attachments) return c.json({ error: "empty" }, 400);
    const m = ctx.postMessage({ threadId: t.id, role: "user", authorId: user.id, content: b.content ?? "", meta: { ...(b.meta ?? {}), source: "pwa", authorName: user.name } });
    dispatchToBrain(ctx, m, t, user);
    return c.json(m);
  });

  // ---- tâches ----
  app.get("/api/tasks", (c) => {
    const user = c.get("user");
    const status = c.req.query("status");
    const projectId = c.req.query("projectId");
    let sql = "SELECT * FROM tasks WHERE 1=1"; const args: any[] = [];
    if (status) { sql += ` AND status IN (${status.split(",").map(() => "?").join(",")})`; args.push(...status.split(",")); }
    if (projectId) { sql += " AND project_id = ?"; args.push(projectId); }
    sql += " ORDER BY updated_at DESC LIMIT 200";
    return c.json((db.query(sql).all(...args) as any[]).map((r) => fromRow<Task>(r)).filter((t) => canAccessProject(db, user, t.projectId)));
  });
  app.get("/api/tasks/:id", (c) => {
    const t = fromRow<Task>(db.query("SELECT * FROM tasks WHERE id = ?").get(c.req.param("id")));
    if (!t || !canAccessProject(db, c.get("user"), t.projectId)) return c.json({ error: "not_found" }, 404);
    const events = (db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at").all(t.id) as any[]).map((r) => fromRow(r));
    return c.json({ task: t, events });
  });
  app.post("/api/tasks/:id/cancel", async (c) => {
    const t = fromRow<Task>(db.query("SELECT * FROM tasks WHERE id = ?").get(c.req.param("id")));
    if (!t || !canAccessProject(db, c.get("user"), t.projectId)) return c.json({ error: "not_found" }, 404);
    await ctx.services.orchestrator?.cancel(t.id);
    return c.json({ ok: true });
  });
  app.post("/api/tasks/:id/answer", async (c) => {
    const t = fromRow<Task>(db.query("SELECT * FROM tasks WHERE id = ?").get(c.req.param("id")));
    if (!t || !canAccessProject(db, c.get("user"), t.projectId)) return c.json({ error: "not_found" }, 404);
    const b = await c.req.json<{ answer: string }>();
    await ctx.services.orchestrator?.answer(t.id, b.answer, c.get("user").id);
    return c.json({ ok: true });
  });
  app.get("/api/orchestrator", (c) => c.json(ctx.services.orchestrator?.status() ?? null));

  // ---- temps réel ----
  app.get("/api/events", (c) => {
    const user = c.get("user");
    return streamSSE(c, async (stream) => {
      const queue: NovaEvent[] = [];
      let wake: (() => void) | null = null;
      const off = ctx.bus.on((e) => {
        const pid = eventProjectId(e);
        if (user.role !== "admin" && (pid === undefined || !canAccessProject(db, user, pid))) return;
        queue.push(e); wake?.();
      });
      stream.onAbort(() => { off(); wake?.(); });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ t: now() }) });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), Bun.sleep(25_000)]);
          wake = null;
          if (!queue.length) { await stream.writeSSE({ event: "ping", data: "{}" }); continue; }
        }
        while (queue.length) await stream.writeSSE({ event: "nova", data: JSON.stringify(queue.shift()) });
      }
      off();
    });
  });

  // ---- outils (MCP novabot -> daemon) ----
  app.get("/internal/tools", (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    return c.json(ctx.tools.list().map(({ name, description, inputSchema, reserved }) => ({ name, description, inputSchema, reserved: !!reserved })));
  });
  app.post("/internal/tools/:name", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const input = await c.req.json().catch(() => ({}));
    const h = (k: string) => c.req.header(k) || null;
    const tool = ctx.tools.get(c.req.param("name"));
    if (tool?.reserved) return c.json({ ok: false, error: `« ${tool.name} » est une action réservée à ${ctx.config.ownerName} : utilise ask_owner (question + recommandation) au lieu de l'exécuter.` });
    try {
      const result = await ctx.tools.run(c.req.param("name"), input, { userId: null, projectId: h("x-nova-project"), threadId: h("x-nova-thread"), taskId: h("x-nova-task"), caller: "mcp" });
      return c.json({ ok: true, result });
    } catch (e: any) {
      return c.json({ ok: false, error: String(e?.message ?? e) }, 200);
    }
  });

  // ---- dev : connexion locale sans Discord ----
  app.get("/api/auth/dev", (c) => c.json({ error: "use /auth/dev" }, 400));
}

/** Routes publiques (sans session). */
export function publicRoutes(app: Hono, ctx: Ctx) {
  // Connexion de secours : /auth/dev?token=<NOVABOT_INTERNAL_TOKEN> -> session admin. Utile tant que le login Discord n'est pas branché.
  app.get("/auth/dev", (c) => {
    if (!ctx.config.internalToken || c.req.query("token") !== ctx.config.internalToken) return c.text("forbidden", 403);
    createSession(ctx.db, c, adminUser(ctx.db).id);
    return c.redirect("/");
  });
  app.get("/healthz", (c) => c.json({ ok: true, t: now() }));
}

export function getThread(ctx: Ctx, threadId: string): Thread | null {
  return fromRow<Thread>(ctx.db.query("SELECT * FROM threads WHERE id = ?").get(threadId)) ?? null;
}

export function createThread(ctx: Ctx, projectId: string | null, title: string, discordThreadId: string | null = null): Thread {
  const t: Thread = { id: id("t_"), projectId, title, discordThreadId, createdAt: now(), updatedAt: now() };
  insert(ctx.db, "threads", t as any);
  return t;
}

/** Fil principal d'un projet (créé si absent) : c'est là qu'arrivent les messages du salon Discord du projet. */
export function mainThread(ctx: Ctx, projectId: string | null): Thread {
  const row = projectId
    ? ctx.db.query("SELECT * FROM threads WHERE project_id = ? AND discord_thread_id IS NULL ORDER BY created_at LIMIT 1").get(projectId)
    : ctx.db.query("SELECT * FROM threads WHERE project_id IS NULL ORDER BY created_at LIMIT 1").get();
  return row ? fromRow<Thread>(row) : createThread(ctx, projectId, projectId ? "Général" : "Novabot");
}

export function dispatchToBrain(ctx: Ctx, m: Message, t: Thread, user: User | null) {
  const brain = ctx.services.brain;
  if (!brain) {
    ctx.postMessage({ threadId: t.id, role: "system", authorId: null, content: "Le cerveau n'est pas chargé (module brain absent).", meta: null });
    return;
  }
  brain.handleMessage(m, t, user).catch((e) => {
    ctx.log("brain", "handleMessage error", e);
    ctx.postMessage({ threadId: t.id, role: "system", authorId: null, content: `Erreur du cerveau : ${String(e?.message ?? e).slice(0, 500)}`, meta: { error: true } });
  });
}
