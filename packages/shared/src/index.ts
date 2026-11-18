// Contrats partagés de Novabot. Toute brique (daemon, modules, PWA) s'appuie sur ces types.
// Règle : ajouter des champs optionnels plutôt que casser un type existant.

export type Role = "admin" | "guest";
export interface User { id: string; discordId: string | null; name: string; avatar: string | null; role: Role }

export interface Folder { id: string; name: string; position: number }
export type Autonomy = "full" | "pr" | "readonly";
export interface Project {
  id: string; // slug, ex. "acme-site"
  name: string;
  folderId: string | null;
  path: string | null; // dossier local du dépôt
  stack: string | null;
  notes: string | null; // fiche projet (repris d'OpenBot)
  discordChannelId: string | null;
  autonomy: Autonomy;
  defaultAgent: AgentKind | null;
  createdAt: number;
}

export interface Thread { id: string; projectId: string | null; title: string; discordThreadId: string | null; createdAt: number; updatedAt: number }

export type MessageRole = "user" | "assistant" | "system" | "tool";
export interface Message {
  id: string; threadId: string; role: MessageRole; authorId: string | null; content: string;
  meta: Record<string, unknown> | null; // pièces jointes, vocal, taskId, source (discord|pwa|cron)…
  createdAt: number;
}

export type AgentKind = "claude" | "codex";
export type TaskStatus = "queued" | "running" | "verifying" | "waiting" | "blocked" | "done" | "failed" | "cancelled";
export interface Task {
  id: string; projectId: string | null; threadId: string | null; title: string; goal: string;
  doneCriteria: string | null; status: TaskStatus; priority: number; // 0 = prod cassée, 1 = demande du propriétaire, 2 = fond
  agentKind: AgentKind | null; model: string | null; effort: string | null; herdrAgent: string | null; herdrPane: string | null;
  branch: string | null; worktree: string | null; attempts: number; evidence: string | null; summary: string | null;
  question: string | null; // question ask_owner en attente
  createdBy: string | null; createdAt: number; updatedAt: number; finishedAt: number | null;
}
export interface TaskEvent { id: string; taskId: string; type: string; data: Record<string, unknown> | null; createdAt: number }

export type MemoryScope = "global" | "project";
export type MemoryKind = "fact" | "decision" | "preference" | "pitfall";
export interface Memory {
  id: string; scope: MemoryScope; projectId: string | null; kind: MemoryKind; content: string;
  sourceMessageId: string | null; pinned: boolean; createdAt: number; updatedAt: number;
}
export interface MemoryJournalEntry { id: string; memoryId: string; action: "create" | "update" | "delete" | "pin" | "unpin"; before: string | null; after: string | null; actor: string; createdAt: number }

export interface Cron { id: string; name: string; schedule: string | null; onceAt: number | null; prompt: string; projectId: string | null; enabled: boolean; lastRun: number | null; nextRun: number | null }
export interface HealthCheck { id: string; kind: "http" | "coolify" | "cron" | "service"; target: string; status: "ok" | "warn" | "down"; detail: string | null; checkedAt: number }
export interface Idea { id: string; projectId: string | null; title: string; body: string; status: "new" | "accepted" | "dismissed"; createdAt: number }
export interface SkillProposal { id: string; name: string; content: string; status: "pending" | "accepted" | "rejected"; taskId: string | null; createdAt: number }

export type CatalogType = "mcp" | "skill" | "agent";
export interface CatalogManifest {
  id: string; type: CatalogType; name: string; version: string; description: string;
  author?: string; permissions?: string[]; secrets?: { key: string; label: string }[];
  mcp?: { command: string; args?: string[]; env?: Record<string, string>; url?: string };
  skill?: { files: Record<string, string> }; // chemin relatif -> contenu
  agent?: { instructions: string; defaultAgent?: AgentKind; skills?: string[]; mcp?: string[] };
}
export interface CatalogItem { id: string; manifest: CatalogManifest; installed: boolean; source: "local" | "public" | "hermes" | "openbot"; published: boolean }

export interface Quota { provider: "claude" | "codex"; window: "5h" | "7d"; usedPct: number; resetsAt: number | null; updatedAt: number }

// ---- Évènements temps réel (SSE /api/events) ----
export type NovaEvent =
  | { type: "message"; message: Message; projectId: string | null }
  | { type: "message.delta"; threadId: string; messageId: string; delta: string; projectId: string | null; tool?: { name: string; input: unknown } }
  | { type: "task"; task: Task }
  | { type: "task.event"; event: TaskEvent; projectId: string | null }
  | { type: "memory"; memory: Memory; action: MemoryJournalEntry["action"] }
  | { type: "health"; check: HealthCheck }
  | { type: "quota"; quota: Quota }
  | { type: "notify"; title: string; body: string; url?: string; projectId: string | null; level: "info" | "done" | "blocked" | "alert" }
  | { type: "idea"; idea: Idea }
  | { type: "skill.proposal"; proposal: SkillProposal }
  | { type: "project"; project: Project };

// ---- Protocole navigateur live (WebSocket /api/browser/ws) ----
export type BrowserClientMsg =
  | { t: "list" }
  | { t: "watch"; targetId: string; maxWidth?: number; quality?: number }
  | { t: "unwatch" }
  | { t: "mouse"; kind: "down" | "up" | "move" | "wheel"; x: number; y: number; button?: "left" | "right"; deltaY?: number; clickCount?: number }
  | { t: "key"; kind: "down" | "up" | "char"; key: string; code?: string; text?: string }
  | { t: "type"; text: string }
  | { t: "navigate"; url: string }
  | { t: "takeover"; on: boolean };
export type BrowserServerMsg =
  | { t: "tabs"; tabs: { targetId: string; title: string; url: string; owner?: string | null }[] }
  | { t: "frame"; data: string; width: number; height: number } // data = JPEG base64
  | { t: "takeover"; on: boolean; by: string | null }
  | { t: "error"; message: string };

// ---- Outils (registre partagé : cerveau natif + MCP pour les agents Herdr) ----
export interface ToolContext { userId: string | null; projectId: string | null; threadId: string | null; taskId: string | null; caller: "brain" | "mcp" }
export interface ToolDef<I = any> {
  name: string; // ex. "memory_search"
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  /** reserved = action réservée au propriétaire (suppression, DNS, billing, secrets, envoi en son nom) → passe par ask_owner */
  reserved?: boolean;
  run(input: I, ctx: ToolContext): Promise<unknown>;
}

export const id = (prefix = ""): string => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
export const now = (): number => Date.now();
