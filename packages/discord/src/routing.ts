// Logique Discord indépendante de discord.js (testable avec un faux client).
import type { Ctx } from "@novabot/daemon/core";
import { fromRow, insert, mainThread, createThread, dispatchToBrain, canAccessProject, upsertDiscordUser, ensureModuleSchema } from "@novabot/daemon/core";
import type { Project, Thread, User, Message, Task } from "@novabot/shared";
import { now } from "@novabot/shared";

export interface IncomingMsg {
  id: string;
  channelId: string; // salon (ou thread) où le message est posté
  parentId: string | null; // salon parent si le message est dans un thread Discord
  isThread: boolean;
  authorId: string; authorName: string; authorAvatar: string | null; isBot: boolean;
  content: string;
  attachments: { url: string; name: string; contentType: string | null }[];
}

export function ensureSchema(ctx: Ctx) {
  ensureModuleSchema(ctx.db, "discord", 1, `
    CREATE TABLE discord_task_threads (task_id TEXT PRIMARY KEY, discord_thread_id TEXT NOT NULL, channel_id TEXT NOT NULL, last_name TEXT, created_at INTEGER NOT NULL);
  `);
}

export const getSetting = (ctx: Ctx, k: string): string | null => (ctx.db.query("SELECT value FROM settings WHERE key = ?").get(k) as any)?.value ?? null;
export const setSetting = (ctx: Ctx, k: string, v: string) => ctx.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

export function projectByChannel(ctx: Ctx, channelId: string): Project | null {
  return fromRow<Project>(ctx.db.query("SELECT * FROM projects WHERE discord_channel_id = ?").get(channelId)) ?? null;
}

/** Résout l'utilisateur Novabot d'un auteur Discord. Le propriétaire = admin (créé/lié au besoin). Les autres doivent déjà exister (invités). */
export function resolveUser(ctx: Ctx, authorId: string, name: string, avatar: string | null): User | null {
  if (ctx.config.adminDiscordId && authorId === ctx.config.adminDiscordId) return upsertDiscordUser(ctx.db, { id: authorId, name, avatar });
  return fromRow<User>(ctx.db.query("SELECT * FROM users WHERE discord_id = ?").get(authorId)) ?? null;
}

export type IncomingResult =
  | { kind: "ignored"; reason: string }
  | { kind: "denied"; reason: string }
  | { kind: "posted"; message: Message; thread: Thread; user: User };

/** Message Discord entrant -> message Novabot + cerveau. `voiceText` = transcription déjà faite (optionnelle). */
export function routeIncoming(ctx: Ctx, m: IncomingMsg, opts: { voiceText?: string | null; dispatch?: boolean } = {}): IncomingResult {
  if (m.isBot) return { kind: "ignored", reason: "bot" };
  const globalChannel = getSetting(ctx, "discord.global_channel");
  const baseChannel = m.isThread ? m.parentId : m.channelId;
  if (!baseChannel) return { kind: "ignored", reason: "no channel" };
  const project = projectByChannel(ctx, baseChannel);
  const isGlobal = !project && baseChannel === globalChannel;
  if (!project && !isGlobal) return { kind: "ignored", reason: "salon hors Novabot" };
  const projectId = project?.id ?? null;

  const user = resolveUser(ctx, m.authorId, m.authorName, m.authorAvatar);
  if (!user || !canAccessProject(ctx.db, user, projectId)) return { kind: "denied", reason: "accès refusé" };

  let thread: Thread;
  if (m.isThread) {
    const linked = fromRow<Thread>(ctx.db.query("SELECT * FROM threads WHERE discord_thread_id = ?").get(m.channelId));
    if (linked) thread = linked;
    else {
      // thread de tâche ? -> fil de la tâche
      const tt = ctx.db.query("SELECT t.thread_id FROM discord_task_threads d JOIN tasks t ON t.id = d.task_id WHERE d.discord_thread_id = ?").get(m.channelId) as any;
      thread = tt?.thread_id ? fromRow<Thread>(ctx.db.query("SELECT * FROM threads WHERE id = ?").get(tt.thread_id)) : createThread(ctx, projectId, "Fil Discord", m.channelId);
    }
  } else thread = mainThread(ctx, projectId);

  const text = [m.content, opts.voiceText].filter((s) => s && s.trim()).join("\n");
  const attachments = m.attachments.filter((a) => !a.contentType?.startsWith("audio/")).map((a) => ({ url: a.url, name: a.name, mime: a.contentType }));
  const meta: Record<string, unknown> = { source: "discord", discordMessageId: m.id, discordChannelId: m.channelId, authorName: m.authorName };
  if (opts.voiceText) meta.voice = true;
  if (attachments.length) meta.attachments = attachments;
  const message = ctx.postMessage({ threadId: thread.id, role: "user", authorId: user.id, content: text, meta });
  if (opts.dispatch !== false) dispatchToBrain(ctx, message, thread, user);
  return { kind: "posted", message, thread, user };
}

/** Où envoyer un message sortant Novabot sur Discord (null = nulle part). */
export function outboundTarget(ctx: Ctx, msg: Message, thread: Thread | null, project: Project | null): { channelId: string; prefix: string } | null {
  if (!thread) return null;
  if (msg.role === "tool") return null;
  const meta = (msg.meta ?? {}) as Record<string, any>;
  if (msg.role === "user" && meta.source === "discord") return null; // vient déjà de Discord
  if (meta.discordSkip) return null;
  if (msg.role === "user" && meta.source === "cron") return null; // le prompt du cron reste interne, seule la réponse part sur Discord
  let channelId: string | null = thread.discordThreadId;
  if (!channelId && meta.taskId) channelId = (ctx.db.query("SELECT discord_thread_id FROM discord_task_threads WHERE task_id = ?").get(meta.taskId) as any)?.discord_thread_id ?? null;
  if (!channelId) {
    if (project) {
      // seul le fil principal du projet est relié au salon ; les autres fils PWA restent dans la PWA
      if (mainThread(ctx, project.id).id !== thread.id) return null;
      channelId = project.discordChannelId;
    } else {
      if (mainThread(ctx, null).id !== thread.id) return null;
      channelId = getSetting(ctx, "discord.global_channel");
    }
  }
  if (!channelId) return null;
  const prefix = msg.role === "user" ? `**${meta.authorName ?? "PWA"}** (PWA) : ` : msg.role === "system" ? "ℹ️ " : "";
  return { channelId, prefix };
}

export const STATUS_EMOJI: Record<Task["status"], string> = {
  queued: "⏳", running: "⏳", verifying: "🔎", waiting: "❓", blocked: "❓", done: "✅", failed: "❌", cancelled: "⛔",
};

export function taskThreadName(t: Task) {
  return `${STATUS_EMOJI[t.status]} ${t.title}`.slice(0, 100);
}

export function linkTaskThread(ctx: Ctx, taskId: string, discordThreadId: string, channelId: string, name: string) {
  insert(ctx.db, "discord_task_threads", { taskId, discordThreadId, channelId, lastName: name, createdAt: now() });
}

/** Ajoute un invité à un projet (commande /novabot invite). */
export function addGuest(ctx: Ctx, projectId: string, d: { id: string; name: string; avatar: string | null }): User {
  const u = upsertDiscordUser(ctx.db, d);
  ctx.db.query("INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)").run(projectId, u.id);
  return u;
}
