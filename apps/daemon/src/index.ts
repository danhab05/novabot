import { Hono } from "hono";
import { serveStatic, createBunWebSocket } from "hono/bun";
import { existsSync } from "node:fs";
import { config } from "./core/config.ts";
import { openDb, insert, fromRow } from "./core/db.ts";
import { Bus, ToolRegistry, type Ctx, type Module, type Services } from "./core/context.ts";
import { requireUser } from "./core/auth.ts";
import { coreRoutes, publicRoutes } from "./routes/core.ts";
import { coreTools } from "./core/tools.ts";
import type { User, Message, Thread, Project } from "@novabot/shared";
import { id, now } from "@novabot/shared";
import { MODULES } from "./modules/index.ts";

export async function createApp(opts: { dbPath?: string; modules?: Module[] } = {}) {
  const db = openDb(opts.dbPath ?? config.dbPath);
  const bus = new Bus();
  const tools = new ToolRegistry();
  const log = (mod: string, ...a: unknown[]) => console.log(new Date().toISOString(), `[${mod}]`, ...a);

  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const services: Services = {
    upgradeWebSocket, websocket,
    outbound: [],
    notifiers: [],
    notify: {
      async send(n) {
        bus.emit({ type: "notify", title: n.title, body: n.body, url: n.url, projectId: n.projectId ?? null, level: n.level });
        await Promise.allSettled(services.notifiers.map((f) => f(n)));
      },
    },
  };

  const ctx: Ctx = {
    db, bus, tools, config, services, log,
    postMessage(m) {
      const msg: Message = { id: m.id ?? id("m_"), threadId: m.threadId, role: m.role, authorId: m.authorId ?? null, content: m.content, meta: m.meta ?? null, createdAt: now() };
      insert(db, "messages", msg as any);
      db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(msg.createdAt, msg.threadId);
      const thread = fromRow<Thread>(db.query("SELECT * FROM threads WHERE id = ?").get(msg.threadId));
      const project = thread?.projectId ? fromRow<Project>(db.query("SELECT * FROM projects WHERE id = ?").get(thread.projectId)) : null;
      bus.emit({ type: "message", message: msg, projectId: thread?.projectId ?? null });
      // diffusion vers les canaux (Discord…) ; chaque canal ignore ce qui vient de lui-même (meta.source)
      for (const f of services.outbound) f(msg, thread, project).catch((e) => log("outbound", e));
      return msg;
    },
  };

  coreTools(ctx);
  const modules = (opts.modules ?? (await loadModules(log))).filter((m) => !config.disabled.has(m.name));
  for (const m of modules) {
    try { await m.init(ctx); log("core", `module ${m.name} ok`); }
    catch (e) { log("core", `module ${m.name} init FAILED`, e); }
  }

  const app = new Hono();
  publicRoutes(app, ctx);
  const api = new Hono<{ Variables: { user: User } }>();
  api.use("/api/*", requireUser(db));
  api.use("/internal/*", requireUser(db));
  coreRoutes(api, ctx);
  for (const m of modules) { try { m.routes?.(api, ctx); } catch (e) { log("core", `routes ${m.name} FAILED`, e); } }
  // routes publiques de modules (ex. /auth/discord, /catalogue) : convention, préfixe /auth ou /pub
  for (const m of modules) { try { m.publicRoutes?.(app, ctx); } catch (e) { log("core", `publicRoutes ${m.name} FAILED`, e); } }
  app.route("/", api);

  if (existsSync(config.pwaDist)) {
    app.use("/*", serveStatic({ root: config.pwaDist }));
    // repli SPA : toute route profonde (/tasks/<id>, /p/<projet>…) renvoie la coquille, sauf /api, /internal, /auth, /pub
    const indexHtml = () => Bun.file(config.pwaDist + "/index.html");
    app.get("*", (c) => (/^\/(api|internal|auth|pub)\b/.test(c.req.path) ? c.json({ error: "not_found" }, 404) : new Response(indexHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } })));
  } else {
    app.get("/", (c) => c.text("Novabot daemon OK — PWA non construite (bun run build:pwa)"));
  }

  return { app, ctx, modules };
}

async function loadModules(log: Ctx["log"]): Promise<Module[]> {
  const out: Module[] = [];
  for (const [name, loader] of Object.entries(MODULES)) {
    try { const m = (await loader()).default as Module; if (m) out.push(m); }
    catch (e: any) { log("core", `module ${name} introuvable/échec import: ${e?.message ?? e}`); }
  }
  return out;
}

if (import.meta.main) {
  const { app, ctx, modules } = await createApp();
  for (const m of modules) { try { await m.start?.(ctx); } catch (e) { ctx.log("core", `start ${m.name} FAILED`, e); } }
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch, idleTimeout: 0, websocket: (ctx.services as any).websocket });
  ctx.services.server = server;
  ctx.log("core", `Novabot écoute sur http://${config.host}:${config.port}`);
  const shutdown = async () => { for (const m of modules) await m.stop?.(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
