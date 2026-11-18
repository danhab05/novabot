import { describe, expect, test, beforeEach } from "bun:test";
import { applyEvent, initialState, store, projectAgentState, type State } from "../src/lib/store";
import type { Message, Task, Thread } from "@novabot/shared";

const msg = (id: string, threadId: string, createdAt: number, content = "x"): Message => ({ id, threadId, role: "assistant", authorId: null, content, meta: null, createdAt });
const task = (id: string, status: Task["status"], projectId: string | null = "p1"): Task => ({
  id, projectId, threadId: "t1", title: id, goal: "", doneCriteria: null, status, priority: 1, agentKind: "claude", model: null, effort: null,
  herdrAgent: null, herdrPane: null, branch: null, worktree: null, attempts: 0, evidence: null, summary: null, question: null, createdBy: null, createdAt: 1, updatedAt: 1, finishedAt: null,
});

describe("applyEvent", () => {
  let s: State;
  beforeEach(() => { s = { ...initialState, messages: { t1: [msg("a", "t1", 1)] }, threads: { p1: [{ id: "t1", projectId: "p1", title: "G", discordThreadId: null, createdAt: 0, updatedAt: 0 } as Thread] } }; });

  test("message ajouté dans l'ordre chronologique, sans doublon", () => {
    let n = applyEvent(s, { type: "message", message: msg("c", "t1", 3), projectId: "p1" });
    n = applyEvent(n, { type: "message", message: msg("b", "t1", 2), projectId: "p1" });
    n = applyEvent(n, { type: "message", message: msg("b", "t1", 2, "maj"), projectId: "p1" });
    expect(n.messages.t1.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(n.messages.t1[1].content).toBe("maj");
    expect(n.threads.p1[0].updatedAt).toBe(2);
  });

  test("message d'un fil non chargé ignoré", () => {
    const n = applyEvent(s, { type: "message", message: msg("z", "t9", 5), projectId: "p1" });
    expect(n.messages.t9).toBeUndefined();
  });

  test("streaming : deltas cumulés puis remplacés par le message final", () => {
    let n = applyEvent(s, { type: "message.delta", threadId: "t1", messageId: "m1", delta: "Bon", projectId: "p1" });
    n = applyEvent(n, { type: "message.delta", threadId: "t1", messageId: "m1", delta: "jour", projectId: "p1" });
    expect(n.streaming.m1.text).toBe("Bonjour");
    n = applyEvent(n, { type: "message", message: msg("m1", "t1", 9, "Bonjour !"), projectId: "p1" });
    expect(n.streaming.m1).toBeUndefined();
    expect(n.messages.t1.at(-1)!.content).toBe("Bonjour !");
    // delta tardif après finalisation : ignoré
    const n2 = applyEvent(n, { type: "message.delta", threadId: "t1", messageId: "m1", delta: "x", projectId: "p1" });
    expect(n2).toBe(n);
  });

  test("tâche : upsert et statut agent du projet", () => {
    let n = applyEvent(s, { type: "task", task: task("k1", "running") });
    n = applyEvent(n, { type: "task", task: task("k2", "waiting") });
    expect(projectAgentState(n.tasks, "p1")).toBe("waiting");
    n = applyEvent(n, { type: "task", task: task("k2", "done") });
    expect(projectAgentState(n.tasks, "p1")).toBe("running");
    expect(projectAgentState(n.tasks, "p2")).toBeNull();
  });

  test("notify -> toast (max 4)", () => {
    let n = s;
    for (let i = 0; i < 6; i++) n = applyEvent(n, { type: "notify", title: "T" + i, body: "", level: "info", projectId: null });
    expect(n.toasts.length).toBe(4);
    expect(n.toasts.at(-1)!.title).toBe("T5");
  });

  test("évènement inconnu : état inchangé", () => {
    expect(applyEvent(s, { type: "quota", quota: { provider: "claude", window: "5h", usedPct: 1, resetsAt: null, updatedAt: 1 } })).toBe(s);
  });
});

describe("store", () => {
  test("dispatch notifie les abonnés seulement si l'état change", () => {
    store.reset();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: "quota", quota: { provider: "claude", window: "5h", usedPct: 1, resetsAt: null, updatedAt: 1 } });
    expect(calls).toBe(0);
    store.dispatch({ type: "task", task: task("k1", "queued") });
    expect(calls).toBe(1);
    expect(store.get().tasks.k1.status).toBe("queued");
    off();
  });
});
