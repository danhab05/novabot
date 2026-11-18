// Store minimal (sans dépendance) + reducer pur des évènements SSE (testable).
import { useSyncExternalStore } from "react";
import type { User, Folder, Project, Thread, Message, Task, NovaEvent } from "@novabot/shared";

export type Panel = "tasks" | "browser" | "terminal" | "sessions";
export type MobileTab = "projects" | "thread" | "tasks" | "browser" | "cockpit" | "sessions";
export type SessionKind = "claude" | "codex";
export interface SessionInfo {
  paneId: string; workspaceId: string; kind: string; name: string | null; status: string; cwd: string;
  title: string; novabot: boolean; sessionId: string | null; revision: number; projectId: string | null;
}
export interface Toast { id: string; title: string; body: string; level: "info" | "done" | "blocked" | "alert"; url?: string }

export interface State {
  authState: "loading" | "in" | "out";
  user: User | null;
  folders: Folder[];
  projects: Project[];
  features: string[];
  tasks: Record<string, Task>;
  /** fils par projet ("__global" pour les fils globaux) */
  threads: Record<string, Thread[]>;
  messages: Record<string, Message[]>;
  /** texte en cours de streaming par messageId */
  streaming: Record<string, { threadId: string; text: string }>;
  view: "thread" | "cockpit";
  projectId: string | null; // null = fil global Novabot
  threadId: string | null;
  panel: Panel;
  panelOpen: boolean;
  terminalTaskId: string | null;
  mobileTab: MobileTab;
  toasts: Toast[];
  connected: boolean;
  /** sessions agents Herdr (admin) ; null = pas encore chargé / indisponible */
  sessions: SessionInfo[] | null;
  sessionKind: SessionKind;
  sessionPane: string | null;
  paletteOpen: boolean;
  /** panneau droit élargi (terminal) */
  panelWide: boolean;
}

export const initialState: State = {
  authState: "loading", user: null, folders: [], projects: [], features: [], tasks: {}, threads: {}, messages: {}, streaming: {},
  view: "thread", projectId: null, threadId: null, panel: "tasks", panelOpen: true, terminalTaskId: null, mobileTab: "thread", toasts: [], connected: false,
  sessions: null, sessionKind: "claude", sessionPane: null, paletteOpen: false, panelWide: false,
};

export const projKey = (projectId: string | null) => projectId ?? "__global";

function upsertBy<T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i >= 0 ? list.map((x, j) => (j === i ? item : x)) : [...list, item];
  return sort ? next.sort(sort) : next;
}

/** Applique un évènement temps réel à l'état. Pur : renvoie un nouvel état (ou le même si rien ne change). */
export function applyEvent(s: State, e: NovaEvent): State {
  switch (e.type) {
    case "message": {
      const m = e.message;
      const list = s.messages[m.threadId];
      const streaming = { ...s.streaming };
      delete streaming[m.id];
      // fil inconnu localement mais pas chargé : on ne garde le message que si le fil est déjà en mémoire
      const messages = list ? { ...s.messages, [m.threadId]: upsertBy(list, m, (a, b) => a.createdAt - b.createdAt) } : s.messages;
      // remonter le fil en tête de son projet
      const k = projKey(e.projectId);
      const ths = s.threads[k];
      const threads = ths ? { ...s.threads, [k]: ths.map((t) => (t.id === m.threadId ? { ...t, updatedAt: m.createdAt } : t)).sort((a, b) => b.updatedAt - a.updatedAt) } : s.threads;
      return { ...s, messages, streaming, threads };
    }
    case "message.delta": {
      const cur = s.streaming[e.messageId];
      // déjà finalisé ?
      if (s.messages[e.threadId]?.some((m) => m.id === e.messageId)) return s;
      return { ...s, streaming: { ...s.streaming, [e.messageId]: { threadId: e.threadId, text: (cur?.text ?? "") + e.delta } } };
    }
    case "task":
      return { ...s, tasks: { ...s.tasks, [e.task.id]: e.task } };
    case "project":
      return { ...s, projects: upsertBy(s.projects, e.project, (a, b) => a.name.localeCompare(b.name)) };
    case "notify": {
      const t: Toast = { id: Math.random().toString(36).slice(2), title: e.title, body: e.body, level: e.level, url: e.url };
      return { ...s, toasts: [...s.toasts.slice(-3), t] };
    }
    default:
      return s;
  }
}

// ---------------- store ----------------
type Listener = () => void;
let state: State = initialState;
const listeners = new Set<Listener>();

export const store = {
  get: () => state,
  set(patch: Partial<State> | ((s: State) => Partial<State> | State)) {
    const p = typeof patch === "function" ? patch(state) : patch;
    if (p === state) return;
    state = { ...state, ...p };
    listeners.forEach((l) => l());
  },
  dispatch(e: NovaEvent) {
    const next = applyEvent(state, e);
    if (next !== state) { state = next; listeners.forEach((l) => l()); }
  },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** pour les tests */
  reset(s: State = initialState) { state = s; listeners.forEach((l) => l()); },
};

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state), () => sel(state));
}

export const dismissToast = (id: string) => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

/** Statut « agent » d'un projet pour la pastille de la sidebar. */
export function projectAgentState(tasks: Record<string, Task>, projectId: string | null): "blocked" | "waiting" | "running" | "queued" | null {
  let best: "blocked" | "waiting" | "running" | "queued" | null = null;
  const rank = { blocked: 4, waiting: 3, running: 2, queued: 1 } as const;
  for (const t of Object.values(tasks)) {
    if (t.projectId !== projectId) continue;
    const st = t.status === "verifying" ? "running" : t.status;
    if (st === "blocked" || st === "waiting" || st === "running" || st === "queued") {
      if (!best || rank[st] > rank[best]) best = st;
    }
  }
  return best;
}
