// Module Discord de Novabot : bot (salons par projet, fils par tâche, vocaux, boutons), OAuth, Web Push.
import {
  Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, Events, OverwriteType,
  type Guild, type TextChannel, type Message as DMessage, type Interaction, type ThreadChannel,
} from "discord.js";
import type { Hono } from "hono";
import type { Ctx, Module } from "@novabot/daemon/core";
import { fromRow, canAccessProject } from "@novabot/daemon/core";
import type { Folder, Project, Task, Message, User } from "@novabot/shared";
import { chunkMessage } from "./chunk.ts";
import { ensureSchema, routeIncoming, outboundTarget, getSetting, setSetting, taskThreadName, linkTaskThread, addGuest, projectByChannel, resolveUser } from "./routing.ts";
import { oauthRoutes } from "./oauth.ts";
import { memberRoutes } from "./members.ts";
import { ensureVapid, saveSubscription, pushNotify } from "./push.ts";

const CATEGORY_PREFIX = "Novabot · ";
const GLOBAL_CATEGORY = "Novabot · Général";

let client: Client | null = null;
let guild: Guild | null = null;
let ready = false;
let lastError: string | null = null;

const ADMIN_MENTION = (ctx: Ctx) => (ctx.config.adminDiscordId ? `<@${ctx.config.adminDiscordId}> ` : "");

async function fetchSendable(id: string): Promise<TextChannel | ThreadChannel | null> {
  if (!client) return null;
  try {
    const ch = await client.channels.fetch(id);
    if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.PublicThread || ch.type === ChannelType.PrivateThread)) return ch as any;
  } catch { /* salon supprimé */ }
  return null;
}

async function sendChunks(ch: TextChannel | ThreadChannel, text: string, components?: any[]) {
  const parts = chunkMessage(text);
  let last: DMessage | null = null;
  for (let i = 0; i < parts.length; i++) {
    last = await ch.send({ content: parts[i], allowedMentions: { users: [...parts[i].matchAll(/<@(\d+)>/g)].map((m) => m[1]) }, components: i === parts.length - 1 ? components : undefined });
  }
  return last;
}

// ---------------- synchronisation des salons ----------------
function privateOverwrites(ctx: Ctx, g: Guild) {
  const ow: any[] = [{ id: g.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] }, { id: g.client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads] }];
  if (ctx.config.adminDiscordId) ow.push({ id: ctx.config.adminDiscordId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads] });
  return ow;
}

async function ensureCategory(ctx: Ctx, g: Guild, key: string, name: string) {
  const known = getSetting(ctx, `discord.cat.${key}`);
  if (known) { const c = g.channels.cache.get(known) ?? (await g.channels.fetch(known).catch(() => null)); if (c) return c.id; }
  const existing = g.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  const cat = existing ?? (await g.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: privateOverwrites(ctx, g) }));
  setSetting(ctx, `discord.cat.${key}`, cat.id);
  return cat.id;
}

async function syncProject(ctx: Ctx, g: Guild, p: Project) {
  if (p.discordChannelId && (g.channels.cache.get(p.discordChannelId) ?? (await g.channels.fetch(p.discordChannelId).catch(() => null)))) return;
  const folder = p.folderId ? fromRow<Folder>(ctx.db.query("SELECT * FROM folders WHERE id = ?").get(p.folderId)) : null;
  const catId = await ensureCategory(ctx, g, folder?.id ?? "divers", CATEGORY_PREFIX + (folder?.name ?? "Divers"));
  // réutilise un salon Novabot déjà créé (même nom, dans la catégorie Novabot) — jamais un salon Hermes
  const existing = g.channels.cache.find((c) => c.type === ChannelType.GuildText && c.parentId === catId && c.name === p.id);
  const ch = existing ?? (await g.channels.create({ name: p.id, type: ChannelType.GuildText, parent: catId, topic: `${p.name}${p.path ? " — " + p.path : ""} · Novabot` }));
  ctx.db.query("UPDATE projects SET discord_channel_id = ? WHERE id = ?").run(ch.id, p.id);
  // invités déjà membres : permission de voir le salon
  const members = ctx.db.query("SELECT u.discord_id FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.discord_id IS NOT NULL").all(p.id) as any[];
  for (const m of members) await (ch as TextChannel).permissionOverwrites.edit(m.discord_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, SendMessagesInThreads: true }, { type: OverwriteType.Member }).catch(() => {});
}

async function syncAll(ctx: Ctx, g: Guild) {
  await g.channels.fetch();
  const gcat = await ensureCategory(ctx, g, "global", GLOBAL_CATEGORY);
  let gch = getSetting(ctx, "discord.global_channel");
  if (!gch || !g.channels.cache.get(gch)) {
    const existing = g.channels.cache.find((c) => c.type === ChannelType.GuildText && c.parentId === gcat && c.name === "novabot");
    const ch = existing ?? (await g.channels.create({ name: "novabot", type: ChannelType.GuildText, parent: gcat, topic: "Fil global de Novabot" }));
    setSetting(ctx, "discord.global_channel", ch.id); gch = ch.id;
  }
  const projects = (ctx.db.query("SELECT * FROM projects ORDER BY name").all() as any[]).map((r) => fromRow<Project>(r));
  for (const p of projects) {
    try { await syncProject(ctx, g, p); } catch (e: any) { ctx.log("discord", `sync ${p.id} échec`, e?.message); }
  }
  ctx.log("discord", `salons synchronisés (${projects.length} projets)`);
}

// ---------------- tâches ----------------
async function onTask(ctx: Ctx, t: Task) {
  if (!guild || !ready) return;
  const row = ctx.db.query("SELECT * FROM discord_task_threads WHERE task_id = ?").get(t.id) as any;
  const name = taskThreadName(t);
  if (!row) {
    if (t.status !== "queued" && t.status !== "running") return;
    const project = t.projectId ? fromRow<Project>(ctx.db.query("SELECT * FROM projects WHERE id = ?").get(t.projectId)) : null;
    const chId = project?.discordChannelId ?? getSetting(ctx, "discord.global_channel");
    const ch = chId ? await fetchSendable(chId) : null;
    if (!ch || ch.isThread()) return;
    // ouvre le fil sous le dernier message Discord du propriétaire dans ce fil Novabot si possible
    const last = t.threadId ? (ctx.db.query("SELECT meta FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1").get(t.threadId) as any) : null;
    const dmId = last?.meta ? JSON.parse(last.meta).discordMessageId : null;
    let thread: ThreadChannel;
    const anchor = dmId ? await (ch as TextChannel).messages.fetch(dmId).catch(() => null) : null;
    if (anchor && !anchor.hasThread) thread = await anchor.startThread({ name });
    else thread = await (ch as TextChannel).threads.create({ name });
    linkTaskThread(ctx, t.id, thread.id, ch.id, name);
    await thread.send(`**Objectif :** ${t.goal.slice(0, 1500)}${t.doneCriteria ? `\n**Fini quand :** ${t.doneCriteria.slice(0, 400)}` : ""}`).catch(() => {});
    return;
  }
  if (row.last_name === name) return;
  const thread = await fetchSendable(row.discord_thread_id);
  if (!thread || !thread.isThread()) return;
  ctx.db.query("UPDATE discord_task_threads SET last_name = ? WHERE task_id = ?").run(name, t.id);
  await thread.setName(name).catch((e) => ctx.log("discord", "renommage fil", e?.message)); // Discord limite ~2 renommages / 10 min
  if (t.status === "done" && t.summary) await sendChunks(thread, `✅ **Terminé** — ${t.summary}${t.evidence ? `\n**Preuve :**\n${t.evidence}` : ""}`).catch(() => {});
  if (t.status === "failed") await sendChunks(thread, `❌ **Échec**${t.summary ? " — " + t.summary : ""}`).catch(() => {});
}

// ---------------- entrants ----------------
async function onMessage(ctx: Ctx, m: DMessage) {
  if (m.author.bot || !m.inGuild() || m.guildId !== guild?.id) return;
  const isThread = m.channel.isThread();
  const parentId = isThread ? (m.channel as ThreadChannel).parentId : null;
  const base = isThread ? parentId : m.channelId;
  // filtre rapide : uniquement les salons Novabot
  if (!base || (!projectByChannel(ctx, base) && base !== getSetting(ctx, "discord.global_channel"))) return;

  let voiceText: string | null = null;
  const audio = [...m.attachments.values()].find((a) => a.contentType?.startsWith("audio/") || /\.(ogg|mp3|m4a|wav|webm)$/i.test(a.name));
  if (audio) {
    const stt = (ctx.services as any).voice?.stt as ((buf: Uint8Array, mime: string) => Promise<string>) | undefined;
    if (!stt) { await m.reply("🎙️ Je ne peux pas encore transcrire les vocaux (module voix absent)."); if (!m.content.trim()) return; }
    else {
      try {
        const buf = new Uint8Array(await (await fetch(audio.url)).arrayBuffer());
        voiceText = await stt(buf, audio.contentType ?? "audio/ogg");
      } catch (e: any) { await m.reply(`🎙️ Transcription impossible : ${String(e?.message ?? e).slice(0, 200)}`); if (!m.content.trim()) return; }
    }
  }
  const r = routeIncoming(ctx, {
    id: m.id, channelId: m.channelId, parentId, isThread, authorId: m.author.id, authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
    authorAvatar: m.author.displayAvatarURL({ size: 128 }), isBot: false, content: m.content,
    attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType ?? null })),
  }, { voiceText });
  if (r.kind === "denied") await m.react("🚫").catch(() => {});
  else if (r.kind === "posted") { await m.react("👀").catch(() => {}); if (voiceText) await m.reply(`🎙️ _${voiceText.slice(0, 1800)}_`).catch(() => {}); }
}

// ---------------- sortants ----------------
async function onOutbound(ctx: Ctx, msg: Message, thread: any, project: Project | null) {
  if (!ready) return;
  const target = outboundTarget(ctx, msg, thread, project);
  if (!target) return;
  const ch = await fetchSendable(target.channelId);
  if (!ch) return;
  const meta = (msg.meta ?? {}) as any;
  const components = meta.kind === "question" && meta.taskId
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`nb_answer:${meta.taskId}`).setLabel("Répondre").setStyle(ButtonStyle.Primary))]
    : undefined;
  await sendChunks(ch, target.prefix + msg.content, components);
}

// ---------------- interactions ----------------
async function onInteraction(ctx: Ctx, i: Interaction) {
  const actor = (id: string, name: string, avatar: string | null): User | null => resolveUser(ctx, id, name, avatar);
  if (i.isButton() && i.customId.startsWith("nb_answer:")) {
    const taskId = i.customId.slice("nb_answer:".length);
    const task = fromRow<Task>(ctx.db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
    const u = actor(i.user.id, i.user.username, null);
    if (!task || !u || !canAccessProject(ctx.db, u, task.projectId)) return i.reply({ content: "Accès refusé.", ephemeral: true });
    const modal = new ModalBuilder().setCustomId(`nb_answer_modal:${taskId}`).setTitle("Réponse à Novabot")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("answer").setLabel((task.title || "Ta réponse").slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true)));
    return i.showModal(modal);
  }
  if (i.isModalSubmit() && i.customId.startsWith("nb_answer_modal:")) {
    const taskId = i.customId.slice("nb_answer_modal:".length);
    const u = actor(i.user.id, i.user.username, null);
    const task = fromRow<Task>(ctx.db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (!task || !u || !canAccessProject(ctx.db, u, task.projectId)) return i.reply({ content: "Accès refusé.", ephemeral: true });
    const answer = i.fields.getTextInputValue("answer");
    if (!ctx.services.orchestrator) return i.reply({ content: "Orchestrateur indisponible, réessaie plus tard.", ephemeral: true });
    await ctx.services.orchestrator.answer(taskId, answer, u.id);
    return i.reply({ content: `✅ Réponse transmise : ${answer.slice(0, 1800)}` });
  }
  if (i.isChatInputCommand() && i.commandName === "novabot") {
    const u = actor(i.user.id, i.user.username, null);
    if (!u || u.role !== "admin") return i.reply({ content: "Commande réservée à l'admin de ce Novabot.", ephemeral: true });
    if (i.options.getSubcommand() === "invite") {
      const target = i.options.getUser("user", true);
      const p = projectByChannel(ctx, i.channel?.isThread() ? (i.channel as ThreadChannel).parentId ?? "" : i.channelId);
      if (!p) return i.reply({ content: "Lance la commande dans le salon du projet.", ephemeral: true });
      addGuest(ctx, p.id, { id: target.id, name: target.globalName ?? target.username, avatar: target.displayAvatarURL({ size: 128 }) });
      const ch = p.discordChannelId ? await fetchSendable(p.discordChannelId) : null;
      if (ch && !ch.isThread()) await (ch as TextChannel).permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, SendMessagesInThreads: true }, { type: OverwriteType.Member });
      return i.reply({ content: `✅ <@${target.id}> a maintenant accès au projet **${p.name}** (ici et dans la PWA : ${ctx.config.publicUrl}).` });
    }
  }
}

async function registerCommands(g: Guild) {
  const cmd = new SlashCommandBuilder().setName("novabot").setDescription("Novabot")
    .addSubcommand((s) => s.setName("invite").setDescription("Donne accès à ce projet à un membre").addUserOption((o) => o.setName("user").setDescription("Membre à inviter").setRequired(true)));
  await g.commands.set([cmd.toJSON()]);
}

// ---------------- module ----------------
const mod: Module & { publicRoutes(app: Hono, ctx: Ctx): void } = {
  name: "discord",
  init(ctx) {
    ensureSchema(ctx);
    try { ensureVapid(ctx); } catch (e: any) { ctx.log("push", "VAPID indisponible", e?.message); }
    ctx.services.notifiers.push((n) => pushNotify(ctx, n));
    ctx.services.notifiers.push(async (n) => {
      if (!ready) return;
      const taskId = n.url?.match(/\/tasks\/([\w]+)/)?.[1];
      let chId: string | null = taskId ? (ctx.db.query("SELECT discord_thread_id FROM discord_task_threads WHERE task_id = ?").get(taskId) as any)?.discord_thread_id ?? null : null;
      if (!chId && n.projectId) chId = (ctx.db.query("SELECT discord_channel_id FROM projects WHERE id = ?").get(n.projectId) as any)?.discord_channel_id ?? null;
      chId ??= getSetting(ctx, "discord.global_channel");
      const ch = chId ? await fetchSendable(chId) : null;
      if (!ch) return;
      const icon = { info: "ℹ️", done: "✅", blocked: "❓", alert: "🚨" }[n.level] ?? "ℹ️";
      const mention = n.level === "info" ? "" : ADMIN_MENTION(ctx);
      const link = n.url ? `\n${ctx.config.publicUrl}${n.url.startsWith("/") ? n.url : "/" + n.url}` : "";
      await sendChunks(ch, `${mention}${icon} **${n.title}**\n${n.body}${link}`);
    });
    ctx.services.outbound.push((m, t, p) => onOutbound(ctx, m, t, p));
    ctx.bus.on((e) => {
      if (e.type === "task") onTask(ctx, e.task).catch((err) => ctx.log("discord", "task", err?.message));
      if (e.type === "project" && guild && ready) syncProject(ctx, guild, e.project).catch((err) => ctx.log("discord", "sync", err?.message));
    });
  },
  routes(app, ctx) {
    memberRoutes(app, ctx, () => (ready ? guild : null));
    app.get("/api/push/vapid", (c) => c.json({ publicKey: ctx.config.vapid.publicKey || null }));
    app.post("/api/push/subscribe", async (c) => {
      try { saveSubscription(ctx, c.get("user").id, await c.req.json()); return c.json({ ok: true }); }
      catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
    });
    app.post("/api/push/test", async (c) => { await pushNotify(ctx, { title: "Novabot", body: "Notification de test", level: "info", url: "/" }); return c.json({ ok: true }); });
    app.get("/api/discord/status", (c) => c.json({
      configured: !!ctx.config.discord.token, oauth: !!(ctx.config.discord.clientId && ctx.config.discord.clientSecret),
      connected: ready, bot: client?.user?.tag ?? null, guildId: guild?.id ?? ctx.config.discord.guildId ?? null,
      globalChannel: getSetting(ctx, "discord.global_channel"),
      linkedProjects: (ctx.db.query("SELECT COUNT(*) AS n FROM projects WHERE discord_channel_id IS NOT NULL").get() as any).n,
      lastError,
    }));
  },
  publicRoutes(app, ctx) { oauthRoutes(app, ctx); },
  async start(ctx) {
    const { token, guildId } = ctx.config.discord;
    if (!token || !guildId) { ctx.log("discord", "Discord non configuré (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID manquants)"); return; }
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
    client.once(Events.ClientReady, async (c) => {
      try {
        guild = await c.guilds.fetch(guildId);
        ready = true;
        ctx.log("discord", `connecté en tant que ${c.user.tag}`);
        await syncAll(ctx, guild);
        await registerCommands(guild).catch((e) => ctx.log("discord", "commandes", e?.message));
      } catch (e: any) { lastError = String(e?.message ?? e); ctx.log("discord", "ready échec", lastError); }
    });
    client.on(Events.MessageCreate, (m) => onMessage(ctx, m).catch((e) => ctx.log("discord", "message", e?.message)));
    client.on(Events.InteractionCreate, (i) => onInteraction(ctx, i).catch((e) => ctx.log("discord", "interaction", e?.message)));
    client.on(Events.Error, (e) => { lastError = e.message; ctx.log("discord", "erreur", e.message); });
    client.login(token).catch((e) => { lastError = String(e?.message ?? e); ctx.log("discord", "login échec", lastError); });
  },
  async stop() { ready = false; await client?.destroy(); client = null; },
};
export default mod;
