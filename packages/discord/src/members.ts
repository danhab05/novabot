// Partage d'un projet avec des invités depuis la PWA (menu « Partager »).
// Seul l'admin partage. Un invité se connecte ensuite avec Discord et ne voit que ses projets.
import type { Hono } from "hono";
import { OverwriteType, type Guild, type TextChannel } from "discord.js";
import type { Ctx } from "@novabot/daemon/core";
import { fromRow } from "@novabot/daemon/core";
import type { Project, User } from "@novabot/shared";
import { addGuest } from "./routing.ts";

const GUEST_PERMS = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, SendMessagesInThreads: true };

export function memberRoutes(app: Hono<any>, ctx: Ctx, getGuild: () => Guild | null) {
  const admin = (c: any) => c.get("user")?.role === "admin";
  const project = (id: string) => fromRow<Project>(ctx.db.query("SELECT * FROM projects WHERE id = ?").get(id));
  const channelOf = async (p: Project) => {
    const g = getGuild();
    if (!g || !p.discordChannelId) return null;
    return ((g.channels.cache.get(p.discordChannelId) ?? (await g.channels.fetch(p.discordChannelId).catch(() => null))) as TextChannel | null);
  };

  // Recherche de membres du serveur Discord (pour choisir qui inviter).
  app.get("/api/discord/members", async (c) => {
    if (!admin(c)) return c.json({ error: "forbidden" }, 403);
    const g = getGuild();
    const q = (c.req.query("q") ?? "").trim();
    if (!g) return c.json({ error: "bot Discord non connecté" }, 503);
    if (!q) return c.json([]);
    const found = await g.members.search({ query: q, limit: 10 }).catch(() => null);
    return c.json([...(found?.values() ?? [])].filter((m) => !m.user.bot && m.id !== ctx.config.adminDiscordId).map((m) => ({
      id: m.id, name: m.displayName, username: m.user.username, avatar: m.user.displayAvatarURL({ size: 64 }),
    })));
  });

  // Inviter : { discordId }. L'invité a accès au projet dans la PWA et à son salon Discord.
  app.post("/api/projects/:id/members", async (c) => {
    if (!admin(c)) return c.json({ error: "forbidden" }, 403);
    const p = project(c.req.param("id"));
    if (!p) return c.json({ error: "projet introuvable" }, 404);
    const { discordId } = await c.req.json<{ discordId?: string }>().catch(() => ({} as any));
    if (!discordId || !/^\d{15,22}$/.test(discordId)) return c.json({ error: "identifiant Discord invalide" }, 400);
    if (discordId === ctx.config.adminDiscordId) return c.json({ error: "c'est déjà ton compte admin" }, 400);
    const g = getGuild();
    const du = g ? await g.client.users.fetch(discordId).catch(() => null) : null;
    if (g && !du) return c.json({ error: "compte Discord introuvable" }, 404);
    const u = addGuest(ctx, p.id, { id: discordId, name: du?.globalName ?? du?.username ?? discordId, avatar: du?.displayAvatarURL({ size: 128 }) ?? null });
    const ch = await channelOf(p);
    if (ch) await ch.permissionOverwrites.edit(discordId, GUEST_PERMS, { type: OverwriteType.Member }).catch((e) => ctx.log("discord", "invite salon", e?.message));
    return c.json(u as User);
  });

  // Retirer un invité. Sans plus aucun projet, ses sessions PWA sont fermées.
  app.delete("/api/projects/:id/members/:userId", async (c) => {
    if (!admin(c)) return c.json({ error: "forbidden" }, 403);
    const p = project(c.req.param("id"));
    if (!p) return c.json({ error: "projet introuvable" }, 404);
    const u = fromRow<User>(ctx.db.query("SELECT * FROM users WHERE id = ?").get(c.req.param("userId")));
    if (!u) return c.json({ error: "utilisateur introuvable" }, 404);
    if (u.role === "admin") return c.json({ error: "impossible de retirer l'admin" }, 400);
    ctx.db.query("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(p.id, u.id);
    if (!ctx.db.query("SELECT 1 FROM project_members WHERE user_id = ? LIMIT 1").get(u.id)) ctx.db.query("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    const ch = await channelOf(p);
    if (ch && u.discordId) await ch.permissionOverwrites.delete(u.discordId).catch(() => {});
    return c.json({ ok: true });
  });
}
