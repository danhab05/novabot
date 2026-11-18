import { describe, expect, test } from "bun:test";
import { parseTermInput, sessionsFor } from "../src/lib/sessions";

describe("parseTermInput", () => {
  test("texte et Entrée", () => expect(parseTermInput("/help\r")).toEqual([{ text: "/help" }, { key: "enter" }]));
  test("flèches, Échap, Maj+Tab, Retour arrière", () =>
    expect(parseTermInput("\x1b[A\x1b[B\x1b\x1b[Z\x7f")).toEqual([{ key: "up" }, { key: "down" }, { key: "esc" }, { key: "shift+tab" }, { key: "backspace" }]));
  test("Ctrl+C et Tab", () => expect(parseTermInput("a\x03\tb")).toEqual([{ text: "a" }, { key: "ctrl+c" }, { key: "tab" }, { text: "b" }]));
  test("collage multi-caractères accentué", () => expect(parseTermInput("déjà vu")).toEqual([{ text: "déjà vu" }]));
});

test("sessionsFor filtre projet + type", () => {
  const s = (paneId: string, projectId: string | null, kind: string) => ({ paneId, projectId, kind, workspaceId: "w", name: null, status: "idle", cwd: "", title: "", novabot: false, sessionId: null, revision: 0 });
  const all = [s("a", "p1", "claude"), s("b", "p1", "codex"), s("c", "p2", "claude"), s("d", null, "claude")];
  expect(sessionsFor(all, "p1", "claude").map((x) => x.paneId)).toEqual(["a"]);
  expect(sessionsFor(all, "p1").length).toBe(2);
  expect(sessionsFor(null, "p1")).toEqual([]);
});
