import { test, expect } from "bun:test";
import { choose, resourceBlock, DEFAULT_LIMITS, levelOf, isCritical, LIMIT_RE } from "../src/policy.ts";

const Q0 = { claude5h: 10, claude7d: 10, claudeReset: null, codex: 10, codexReset: null };
const T = (o: any = {}) => ({ title: "t", goal: "g", priority: 1, agentKind: null, model: null, effort: null, ...o });

test("choix par défaut : Claude sonnet high", () => {
  expect(choose(T(), Q0)).toMatchObject({ kind: "claude", model: "sonnet", effort: "high" });
});
test("tâche bornée de tests → Codex", () => {
  expect(choose(T({ goal: "écris les tests du parser" }), Q0).kind).toBe("codex");
});
test("sécurité / architecture → niveau 3", () => {
  expect(choose(T({ goal: "audit de sécurité" }), Q0).model).toBe("opus");
});
test("quota Claude 5 h ≥ 85 % → bascule Codex ; les deux chauds → reste", () => {
  expect(choose(T(), { ...Q0, claude5h: 90 }).kind).toBe("codex");
  expect(choose(T(), { ...Q0, claude5h: 90, codex: 93 }).kind).toBe("claude");
});
test("agent imposé respecté malgré quotas", () => {
  expect(choose(T({ agentKind: "claude" }), { ...Q0, claude5h: 99 }).kind).toBe("claude");
});
test("escalade : sonnet → opus ; fable → change de famille", () => {
  expect(choose(T({ agentKind: "claude", model: "sonnet" }), Q0, 2).model).toBe("opus");
  expect(choose(T({ agentKind: "claude", model: "fable" }), Q0, 2).kind).toBe("codex");
});
test("ressources", () => {
  const L = DEFAULT_LIMITS;
  expect(resourceBlock({ memAvailMb: 8000, swapPct: 10, load1: 1 }, L, 1, 0)).toBeNull();
  expect(resourceBlock({ memAvailMb: 2000, swapPct: 10, load1: 1 }, L, 1, 0)).toContain("RAM");
  expect(resourceBlock({ memAvailMb: 8000, swapPct: 90, load1: 1 }, L, 1, 0)).toContain("swap");
  expect(resourceBlock({ memAvailMb: 8000, swapPct: 10, load1: 9 }, L, 1, 0)).toContain("charge");
  expect(resourceBlock({ memAvailMb: 8000, swapPct: 10, load1: 9 }, L, 0, 0)).toBeNull();
  expect(resourceBlock({ memAvailMb: 8000, swapPct: 10, load1: 1 }, L, 0, 4)).toContain("max");
});
test("niveaux / critique / détection limite", () => {
  expect(levelOf("gpt-6-astra", "max")).toBe(4);
  expect(isCritical({ model: "opus", effort: "high", priority: 1 })).toBe(true);
  expect(isCritical({ model: "haiku", effort: "low", priority: 1 })).toBe(false);
  expect(LIMIT_RE.test("You've hit your limit · resets 3pm")).toBe(true);
  expect(LIMIT_RE.test("all good")).toBe(false);
});
