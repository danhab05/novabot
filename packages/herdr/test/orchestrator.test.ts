import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, type Behavior } from "./fake-herdr.ts";

const DATA = mkdtempSync(join(tmpdir(), "nb-herdr-test-"));
process.env.NOVABOT_DATA = DATA;
process.env.NOVABOT_INTERNAL_TOKEN = "tok-test";
process.env.NOVABOT_SECRETS = join(DATA, "none.env");

let createApp: typeof import("../../../apps/daemon/src/index.ts").createApp;
let createHerdrModule: typeof import("../src/index.ts").createHerdrModule;
let core: typeof import("@novabot/daemon/core");
beforeAll(async () => {
  ({ createApp } = await import("../../../apps/daemon/src/index.ts"));
  ({ createHerdrModule } = await import("../src/index.ts"));
  core = await import("@novabot/daemon/core");
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "nb-repo-"));
  Bun.spawnSync(["bash", "-c", `cd ${dir} && git init -q -b main && git config user.email t@t && git config user.name t && echo base > README.md && git add . && git commit -qm init`]);
  return dir;
}

async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await Bun.sleep(20); }
  throw new Error("timeout waitFor");
}

const RES_OK = { memAvailMb: 10000, swapPct: 10, load1: 1 };

async function setup(behavior: Behavior, o: { verdicts?: string[]; resources?: any; autonomy?: string; noRepo?: boolean } = {}) {
  const fake = new FakeHerdr(behavior);
  let res = o.resources ?? RES_OK;
  let clock = Date.now();
  const mod = createHerdrModule({ exec: fake.exec, pollMs: 50, waitMs: 1000, watchdogMs: 100000, resources: () => res, now: () => clock,
    quotas: async () => ({ claude5h: 10, claude7d: 10, claudeReset: clock + 3600_000, codex: 10, codexReset: clock + 3600_000 }) });
  const { ctx } = await createApp({ dbPath: ":memory:", modules: [mod] });
  const notes: any[] = [];
  ctx.services.notifiers.push(async (n) => { notes.push(n); });
  if (o.verdicts) {
    const q = [...o.verdicts];
    ctx.services.brain = { handleMessage: async () => {}, complete: async () => q.shift() ?? '{"verdict":"done","reason":"ok"}' };
  }
  const repo = o.noRepo ? join(DATA, "norepo-" + Math.random().toString(36).slice(2)) : makeRepo();
  core.insert(ctx.db, "projects", { id: "demo", name: "Démo", folderId: null, path: repo, stack: "node", notes: null, discordChannelId: null, autonomy: o.autonomy ?? "full", defaultAgent: null, createdAt: Date.now() });
  const thread = core.createThread(ctx, "demo", "Général");
  return { ctx, fake, orch: mod.orchestrator!, repo, thread, notes, setRes: (r: any) => (res = r), advance: (ms: number) => (clock += ms) };
}

/** Agent qui crée hello.txt, commit, puis appelle task_done (via le registre, comme le ferait le MCP). */
const doneBehavior = (ctxRef: { ctx?: any }): Behavior => async (a, prompt) => {
  if (prompt.includes("Objectif") || prompt.includes("vérification")) {
    writeFileSync(join(a.cwd, "hello.txt"), "ok\n");
    Bun.spawnSync(["bash", "-c", `cd ${a.cwd} && git add hello.txt && git -c user.email=t@t -c user.name=t commit -qm hello`]);
    const taskId = ctxRef.ctx.db.query("SELECT task_id FROM herdr_runs WHERE agent_name = ?").get(a.name).task_id;
    await ctxRef.ctx.tools.run("task_done", { summary: "hello.txt créé", evidence: "git log : hello" }, { userId: null, projectId: "demo", threadId: null, taskId, caller: "mcp" });
  }
  a.output = "Terminé.\n"; a.status = "idle";
};

test("chemin nominal : worktree, args Claude, correction puis validation, notif, message, handoff", async () => {
  const ref: any = {};
  const s = await setup(doneBehavior(ref), { verdicts: ['{"verdict":"fix","reason":"pas de test","fix":"ajoute une preuve"}', '{"verdict":"done","reason":"preuve ok"}'] });
  ref.ctx = s.ctx;
  const t = core.createTask(s.ctx, { projectId: "demo", threadId: s.thread.id, title: "Créer hello", goal: "crée hello.txt contenant ok, commit", agentKind: "claude", model: "haiku", effort: "low" });
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "done" && s.fake.agents.size === 0 && !existsSync(join(DATA, "run", `${t.id}.mcp.json`)));
  const fin = core.getTask(s.ctx, t.id)!;
  expect(fin.attempts).toBe(1);
  expect(fin.branch).toStartWith("nb/creer-hello");
  const run = s.orch.run(t.id)!;
  expect(run.worktree).toContain(join(DATA, "worktrees", "demo"));
  expect(existsSync(join(run.worktree!, "hello.txt"))).toBe(true);
  // arguments Claude attendus (skip-permissions + IS_SANDBOX)
  const start = s.fake.calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  expect(start).toContain("--dangerously-skip-permissions");
  expect(start.join(" ")).toContain("--model haiku --effort low --mcp-config");
  const mcp = s.fake.mcpConfigs[0];
  expect(existsSync(start[start.indexOf("--mcp-config") + 1])).toBe(false); // nettoyé à la fin
  expect(mcp.mcpServers.novabot.env.NOVA_TASK_ID).toBe(t.id);
  const wsc = s.fake.calls.find((c) => c[0] === "workspace" && c[1] === "create")!.join(" ");
  expect(wsc).toContain("--label nb-demo"); expect(wsc).toContain("--env IS_SANDBOX=1"); expect(wsc).toContain("--no-focus");
  expect(s.fake.workspaces.length).toBe(0); // workspace nb- refermé une fois vide
  // correction envoyée puis validée
  const types = (s.ctx.db.query("SELECT type FROM task_events WHERE task_id = ? ORDER BY created_at").all(t.id) as any[]).map((r) => r.type);
  expect(types).toContain("launched"); expect(types.filter((x) => x === "verdict").length).toBe(2);
  expect(s.fake.agents.size).toBe(0); // panneau fermé
  expect(s.notes.some((n) => n.level === "done")).toBe(true);
  const msgs = s.ctx.db.query("SELECT content FROM messages WHERE thread_id = ?").all(s.thread.id) as any[];
  expect(msgs.some((m) => m.content.startsWith("✅"))).toBe(true);
  expect(readFileSync(join(DATA, "handoffs", "demo.md"), "utf8")).toContain("Créer hello");
  // branche non mergée → worktree conservé
  expect(existsSync(run.worktree!)).toBe(true);
});

test("sans cerveau : arrêt sans task_done → relance, puis validation sur task_done", async () => {
  const ref: any = {}; let n = 0;
  const s = await setup(async (a, p) => { n++; if (n === 1) { a.output = "j'ai fini je crois"; a.status = "idle"; return; } await doneBehavior(ref)(a, "Objectif", s.fake); });
  ref.ctx = s.ctx;
  const t = core.createTask(s.ctx, { projectId: "demo", title: "X", goal: "fais X", agentKind: "claude" });
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "done");
  const prompts = [...s.fake.calls.filter((c) => c[1] === "prompt").map((c) => c[3])];
  expect(prompts[1]).toContain("task_done");
  expect(core.getTask(s.ctx, t.id)!.attempts).toBe(1);
});

test("garde-fou ressources : swap plein → reste en file ; priorité 0 passe malgré la charge", async () => {
  const s = await setup(async (a) => { a.status = "idle"; }, { resources: { memAvailMb: 4800, swapPct: 100, load1: 11 } });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "fond", goal: "g", priority: 2, agentKind: "claude" });
  await s.orch.tick();
  expect(core.getTask(s.ctx, t.id)!.status).toBe("queued");
  const ev = s.ctx.db.query("SELECT data FROM task_events WHERE task_id = ? AND type = 'queued_resources'").get(t.id) as any;
  expect(JSON.parse(ev.data).reason).toContain("swap");
  // seuils surchargés via settings + charge haute : priorité 0 passe, priorité 2 non
  s.ctx.db.query("INSERT INTO settings (key, value) VALUES ('herdr.limits', ?)").run(JSON.stringify({ swapPct: 101 }));
  s.ctx.db.query("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(t.id);
  const t2 = core.createTask(s.ctx, { projectId: "demo", title: "fond2", goal: "g", priority: 2, agentKind: "claude" });
  await s.orch.tick();
  expect(core.getTask(s.ctx, t2.id)!.status).toBe("queued");
  s.ctx.db.query("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(t2.id);
  const t0 = core.createTask(s.ctx, { projectId: "demo", title: "prod cassée", goal: "g", priority: 0, agentKind: "claude" });
  await waitFor(() => !!s.orch.run(t0.id)?.agentName);
  expect(s.orch.run(t0.id)!.agentName).toMatch(/^nb-demo-/);
});

test("limite de quota → attente puis reprise automatique au reset", async () => {
  let n = 0;
  const s = await setup(async (a) => { n++; a.output = n === 1 ? "You've hit your limit · resets at 3pm" : "repris"; a.status = "idle"; }, { verdicts: ['{"verdict":"done","reason":"ok"}'] });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "Q", goal: "g", agentKind: "claude" });
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "waiting");
  const r = s.orch.run(t.id)!;
  expect(r.resumeAt).toBeGreaterThan(Date.now());
  s.advance(2 * 3600_000);
  await s.orch.tick();
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "done");
  expect(s.fake.calls.some((c) => c[1] === "prompt" && c[3].includes("quota est revenu"))).toBe(true);
});

test("ask_dan → en attente ; answer() relance l'agent avec la réponse", async () => {
  let n = 0;
  const s = await setup(async (a, p) => {
    n++;
    const taskId = (s.ctx.db.query("SELECT task_id FROM herdr_runs WHERE agent_name = ?").get(a.name) as any).task_id;
    if (n === 1) await s.ctx.tools.run("ask_dan", { question: "Je supprime la table ?", recommendation: "non" }, { userId: null, projectId: "demo", threadId: null, taskId, caller: "mcp" });
    else await s.ctx.tools.run("task_done", { summary: "fait", evidence: "ok" }, { userId: null, projectId: "demo", threadId: null, taskId, caller: "mcp" });
    a.status = "idle";
  });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "A", goal: "g", agentKind: "claude" });
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "waiting" && !!core.getTask(s.ctx, t.id)!.question);
  await Bun.sleep(100);
  expect(core.getTask(s.ctx, t.id)!.status).toBe("waiting"); // pas vérifiée pendant l'attente
  expect(s.notes.some((x) => x.level === "blocked")).toBe(true);
  await s.orch.answer(t.id, "non, garde-la", null);
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "done");
  expect(s.fake.calls.some((c) => c[1] === "prompt" && c[3].includes("garde-la"))).toBe(true);
});

test("escalade après 2 corrections (modèle supérieur), échec après 4", async () => {
  const s = await setup(async (a) => { a.output = "bof"; a.status = "idle"; }, { verdicts: Array(10).fill('{"verdict":"fix","reason":"toujours faux"}') });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "dur", goal: "g", agentKind: "claude", model: "sonnet", effort: "high" });
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "failed");
  const starts = s.fake.calls.filter((c) => c[1] === "start");
  expect(starts.length).toBe(2);
  expect(starts[0].join(" ")).toContain("--model sonnet");
  expect(starts[1].join(" ")).toContain("--model opus");
  expect(s.notes.some((n) => n.level === "alert")).toBe(true);
});

test("Codex : --yolo, effort TOML, MCP novabot sans jeton dans argv", async () => {
  const s = await setup(async (a) => { a.status = "idle"; });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "c", goal: "g", agentKind: "codex" });
  await waitFor(() => s.fake.calls.some((c) => c[1] === "start"));
  const st = s.fake.calls.find((c) => c[1] === "start")!.join(" ");
  expect(st).toContain("--kind codex");
  expect(st).toContain("-m gpt-6.1-sol -c model_reasoning_effort=\"high\" --yolo");
  expect(st).toContain("mcp_servers.novabot.args=");
  expect(st).not.toContain("tok-test");
  expect(s.fake.workspaces[0].env.NOVABOT_INTERNAL_TOKEN).toBe("tok-test");
  await s.orch.cancel(t.id);
  expect(core.getTask(s.ctx, t.id)!.status).toBe("cancelled");
});

test("reprise au redémarrage : agent disparu → relance avec --resume <session>", async () => {
  const s = await setup(async (a) => { a.status = "working"; });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "R", goal: "g", agentKind: "claude" });
  await waitFor(() => !!s.orch.run(t.id)?.sessionId);
  const sid = s.orch.run(t.id)!.sessionId!;
  s.orch.stop();
  s.fake.agents.clear(); // le daemon redémarre, l'agent a disparu
  const { Orchestrator } = await import("../src/orchestrator.ts");
  const o2 = new Orchestrator(s.ctx, { exec: s.fake.exec, pollMs: 50, waitMs: 1000, watchdogMs: 100000, resources: () => RES_OK, quotas: async () => ({ claude5h: 1, claude7d: 1, claudeReset: null, codex: 1, codexReset: null }) });
  await o2.start(); o2.stop();
  const resumed = s.fake.calls.filter((c) => c[1] === "start").pop()!;
  expect(resumed.slice(resumed.indexOf("--") + 1, resumed.indexOf("--") + 3)).toEqual(["--resume", sid]);
  expect((s.ctx.db.query("SELECT COUNT(*) n FROM task_events WHERE task_id = ? AND type = 'recovered'").get(t.id) as any).n).toBe(1);
});

test("projet sans dépôt git : pas de worktree, cwd = dossier du projet", async () => {
  const s = await setup(async (a) => { a.status = "working"; }, { noRepo: true });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "n", goal: "g", agentKind: "claude" });
  await waitFor(() => !!s.orch.run(t.id)?.agentName);
  const r = s.orch.run(t.id)!;
  expect(r.worktree).toBeNull(); expect(r.branch).toBeNull();
  await s.orch.cancel(t.id);
});

test("autonomie full : branche mergée par l'agent → worktree supprimé, workspace nb- refermé", async () => {
  const s = await setup(async (a) => {
    const taskId = (s.ctx.db.query("SELECT task_id FROM herdr_runs WHERE agent_name = ?").get(a.name) as any).task_id;
    const r = s.orch.run(taskId)!;
    Bun.spawnSync(["bash", "-c", `cd ${a.cwd} && echo x > x.txt && git add x.txt && git -c user.email=t@t -c user.name=t commit -qm x && cd ${r.repo} && git -c user.email=t@t -c user.name=t merge -q --no-ff ${r.branch} -m merge`]);
    await s.ctx.tools.run("task_done", { summary: "mergé", evidence: "git log main" }, { userId: null, projectId: "demo", threadId: null, taskId, caller: "mcp" });
    a.status = "idle";
  });
  const t = core.createTask(s.ctx, { projectId: "demo", title: "merge", goal: "g", agentKind: "claude" });
  await waitFor(() => core.getTask(s.ctx, t.id)!.status === "done" && s.fake.workspaces.length === 0);
  const r = s.orch.run(t.id)!;
  expect(existsSync(r.worktree!)).toBe(false);
  const ev = s.ctx.db.query("SELECT data FROM task_events WHERE task_id = ? AND type = 'worktree'").get(t.id) as any;
  expect(JSON.parse(ev.data).removed).toBe(true);
});
