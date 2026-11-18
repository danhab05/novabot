// Sessions Claude Code / Codex ouvertes dans Herdr (API admin, packages/herdr/src/sessions.ts).
import { apiOptional, post, ApiError } from "./api";
import { store, type SessionInfo, type SessionKind } from "./store";

let timer: ReturnType<typeof setInterval> | null = null;

/** Recharge la liste globale des sessions (une seule requête pour la sidebar, l'entête et le panneau). */
export async function refreshSessions() {
  if (store.get().user?.role !== "admin") return;
  try {
    const list = await apiOptional<SessionInfo[]>("/api/sessions");
    store.set({ sessions: list ?? [] });
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) store.set({ sessions: [] });
  }
}

export function startSessionsPolling(ms = 10_000) {
  if (timer) return;
  refreshSessions();
  timer = setInterval(() => { if (!document.hidden) refreshSessions(); }, ms);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshSessions(); });
}

export const sessionsFor = (all: SessionInfo[] | null, projectId: string | null, kind?: SessionKind) =>
  (all ?? []).filter((s) => s.projectId === projectId && (!kind || s.kind === kind));

/** Ouvre le panneau des sessions d'un type pour le projet courant. */
export function openSessions(kind: SessionKind, paneId: string | null = null) {
  store.set({ sessionKind: kind, sessionPane: paneId, panel: "sessions", panelOpen: true, mobileTab: "sessions", view: "thread" });
  refreshSessions();
}

export async function createSession(projectId: string, kind: SessionKind) {
  const r = await post<{ paneId: string; name: string; kind: SessionKind }>(`/api/projects/${encodeURIComponent(projectId)}/sessions`, { kind });
  await refreshSessions();
  store.set({ sessionPane: r.paneId, sessionKind: kind });
  return r;
}

export const STATUS_COLOR: Record<string, string> = {
  working: "var(--info)", blocked: "var(--warn)", idle: "var(--ok)", done: "var(--fg3)", unknown: "var(--fg3)",
};
export const STATUS_LABEL: Record<string, string> = {
  working: "travaille", blocked: "attend une action", idle: "prête", done: "terminé", unknown: "inconnu",
};

// ---------- saisie terminal ----------
export type TermOp = { text: string } | { key: string };

const SEQ: [string, string][] = [
  ["\x1b[Z", "shift+tab"], ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
  ["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"],
  ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"], ["\x1b[H", "home"], ["\x1b[F", "end"],
  ["\r", "enter"], ["\n", "enter"], ["\t", "tab"], ["\x7f", "backspace"], ["\b", "backspace"], ["\x1b", "esc"],
];

/** Traduit les données brutes de xterm (onData) en opérations pour l'API : texte imprimable ou touche nommée. */
export function parseTermInput(data: string): TermOp[] {
  const ops: TermOp[] = [];
  let buf = "";
  const flush = () => { if (buf) { ops.push({ text: buf }); buf = ""; } };
  let i = 0;
  outer: while (i < data.length) {
    for (const [seq, key] of SEQ) {
      if (data.startsWith(seq, i)) { flush(); ops.push({ key }); i += seq.length; continue outer; }
    }
    const c = data.charCodeAt(i);
    if (c >= 1 && c <= 26) { flush(); ops.push({ key: `ctrl+${String.fromCharCode(96 + c)}` }); i++; continue; }
    if (c < 32) { i++; continue; } // autres contrôles ignorés
    buf += data[i++];
  }
  flush();
  // fusionne les textes consécutifs
  return ops.reduce<TermOp[]>((acc, op) => {
    const last = acc[acc.length - 1];
    if ("text" in op && last && "text" in last) last.text += op.text; else acc.push({ ...op });
    return acc;
  }, []);
}

/** File d'envoi séquentielle (l'ordre des frappes est préservé). */
export function createInputSender(paneId: string) {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = "";
  let t: ReturnType<typeof setTimeout> | null = null;
  const url = `/api/sessions/${encodeURIComponent(paneId)}/input`;
  const push = (body: { text?: string; keys?: string[] }) => { chain = chain.then(() => post(url, body)).catch(() => {}); return chain; };
  const flushText = () => { if (t) { clearTimeout(t); t = null; } if (pending) { const text = pending; pending = ""; push({ text }); } };
  return {
    send(op: TermOp) {
      if ("text" in op) { pending += op.text; if (t) clearTimeout(t); t = setTimeout(flushText, 80); return; }
      flushText();
      push({ keys: [op.key] });
    },
    text(text: string, submit = false) { flushText(); return push(submit ? { text, keys: ["enter"] } : { text }); },
    keys(keys: string[]) { flushText(); return push({ keys }); },
  };
}
