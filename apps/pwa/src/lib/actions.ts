// Actions applicatives : chargement, navigation, envoi. Tout passe par le store.
import type { Folder, Project, Task, Thread, Message, User, NovaEvent } from "@novabot/shared";
import { api, post, setUnauthorizedHandler, ApiError } from "./api";
import { store, projKey, type MobileTab, type Panel } from "./store";
import { cacheGet, cacheSet } from "./cache";

interface Boot { user: User; folders: Folder[]; projects: Project[]; activeTasks: Task[]; features: string[] }

setUnauthorizedHandler(() => store.set({ authState: "out" }));

export async function boot() {
  const cached = cacheGet<Boot>("boot");
  if (cached) applyBoot(cached, true);
  try {
    const b = await api<Boot>("/api/bootstrap");
    cacheSet("boot", b);
    applyBoot(b, false);
    const s = store.get();
    await openProject(s.projectId, { keepTab: true });
    connectEvents();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) store.set({ authState: "out" });
    else if (!cached) store.set({ authState: "out" });
  }
}

function applyBoot(b: Boot, fromCache: boolean) {
  const tasks: Record<string, Task> = fromCache ? {} : { ...store.get().tasks };
  for (const t of b.activeTasks) tasks[t.id] = t;
  const last = cacheGet<{ projectId: string | null }>("nav");
  store.set({
    authState: "in", user: b.user, folders: b.folders, projects: b.projects, features: b.features ?? [], tasks,
    projectId: store.get().threadId ? store.get().projectId : (last?.projectId ?? null),
  });
}

// ---------- temps réel ----------
let es: EventSource | null = null;
let retry = 0;
export function connectEvents() {
  es?.close();
  es = new EventSource("/api/events", { withCredentials: true });
  es.addEventListener("hello", () => {
    const wasDown = retry > 0;
    retry = 0;
    store.set({ connected: true });
    if (wasDown) resync();
  });
  es.addEventListener("nova", (ev) => {
    try { store.dispatch(JSON.parse((ev as MessageEvent).data) as NovaEvent); } catch {}
    persistCurrentThread();
  });
  es.onerror = () => {
    store.set({ connected: false });
    es?.close(); es = null;
    retry++;
    setTimeout(connectEvents, Math.min(30_000, 1000 * 2 ** Math.min(retry, 5)));
  };
}

/** Après une coupure : on recharge ce qui a pu être manqué. */
async function resync() {
  try {
    const b = await api<Boot>("/api/bootstrap");
    cacheSet("boot", b);
    applyBoot(b, false);
    const tid = store.get().threadId;
    if (tid) await loadMessages(tid);
  } catch {}
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistCurrentThread() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const s = store.get();
    if (s.threadId && s.messages[s.threadId]) cacheSet("msgs:" + s.threadId, s.messages[s.threadId].slice(-50));
  }, 1500);
}

// ---------- navigation ----------
export async function openProject(projectId: string | null, o: { keepTab?: boolean } = {}) {
  cacheSet("nav", { projectId });
  store.set({ projectId, view: "thread", ...(o.keepTab ? {} : { mobileTab: "thread" as MobileTab }) });
  const k = projKey(projectId);
  let threads = store.get().threads[k];
  if (!threads) {
    const cached = cacheGet<Thread[]>("threads:" + k);
    if (cached) store.set((s) => ({ threads: { ...s.threads, [k]: cached } }));
    try {
      threads = await api<Thread[]>(`/api/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
      if (!threads.length) threads = [await post<Thread>("/api/threads", { projectId, title: projectId ? "Général" : "Novabot" })];
      cacheSet("threads:" + k, threads);
      store.set((s) => ({ threads: { ...s.threads, [k]: threads! } }));
    } catch { threads = cached ?? []; }
  }
  if (store.get().projectId !== projectId) return; // l'utilisateur a changé entre-temps
  const main = threads.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
  if (main) await openThread(main.id);
  else store.set({ threadId: null });
  if (projectId) loadProjectTasks(projectId).catch(() => {});
}

export async function openThread(threadId: string) {
  store.set({ threadId });
  if (!store.get().messages[threadId]) {
    const cached = cacheGet<Message[]>("msgs:" + threadId);
    if (cached) store.set((s) => ({ messages: { ...s.messages, [threadId]: cached } }));
  }
  await loadMessages(threadId);
}

export async function loadMessages(threadId: string) {
  try {
    const list = await api<Message[]>(`/api/threads/${threadId}/messages`);
    store.set((s) => ({ messages: { ...s.messages, [threadId]: list } }));
    cacheSet("msgs:" + threadId, list.slice(-50));
  } catch {}
}

export async function loadOlder(threadId: string) {
  const cur = store.get().messages[threadId] ?? [];
  if (!cur.length) return 0;
  const older = await api<Message[]>(`/api/threads/${threadId}/messages?before=${cur[0].createdAt}`);
  if (older.length) store.set((s) => ({ messages: { ...s.messages, [threadId]: [...older, ...(s.messages[threadId] ?? [])] } }));
  return older.length;
}

export async function newThread(title = "Nouvelle conversation") {
  const { projectId } = store.get();
  const t = await post<Thread>("/api/threads", { projectId, title });
  const k = projKey(projectId);
  store.set((s) => ({ threads: { ...s.threads, [k]: [t, ...(s.threads[k] ?? [])] }, messages: { ...s.messages, [t.id]: [] } }));
  await openThread(t.id);
}

export async function loadProjectTasks(projectId: string) {
  const list = await api<Task[]>(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
  store.set((s) => { const tasks = { ...s.tasks }; for (const t of list) tasks[t.id] = t; return { tasks }; });
}

export async function loadAllTasks() {
  const list = await api<Task[]>(`/api/tasks`);
  store.set((s) => { const tasks = { ...s.tasks }; for (const t of list) tasks[t.id] = t; return { tasks }; });
  return list;
}

export async function sendMessage(content: string, meta?: Record<string, unknown>) {
  const { threadId } = store.get();
  if (!threadId) return;
  const m = await post<Message>(`/api/threads/${threadId}/messages`, { content, meta });
  store.set((s) => {
    const list = s.messages[threadId] ?? [];
    return list.some((x) => x.id === m.id) ? {} : { messages: { ...s.messages, [threadId]: [...list, m] } };
  });
}

export const cancelTask = (id: string) => post(`/api/tasks/${id}/cancel`);
export const answerTask = (id: string, answer: string) => post(`/api/tasks/${id}/answer`, { answer });

export const setPanel = (panel: Panel) => store.set({ panel, panelOpen: true });
export const setMobileTab = (mobileTab: MobileTab) => store.set({ mobileTab, view: mobileTab === "cockpit" ? "cockpit" : "thread" });
export const openTerminal = (taskId: string) => store.set({ terminalTaskId: taskId, panel: "terminal", panelOpen: true, mobileTab: "tasks" });

export async function logout() {
  try { await post("/api/auth/logout"); } catch {}
  try { localStorage.clear(); } catch {}
  location.reload();
}

/** Ouvre un lien interne (/tasks/<id>, /p/<projet>) — utilisé par les notifs push et les toasts. */
export async function openDeepLink(path: string) {
  const t = path.match(/^\/tasks\/([\w-]+)/);
  const p = path.match(/^\/p\/([\w-]+)/);
  if (!t && !p) return false;
  history.replaceState(null, "", "/");
  if (p) { await openProject(p[1]); return true; }
  try {
    const { task } = await api<{ task: Task }>(`/api/tasks/${t![1]}`);
    store.set((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
    await openProject(task.projectId);
    if (task.threadId) await openThread(task.threadId);
    store.set({ panel: "tasks", panelOpen: true });
  } catch {}
  return true;
}
