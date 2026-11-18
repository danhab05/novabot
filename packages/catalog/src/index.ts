// Module « catalog » : catalogue (MCP, skills, agents), installation, publication publique, intégrations perso.
import type { Hono } from "hono";
import type { Module, Ctx } from "@novabot/daemon/core";
import { ensureModuleSchema, fromRow, insert, userFromRequest, coolifyToken } from "@novabot/daemon/core";
import type { CatalogItem, CatalogManifest, Project } from "@novabot/shared";
import { now } from "@novabot/shared";
import { defaultPaths, realRunner, type Paths, type Runner } from "./paths.ts";
import { scanSources } from "./sources.ts";
import { validateManifest } from "./manifest.ts";
import { scanSecrets } from "./secrets-scan.ts";
import { installSkill, uninstallSkill, installMcp, uninstallMcp, isMcpInstalled, type InstallDetail, type AgentInstall } from "./install.ts";
import { Integrations, integrationTools, GOOGLE_SCOPES } from "./integrations.ts";
import { renderCatalogPage, renderInstallPage } from "./public.ts";

export { validateManifest, scanSecrets };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS catalog_installs (item_id TEXT PRIMARY KEY, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_integrations (provider TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;
// activés d'office au premier démarrage (lecture ; envois réservés) : GitHub (CLI gh) et Coolify s'il est configuré
const defaultBuiltins = (ctx: Ctx) => ["mcp-github", ...(ctx.config.coolify.url ? ["mcp-coolify"] : [])];

export class Catalog {
  integrations: Integrations;
  constructor(public ctx: Ctx, public paths: Paths = defaultPaths(), public run: Runner = realRunner) {
    ensureModuleSchema(ctx.db, "catalog", 1, SCHEMA);
    this.integrations = new Integrations({
      db: ctx.db, secret: ctx.config.internalToken, google: ctx.config.google, publicUrl: ctx.config.publicUrl,
      coolify: { url: ctx.config.coolify.url, token: () => coolifyToken(ctx.config.coolify) }, whatsappCmd: process.env.NOVABOT_WHATSAPP_CMD, run: this.run, tz: ctx.config.tz,
    });
  }

  // ---------- état ----------
  installs(): Map<string, InstallDetail> {
    return new Map((this.ctx.db.query("SELECT item_id, detail FROM catalog_installs").all() as any[]).map((r) => [r.item_id, JSON.parse(r.detail)]));
  }
  builtinEnabled(builtin: string): boolean {
    for (const d of this.installs().values()) if (d.kind === "mcp" && d.builtin === builtin) return true;
    return false;
  }
  get(id: string): CatalogItem | null {
    return fromRow<CatalogItem>(this.ctx.db.query("SELECT * FROM catalog_items WHERE id = ?").get(id)) ?? null;
  }
  list(type?: string): CatalogItem[] {
    const rows = (type ? this.ctx.db.query("SELECT * FROM catalog_items WHERE json_extract(manifest,'$.type') = ? ORDER BY id").all(type) : this.ctx.db.query("SELECT * FROM catalog_items ORDER BY id").all()) as any[];
    return rows.map((r) => fromRow<CatalogItem>(r));
  }
  private upsert(m: CatalogManifest, source: CatalogItem["source"], installed: boolean) {
    this.ctx.db.query(`INSERT INTO catalog_items (id, manifest, installed, source, published) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, installed = excluded.installed, source = excluded.source`).run(m.id, JSON.stringify(m), installed ? 1 : 0, source);
  }

  /** Synchronise la table avec les sources sur disque (skills + registre). Conserve publié/importé. */
  sync() {
    const inst = this.installs();
    const scanned = scanSources(this.paths, (id, m) => isMcpInstalled(this.paths, m));
    const ids = new Set<string>();
    for (const s of scanned) { ids.add(s.manifest.id); this.upsert(s.manifest, s.source, s.installed || inst.has(s.manifest.id)); }
    // éléments disparus du disque : supprimés s'ils ne sont ni publiés, ni importés, ni installés par Novabot
    for (const r of this.ctx.db.query("SELECT id, source, published FROM catalog_items").all() as any[]) {
      if (!ids.has(r.id) && r.source !== "public" && !r.published && !inst.has(r.id)) this.ctx.db.query("DELETE FROM catalog_items WHERE id = ?").run(r.id);
    }
    return { count: scanned.length };
  }

  /** Active les intégrations de base au premier démarrage. */
  defaults() {
    if (this.ctx.db.query("SELECT 1 FROM settings WHERE key = 'catalog.defaults'").get()) return;
    for (const id of defaultBuiltins(this.ctx)) {
      const it = this.get(id);
      if (it && !this.installs().has(id)) this.record(id, { kind: "mcp", name: id.replace(/^mcp-/, ""), builtin: (it.manifest.mcp as any).builtin, claudeAdded: false, codexAdded: false, secretsAdded: [] });
    }
    this.ctx.db.query("INSERT INTO settings (key, value) VALUES ('catalog.defaults', ?)").run(String(now()));
  }

  private record(id: string, d: InstallDetail) {
    this.ctx.db.query("INSERT INTO catalog_installs (item_id, detail, created_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET detail = excluded.detail").run(id, JSON.stringify(d), now());
    this.ctx.db.query("UPDATE catalog_items SET installed = 1 WHERE id = ?").run(id);
  }

  // ---------- installation ----------
  async install(id: string, o: { secrets?: Record<string, string>; projectId?: string; force?: boolean } = {}) {
    const it = this.get(id);
    if (!it) throw new Error(`élément inconnu : ${id}`);
    if (this.installs().has(id)) throw new Error("déjà installé par Novabot");
    const m = it.manifest;
    let detail: InstallDetail;
    if (m.type === "skill") detail = installSkill(this.paths, m, { force: o.force });
    else if (m.type === "mcp") detail = await installMcp(this.paths, this.run, m, o.secrets ?? {});
    else detail = this.installAgent(m, o.projectId);
    this.record(id, detail);
    if (detail.kind === "mcp" && detail.secretsAdded.length) for (const k of detail.secretsAdded) process.env[k] = o.secrets![k]; // dispo sans redémarrage
    const next = detail.kind === "mcp" && detail.builtin?.startsWith("google-") ? { connectUrl: "/auth/google?scope=" + detail.builtin.replace("google-", "") } : {};
    return { ok: true, detail, ...next };
  }

  async uninstall(id: string) {
    const d = this.installs().get(id);
    if (!d) throw new Error("pas installé par Novabot : rien à désinstaller (Novabot ne retire que ce qu'il a installé)");
    if (d.kind === "skill") uninstallSkill(this.paths, d);
    else if (d.kind === "mcp") await uninstallMcp(this.paths, this.run, d);
    else this.uninstallAgent(d);
    this.ctx.db.query("DELETE FROM catalog_installs WHERE item_id = ?").run(id);
    const it = this.get(id);
    const still = it?.manifest.type === "mcp" ? isMcpInstalled(this.paths, it.manifest) : false;
    this.ctx.db.query("UPDATE catalog_items SET installed = ? WHERE id = ?").run(still ? 1 : 0, id);
    return { ok: true };
  }

  private installAgent(m: CatalogManifest, projectId?: string): AgentInstall {
    const marker = `novabot:agent ${m.id}`;
    const block = `<!-- ${marker} -->\n## ${m.name}\n${m.agent!.instructions}\n<!-- /${marker} -->`;
    const { db, bus } = this.ctx;
    if (projectId) {
      const p = fromRow<Project>(db.query("SELECT * FROM projects WHERE id = ?").get(projectId));
      if (!p) throw new Error(`projet inconnu : ${projectId}`);
      if ((p.notes ?? "").includes(`<!-- ${marker} -->`)) throw new Error("ces instructions sont déjà dans le projet");
      const notes = (p.notes ? p.notes.trimEnd() + "\n\n" : "") + block;
      db.query("UPDATE projects SET notes = ? WHERE id = ?").run(notes, projectId);
      bus.emit({ type: "project", project: { ...p, notes } });
      return { kind: "agent", projectId, createdProject: false, marker };
    }
    let pid = m.id.replace(/^agent-/, ""); let n = 2;
    while (db.query("SELECT 1 FROM projects WHERE id = ?").get(pid)) pid = `${m.id.replace(/^agent-/, "")}-${n++}`;
    const p: Project = { id: pid, name: m.name, folderId: null, path: null, stack: null, notes: block, discordChannelId: null, autonomy: "full", defaultAgent: m.agent!.defaultAgent ?? null, createdAt: now() };
    insert(db, "projects", p as any);
    bus.emit({ type: "project", project: p });
    return { kind: "agent", projectId: pid, createdProject: true, marker };
  }

  private uninstallAgent(d: AgentInstall) {
    const { db } = this.ctx;
    const p = fromRow<Project>(db.query("SELECT * FROM projects WHERE id = ?").get(d.projectId));
    if (!p) return;
    const used = db.query("SELECT (SELECT COUNT(*) FROM threads WHERE project_id = ?) + (SELECT COUNT(*) FROM tasks WHERE project_id = ?) + (SELECT COUNT(*) FROM project_members WHERE project_id = ?) AS n").get(p.id, p.id, p.id) as { n: number };
    if (d.createdProject && used.n === 0) { db.query("DELETE FROM projects WHERE id = ?").run(p.id); return; }
    const esc = d.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const notes = (p.notes ?? "").replace(new RegExp(`\\n*<!-- ${esc} -->[\\s\\S]*?<!-- /${esc} -->`), "").trim();
    db.query("UPDATE projects SET notes = ? WHERE id = ?").run(notes || null, p.id);
    this.ctx.bus.emit({ type: "project", project: { ...p, notes: notes || null } });
  }

  // ---------- publication / import ----------
  publish(id: string) {
    const it = this.get(id);
    if (!it) throw new Error(`élément inconnu : ${id}`);
    const findings = scanSecrets(it.manifest);
    if (findings.length) return { ok: false as const, findings };
    this.ctx.db.query("UPDATE catalog_items SET published = 1 WHERE id = ?").run(id);
    return { ok: true as const, url: `${this.ctx.config.publicUrl.replace(/\/$/, "")}/pub/catalogue/${encodeURIComponent(id)}.json` };
  }
  unpublish(id: string) { this.ctx.db.query("UPDATE catalog_items SET published = 0 WHERE id = ?").run(id); return { ok: true }; }

  async importRemote(url: string, f: typeof fetch = fetch) {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error("URL invalide"); }
    if (u.protocol !== "https:") throw new Error("https uniquement");
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname)) throw new Error("adresse locale refusée");
    const r = await f(u, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`téléchargement : HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 1024 * 1024) throw new Error("manifeste trop gros (1 Mo max)");
    let raw: unknown; try { raw = JSON.parse(text); } catch { throw new Error("JSON invalide"); }
    const m = validateManifest(raw);
    if (this.get(m.id) && this.get(m.id)!.source !== "public") m.id = `pub-${m.id}`.slice(0, 64);
    this.upsert(m, "public", false);
    return { ok: true, manifest: m };
  }
}

// ---------------- module ----------------
let catalog: Catalog | null = null;
const oauthStates = new Map<string, { scopes: string[]; exp: number }>();

const mod: Module & { publicRoutes(app: Hono, ctx: Ctx): void } = {
  name: "catalog",
  init(ctx) {
    catalog = new Catalog(ctx);
    catalog.sync();
    catalog.defaults();
    for (const t of integrationTools(catalog.integrations, (b) => catalog!.builtinEnabled(b))) ctx.tools.register(t);
    ctx.tools.register({
      name: "catalog_search", description: "Cherche dans le catalogue Novabot (skills, connecteurs MCP, modèles d'agents) et indique ce qui est installé.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, type: { type: "string", enum: ["mcp", "skill", "agent"] } } },
      async run(i: { query?: string; type?: string }) {
        const q = (i.query ?? "").toLowerCase();
        return catalog!.list(i.type).filter((x) => !q || (x.manifest.name + " " + x.manifest.description).toLowerCase().includes(q)).slice(0, 30)
          .map((x) => ({ id: x.id, type: x.manifest.type, name: x.manifest.name, description: x.manifest.description.slice(0, 200), installed: x.installed, source: x.source }));
      },
    });
    ctx.services.catalog = catalog;
  },
  routes(app, ctx) {
    const admin = (c: any) => c.get("user").role === "admin";
    const fail = (c: any, e: unknown, code = 400) => c.json({ error: String((e as Error)?.message ?? e) }, code);
    app.get("/api/catalog", (c) => c.json(catalog!.list(c.req.query("type") || undefined)));
    app.post("/api/catalog/rescan", (c) => (admin(c) ? c.json(catalog!.sync()) : c.json({ error: "forbidden" }, 403)));
    app.post("/api/catalog/import", async (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      try { const b = await c.req.json<{ url: string }>(); return c.json(await catalog!.importRemote(b.url)); } catch (e) { return fail(c, e); }
    });
    app.post("/api/catalog/:id/install", async (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      try { const b = await c.req.json().catch(() => ({})); return c.json(await catalog!.install(c.req.param("id"), b)); } catch (e) { return fail(c, e); }
    });
    app.post("/api/catalog/:id/uninstall", async (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      try { return c.json(await catalog!.uninstall(c.req.param("id"))); } catch (e) { return fail(c, e); }
    });
    app.post("/api/catalog/:id/publish", (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      try { const r = catalog!.publish(c.req.param("id")); return r.ok ? c.json(r) : c.json({ error: "secrets détectés : publication refusée", findings: r.findings }, 422); } catch (e) { return fail(c, e); }
    });
    app.post("/api/catalog/:id/unpublish", (c) => (admin(c) ? c.json(catalog!.unpublish(c.req.param("id"))) : c.json({ error: "forbidden" }, 403)));
    app.get("/api/integrations", async (c) => (admin(c) ? c.json(await catalog!.integrations.status()) : c.json({ error: "forbidden" }, 403)));
    app.delete("/api/integrations/google", (c) => { if (!admin(c)) return c.json({ error: "forbidden" }, 403); catalog!.integrations.remove("google"); return c.json({ ok: true }); });
  },
  publicRoutes(app, ctx) {
    app.get("/pub/catalogue", (c) => {
      const items = catalog!.list().filter((i) => i.published);
      return c.html(renderCatalogPage(items, ctx.config.publicUrl), 200, { "cache-control": "public, max-age=60" });
    });
    app.get("/pub/catalogue/:file", (c) => {
      const id = c.req.param("file").replace(/\.json$/, "");
      const it = catalog!.get(id);
      if (!it || !it.published) return c.json({ error: "not_found" }, 404);
      return c.json(it.manifest, 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" });
    });
    app.get("/catalog/install", (c) => {
      const src = c.req.query("src") ?? "";
      const u = userFromRequest(ctx.db, c);
      return c.html(renderInstallPage(src, u?.role === "admin"));
    });
    // ---- OAuth Google (session admin requise) ----
    app.get("/auth/google", (c) => {
      const u = userFromRequest(ctx.db, c);
      if (u?.role !== "admin") return c.redirect("/auth/discord");
      if (!catalog!.integrations.googleConfigured()) return c.text("Client OAuth Google non configuré (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Voir /api/integrations.", 503);
      const scopes = (c.req.query("scope") ?? "gmail,calendar,drive").split(",").filter((s) => s in GOOGLE_SCOPES);
      const state = crypto.randomUUID();
      for (const [k, v] of oauthStates) if (v.exp < Date.now()) oauthStates.delete(k);
      oauthStates.set(state, { scopes, exp: Date.now() + 10 * 60_000 });
      return c.redirect(catalog!.integrations.googleAuthUrl(scopes, state));
    });
    app.get("/auth/google/callback", async (c) => {
      const u = userFromRequest(ctx.db, c);
      const st = oauthStates.get(c.req.query("state") ?? "");
      oauthStates.delete(c.req.query("state") ?? "");
      if (u?.role !== "admin" || !st || st.exp < Date.now()) return c.text("Session ou état OAuth invalide : recommence depuis Novabot.", 400);
      if (c.req.query("error")) return c.text(`Google a refusé : ${c.req.query("error")}`, 400);
      try {
        await catalog!.integrations.googleExchange(c.req.query("code") ?? "");
        const ITEM: Record<string, string> = { gmail: "mcp-gmail", calendar: "mcp-google-calendar", drive: "mcp-google-drive" };
        for (const s of st.scopes) { const id = ITEM[s]; if (catalog!.get(id) && !catalog!.installs().has(id)) await catalog!.install(id).catch(() => {}); }
        return c.redirect("/?integrations=google-ok");
      } catch (e) { return c.text(String((e as Error).message), 400); }
    });
  },
};
export default mod;
