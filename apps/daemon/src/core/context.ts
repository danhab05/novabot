import type { Hono } from "hono";
import type { DB } from "./db.ts";
import type { NovaEvent, ToolDef, ToolContext, Message, Task, User, Project, Thread } from "@novabot/shared";
import type { Config } from "./config.ts";

// ---------------- Bus d'évènements ----------------
type Listener = (e: NovaEvent) => void;
export class Bus {
  private listeners = new Set<Listener>();
  emit(e: NovaEvent) { for (const l of this.listeners) { try { l(e); } catch (err) { console.error("[bus] listener error", err); } } }
  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

// ---------------- Registre d'outils ----------------
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  register(t: ToolDef) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`nom d'outil invalide: ${t.name}`);
    this.tools.set(t.name, t);
  }
  unregister(name: string) { return this.tools.delete(name); }
  get(name: string) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }
  async run(name: string, input: unknown, ctx: ToolContext) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`outil inconnu: ${name}`);
    return t.run(input as any, ctx);
  }
}

// ---------------- Services inter-modules ----------------
// Chaque module remplit sa partie dans init(). Tous optionnels : le daemon doit démarrer même si un module manque.
export interface BrainService {
  /** Traite un message utilisateur (réponse, routage, création de tâches). Asynchrone, émet des évènements. */
  handleMessage(message: Message, thread: Thread, user: User | null): Promise<void>;
  /** Appel direct simple au modèle (résumé, extraction, vérification…). tier: fast|reason|critical */
  complete(req: { system?: string; prompt: string; tier?: "fast" | "reason" | "critical"; json?: boolean; provider?: "codex" | "claude" }): Promise<string>;
}
export interface OrchestratorService {
  submit(task: Task): void; // la tâche est déjà en base (status queued)
  cancel(taskId: string): Promise<void>;
  answer(taskId: string, answer: string, userId: string | null): Promise<void>; // réponse à ask_dan
  status(): { running: number; queued: number; resources: { memAvailMb: number; swapPct: number; load1: number } };
}
export interface MemoryService {
  search(q: string, opts?: { projectId?: string | null; limit?: number }): import("@novabot/shared").Memory[];
  write(m: { scope: "global" | "project"; projectId?: string | null; kind: import("@novabot/shared").MemoryKind; content: string; sourceMessageId?: string | null }, actor: string): import("@novabot/shared").Memory;
  contextFor(projectId: string | null): string; // SOUL + AGENTS + mémoire + handoff prêts à injecter
}
export interface NotifyService {
  /** Notifie le propriétaire (et membres du projet) : push PWA + Discord. */
  send(n: { title: string; body: string; url?: string; projectId?: string | null; level: "info" | "done" | "blocked" | "alert"; threadId?: string | null }): Promise<void>;
}
export interface VoiceService { stt(audio: Uint8Array, mime: string): Promise<string>; tts(text: string): Promise<Uint8Array> }
export interface Services {
  brain?: BrainService;
  orchestrator?: OrchestratorService;
  memory?: MemoryService;
  notify: NotifyService;
  voice?: VoiceService;
  /** Envoi sortant vers un canal (Discord…) quand un message assistant est posté. Rempli par le module discord. */
  outbound: Array<(m: Message, thread: Thread, project: Project | null) => Promise<void>>;
  /** Canaux de notification (push PWA, Discord…). Chaque module y ajoute le sien. */
  notifiers: Array<(n: Parameters<NotifyService["send"]>[0]) => Promise<void>>;
  /** Helper WebSocket Hono/Bun : services.upgradeWebSocket(c => ({ onMessage, onOpen, onClose })) */
  upgradeWebSocket: any;
  websocket: any;
  [k: string]: unknown;
}

export interface Ctx {
  db: DB;
  bus: Bus;
  tools: ToolRegistry;
  config: Config;
  services: Services;
  log: (mod: string, ...a: unknown[]) => void;
  /** Ajoute et diffuse un message (+ outbound vers canaux sauf celui d'origine). */
  postMessage(m: Omit<Message, "id" | "createdAt"> & { id?: string }): Message;
}

export interface Module {
  name: string;
  init(ctx: Ctx): void | Promise<void>;
  routes?(app: Hono<{ Variables: { user: User } }>, ctx: Ctx): void;
  /** Routes publiques (sans session) : /auth/*, /pub/* */
  publicRoutes?(app: Hono, ctx: Ctx): void;
  /** Appelé après init de tous les modules (pour démarrer boucles, connexions). */
  start?(ctx: Ctx): void | Promise<void>;
  stop?(): void | Promise<void>;
}
