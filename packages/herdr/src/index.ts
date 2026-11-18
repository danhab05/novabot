// Module « herdr » : orchestrateur des agents Claude Code / Codex dans Herdr.
import type { Module, Ctx } from "@novabot/daemon/core";
import { getTask, canAccessProject } from "@novabot/daemon/core";
import { Orchestrator, type OrchestratorOpts } from "./orchestrator.ts";

export { Orchestrator } from "./orchestrator.ts";
export * from "./policy.ts";

export function createHerdrModule(opts: OrchestratorOpts = {}): Module & { orchestrator?: Orchestrator } {
  const mod: Module & { orchestrator?: Orchestrator } = {
    name: "herdr",
    init(ctx: Ctx) {
      const o = new Orchestrator(ctx, opts);
      mod.orchestrator = o;
      ctx.services.orchestrator = o;
      ctx.services.herdr = o; // accès direct (vue terminal, outils)

      ctx.tools.register({
        name: "herdr_agents",
        description: "Liste les agents Herdr (Claude/Codex) : nom, état, dossier, et s'ils appartiennent à Novabot (préfixe nb-).",
        inputSchema: { type: "object", properties: {} },
        async run() {
          return (await o.herdr.agents()).map((a) => ({ name: a.name ?? null, kind: a.agent, status: a.agent_status, pane: a.pane_id, cwd: a.cwd, novabot: !!a.name?.startsWith("nb-") }));
        },
      });
      ctx.tools.register({
        name: "task_cancel",
        description: "Annule une tâche Novabot et ferme son agent Herdr (le worktree et la branche sont conservés).",
        inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
        async run({ taskId }: { taskId: string }) { await o.cancel(taskId); return { ok: true }; },
      });
    },
    routes(app, ctx) {
      const o = () => mod.orchestrator!;
      app.get("/api/tasks/:id/terminal", async (c) => {
        const t = getTask(ctx, c.req.param("id"));
        if (!t || !canAccessProject(ctx.db, c.get("user"), t.projectId)) return c.json({ error: "not_found" }, 404);
        const r = o().run(t.id);
        if (!r?.agentName) return c.json({ text: "", pane: null, agent: null, state: null });
        const lines = Math.min(Number(c.req.query("lines") ?? 200), 2000);
        const a = await o().herdr.agentGet(r.agentName);
        const text = a ? await o().herdr.agentRead(r.agentName, lines).catch(() => "") : "";
        return c.json({ text, pane: r.paneId, agent: r.agentName, state: a?.agent_status ?? "gone" });
      });
      app.post("/api/tasks/:id/terminal/input", async (c) => {
        if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
        const t = getTask(ctx, c.req.param("id"));
        const r = t ? o().run(t.id) : null;
        if (!t || !r?.agentName) return c.json({ error: "not_found" }, 404);
        const { text } = await c.req.json<{ text: string }>();
        if (!text?.trim()) return c.json({ error: "empty" }, 400);
        await o().herdr.agentPrompt(r.agentName, text);
        return c.json({ ok: true });
      });
      app.get("/api/herdr/agents", async (c) => {
        if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
        const agents = await o().herdr.agents().catch(() => []);
        return c.json(agents.map((a) => ({ name: a.name ?? null, kind: a.agent, status: a.agent_status, pane: a.pane_id, workspace: a.workspace_id, cwd: a.cwd, novabot: !!a.name?.startsWith("nb-") })));
      });
    },
    async start() { await mod.orchestrator?.start(); },
    stop() { mod.orchestrator?.stop(); },
  };
  return mod;
}

export default createHerdrModule();
