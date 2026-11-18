import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Répertoire de données isolé AVANT d'importer le daemon (config lue à l'import).
const DATA = mkdtempSync(join(tmpdir(), "nb-brain-"));
process.env.NOVABOT_DATA = DATA;
process.env.NOVABOT_INTERNAL_TOKEN = "t";
process.env.NOVABOT_HERMES_DIR = join(DATA, "hermes");
process.env.NOVABOT_VENV ??= join(process.env.HOME ?? "", ".novabot/venv");
process.env.NOVABOT_OWNER_NAME = "Alice";

const { parseSSE, extractJson } = await import("../src/util.ts");
const { orderProviders, saturation } = await import("../src/router.ts");
const { codexModels } = await import("../src/providers/codex.ts");
const memMod = (await import("../src/memory.ts"));
const brainMod = await import("../src/index.ts");
const { createApp } = await import("../../../apps/daemon/src/index.ts");

function sse(chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
}

test("parseSSE gère les évènements coupés entre deux chunks", async () => {
  const out: any[] = [];
  for await (const e of parseSSE(sse(["event: a\ndata: {\"x\"", ":1}\n\nevent: b\r\ndata: 2\r\n\r\n", "data: 3\n\n"]))) out.push(e);
  expect(out).toEqual([{ event: "a", data: '{"x":1}' }, { event: "b", data: "2" }, { event: "message", data: "3" }]);
});

test("extractJson tolère les blocs ```json et le texte autour", () => {
  expect(extractJson('Voici :\n```json\n{"memories":[{"a":1}]}\n```')).toEqual({ memories: [{ a: 1 }] });
  expect(extractJson("rien")).toBeNull();
});

test("router : quota 5 h ≥ 85 % bascule vers l'autre famille", () => {
  const future = Date.now() + 3600_000;
  expect(orderProviders([], ["codex", "claude"])).toEqual(["codex", "claude"]);
  expect(orderProviders([{ provider: "codex", window: "5h", usedPct: 90, resetsAt: future }], ["codex", "claude"])).toEqual(["claude", "codex"]);
  expect(orderProviders([{ provider: "codex", window: "7d", usedPct: 80, resetsAt: future }], ["codex", "claude"])).toEqual(["codex", "claude"]);
  // reset passé = ignoré
  expect(saturation([{ provider: "codex", window: "5h", usedPct: 99, resetsAt: Date.now() - 1 }], "codex")).toBe(0);
  // les deux saturés → le moins chargé
  expect(orderProviders([{ provider: "codex", window: "5h", usedPct: 99, resetsAt: future }, { provider: "claude", window: "5h", usedPct: 88, resetsAt: future }], ["codex", "claude"])).toEqual(["claude", "codex"]);
});

test("codexModels prend la version la plus récente de chaque famille", () => {
  const f = join(DATA, "models_cache.json");
  writeFileSync(f, JSON.stringify({ models: ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-luna", "gpt-5.6-luna", "gpt-6-astra", "gpt-6.2-astra", "gpt-6.1-terra"].map((slug) => ({ slug })) }));
  expect(codexModels(f)).toEqual({ fast: "gpt-6-luna", reason: "gpt-6.2-sol", critical: "gpt-6.2-astra" });
});

test("splitHermesMemory : séparateurs § et sections ##", () => {
  expect(memMod.splitHermesMemory("Première entrée assez longue pour compter.\n§\nDeuxième entrée assez longue elle aussi.")).toHaveLength(2);
  expect(memMod.splitHermesMemory("# Titre\nintro courte\n## A\ncontenu de la section A suffisamment long\n## B\ncontenu de la section B suffisamment long")).toHaveLength(2);
});

let app: any, ctx: any;
beforeAll(async () => {
  // faux Hermes pour l'import
  const h = process.env.NOVABOT_HERMES_DIR!; mkdirSync(join(h, "memories"), { recursive: true }); mkdirSync(join(h, "project-memory"), { recursive: true });
  writeFileSync(join(h, "memories", "MEMORY.md"), "Alice préfère le tutoiement dans toutes les réponses.\n§\nLe serveur de test a 8 vCPU et 22 Go de RAM.");
  // module mémoire seul + brain avec faux fournisseurs (injectés après init)
  ({ app, ctx } = await createApp({ dbPath: ":memory:", modules: [memMod.default, brainMod.default] }));
});

const H = { authorization: "Bearer t", "content-type": "application/json" };

test("mémoire : import Hermes, recherche sans accents, journal, patch, delete", async () => {
  const found = ctx.services.memory.search("prefere tutoiement");
  expect(found.length).toBe(1);
  const created = await (await app.request("/api/memories", { method: "POST", headers: H, body: JSON.stringify({ scope: "global", kind: "decision", content: "Novabot tourne sur le serveur OVH." }) })).json();
  expect(created.id).toBeTruthy();
  const p = await (await app.request(`/api/memories/${created.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ pinned: true }) })).json();
  expect(p.pinned).toBe(true);
  await app.request(`/api/memories/${created.id}`, { method: "DELETE", headers: H });
  const j = await (await app.request("/api/memory/journal", { headers: H })).json();
  expect(j.map((e: any) => e.action).slice(0, 3)).toEqual(["delete", "pin", "create"]);
  expect(ctx.services.memory.contextFor(null)).toContain("tutoiement");
});

test("outils mémoire + handoff via le registre", async () => {
  ctx.db.query("INSERT INTO projects (id, name, autonomy, created_at) VALUES ('demo', 'Démo', 'full', 1)").run();
  await ctx.tools.run("memory_write", { content: "Démo se déploie sur Kubernetes.", kind: "fact" }, { projectId: "demo", caller: "mcp" });
  const r = await ctx.tools.run("memory_search", { query: "kubernetes" }, { projectId: "demo", caller: "mcp" });
  expect(r[0].projectId).toBe("demo");
  await ctx.tools.run("handoff_write", { content: "# Passation\nÉtat : OK" }, { projectId: "demo", caller: "mcp" });
  expect(await ctx.tools.run("handoff_read", {}, { projectId: "demo", caller: "mcp" })).toContain("État : OK");
  expect(ctx.services.memory.contextFor("demo")).toContain("Passation");
});

test("cerveau : boucle d'outils, streaming, message final, outil réservé bloqué pour un invité", async () => {
  const deltas: string[] = [];
  const off = ctx.bus.on((e: any) => { if (e.type === "message.delta" && e.delta) deltas.push(e.delta); });
  let sawTools: string[] = [];
  const fake = (pid: "codex" | "claude") => ({
    id: pid, model: () => "fake", available: async () => ({ ok: true }),
    complete: async () => ({ text: '{"memories":[]}', model: "fake" }),
    agentTurn: async (req: any) => {
      sawTools = req.tools.map((t: any) => t.name);
      const r = await req.runTool("project_list", {});
      req.onDelta?.("Il y a ");
      req.onDelta?.(`${r.length} projet(s).`);
      return { text: `Il y a ${r.length} projet(s).`, model: "fake", provider: pid, toolCalls: [{ name: "project_list", input: {}, ok: true }] };
    },
  });
  const b = brainMod.createBrain(ctx, { codex: fake("codex") as any, claude: fake("claude") as any }, null);
  const th = { id: "t_x", projectId: "demo", title: "x", discordThreadId: null, createdAt: 1, updatedAt: 1 };
  ctx.db.query("INSERT INTO threads (id, project_id, title, created_at, updated_at) VALUES ('t_x','demo','x',1,1)").run();
  const m = ctx.postMessage({ threadId: "t_x", role: "user", authorId: null, content: "combien de projets ?", meta: { source: "pwa" } });
  await b.handleMessage(m, th, { id: "u1", role: "admin", name: "Alice", discordId: null, avatar: null });
  off();
  expect(sawTools).toContain("task_create");
  expect(sawTools).not.toContain("message_post");
  expect(deltas.join("")).toBe("Il y a 1 projet(s).");
  const last = ctx.db.query("SELECT * FROM messages WHERE thread_id = 't_x' ORDER BY created_at DESC LIMIT 1").get() as any;
  expect(last.role).toBe("assistant");
  expect(JSON.parse(last.meta).provider).toBe("codex");

  // outil réservé refusé pour un invité
  ctx.tools.register({ name: "dns_change", description: "x", inputSchema: { type: "object" }, reserved: true, run: async () => "fait" });
  let err = "";
  const fake2 = { ...fake("codex"), agentTurn: async (req: any) => { try { await req.runTool("dns_change", {}); } catch (e: any) { err = e.message; } return { text: "ok", model: "f", provider: "codex", toolCalls: [] }; } };
  const b2 = brainMod.createBrain(ctx, { codex: fake2 as any, claude: fake2 as any }, null);
  await b2.handleMessage(m, th, { id: "u2", role: "guest", name: "Bob", discordId: null, avatar: null });
  expect(err).toContain("ask_owner");
});

test("cerveau : bascule vers Claude si Codex échoue", async () => {
  const bad = { id: "codex", model: () => "x", available: async () => ({ ok: true }), complete: async () => { throw Object.assign(new Error("429"), { retryable: true }); }, agentTurn: async () => { throw new Error("x"); } };
  const good = { id: "claude", model: () => "haiku", available: async () => ({ ok: true }), complete: async () => ({ text: "ok", model: "haiku" }), agentTurn: async () => ({}) };
  const b = brainMod.createBrain(ctx, { codex: bad as any, claude: good as any }, null);
  expect(await b.complete({ prompt: "x" })).toBe("ok");
});

test("skill : proposition puis acceptation écrit SKILL.md et le lien Codex", async () => {
  const r = await ctx.tools.run("skill_propose", { name: "Déploiement Acme", description: "Déployer une app", content: "1. push\n2. vérifier" }, { caller: "brain", taskId: null, projectId: null, threadId: null });
  const p = ctx.db.query("SELECT * FROM skill_proposals WHERE id = ?").get(r.proposalId) as any;
  const sk = join(DATA, "skills"), cx = join(DATA, "codex-skills"); mkdirSync(cx, { recursive: true });
  const dir = brainMod.acceptSkill({ ...p, content: p.content }, sk, cx);
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("name: deploiement-acme");
  expect(existsSync(join(cx, "deploiement-acme", "SKILL.md"))).toBe(true);
});

test("uploads : envoi puis lecture", async () => {
  const fd = new FormData(); fd.append("file", new File(["bonjour"], "note.txt", { type: "text/plain" }));
  const up = await (await app.request("/api/uploads", { method: "POST", headers: { authorization: "Bearer t" }, body: fd })).json();
  expect(up.url).toStartWith("/api/uploads/");
  expect(await (await app.request(up.url, { headers: { authorization: "Bearer t" } })).text()).toBe("bonjour");
});

// ---- Tests réels (abonnements) : NOVABOT_REAL=1 bun test packages/brain ----
const REAL = process.env.NOVABOT_REAL === "1";
test.if(REAL)("RÉEL : Codex OAuth complete() → ok", async () => {
  const { CodexProvider } = await import("../src/providers/codex.ts");
  const q: any[] = [];
  const r = await new CodexProvider((...a) => q.push(a)).complete({ prompt: "Réponds uniquement par le mot : ok", tier: "fast" });
  console.log("codex:", r);
  expect(r.text.toLowerCase()).toContain("ok");
  expect(q.length).toBeGreaterThan(0);
}, 60_000);
test.if(REAL)("RÉEL : Codex agentTurn avec un outil", async () => {
  const { CodexProvider } = await import("../src/providers/codex.ts");
  const calls: string[] = [];
  const r = await new CodexProvider().agentTurn({
    system: "Tu es un assistant. Utilise l'outil heure pour répondre.", tier: "fast", history: [{ role: "user", text: "Quelle heure est-il ? Utilise l'outil." }],
    tools: [{ name: "heure", description: "Donne l'heure", inputSchema: { type: "object", properties: {} }, run: async () => "" }],
    toolCtx: { userId: null, projectId: null, threadId: null, taskId: null, caller: "brain" },
    runTool: async (n) => { calls.push(n); return "14h37"; },
  });
  console.log("codex tool:", r.text);
  expect(calls).toEqual(["heure"]);
  expect(r.text).toContain("14");
}, 90_000);
test.if(REAL)("RÉEL : Claude CLI (haiku) complete() → ok", async () => {
  const { ClaudeProvider } = await import("../src/providers/claude.ts");
  const q: any[] = [];
  const r = await new ClaudeProvider({ daemonUrl: "http://127.0.0.1:1", internalToken: "x", quota: (...a) => q.push(a) }).complete({ prompt: "Réponds uniquement par le mot : ok", tier: "fast" });
  console.log("claude:", r, "quotas:", q);
  expect(r.text.toLowerCase()).toContain("ok");
}, 90_000);
test.if(REAL)("RÉEL : TTS Edge + STT faster-whisper (aller-retour)", async () => {
  const { createVoice } = await import("../src/voice.ts");
  const v = createVoice();
  const mp3 = await v.tts("Bonjour Alice, ceci est un test de Novabot.");
  expect(mp3.length).toBeGreaterThan(5000);
  const t = await v.stt(mp3, "audio/mpeg");
  console.log("stt:", t);
  expect(t.toLowerCase()).toContain("novabot".slice(0, 4));
}, 300_000);
