// Connexion PWA « avec Discord » (OAuth2, scope identify).
import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Ctx } from "@novabot/daemon/core";
import { upsertDiscordUser, createSession, fromRow } from "@novabot/daemon/core";

const STATE_COOKIE = "nb_oauth_state";
const API = "https://discord.com/api/v10";

const page = (title: string, body: string) => `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px;text-align:center}a{color:#8ab4ff}</style>
<main><h1>${title}</h1><p>${body}</p><p><a href="/">Retour</a></p></main></html>`;

/** Un non-admin doit déjà être invité sur au moins un projet. */
export function isAllowed(ctx: Ctx, discordId: string): boolean {
  if (ctx.config.adminDiscordId && discordId === ctx.config.adminDiscordId) return true;
  const u = fromRow<any>(ctx.db.query("SELECT * FROM users WHERE discord_id = ?").get(discordId));
  if (!u) return false;
  if (u.role === "admin") return true;
  return !!ctx.db.query("SELECT 1 FROM project_members WHERE user_id = ? LIMIT 1").get(u.id);
}

export function oauthRoutes(app: Hono, ctx: Ctx) {
  const redirectUri = () => `${ctx.config.publicUrl}/auth/discord/callback`;

  app.get("/auth/discord", (c) => {
    const { clientId } = ctx.config.discord;
    if (!clientId) return c.html(page("Connexion Discord indisponible", "L'application Discord de Novabot n'est pas encore configurée."), 503);
    const state = crypto.randomUUID();
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: !ctx.config.dev, sameSite: "Lax", path: "/auth/discord", maxAge: 600 });
    const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri(), scope: "identify", state, prompt: "none" });
    return c.redirect(`https://discord.com/oauth2/authorize?${q}`);
  });

  app.get("/auth/discord/callback", async (c) => {
    const state = c.req.query("state"); const code = c.req.query("code");
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth/discord" });
    if (!code || !state || !expected || state !== expected) return c.html(page("Connexion refusée", "Lien de connexion invalide ou expiré, recommence."), 400);
    const { clientId, clientSecret } = ctx.config.discord;
    const tok = await fetch(`${API}/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri() }),
    });
    if (!tok.ok) { ctx.log("discord", "oauth token", tok.status); return c.html(page("Connexion refusée", "Discord a refusé l'échange du code."), 400); }
    const { access_token } = (await tok.json()) as any;
    const me = (await (await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${access_token}` } })).json()) as any;
    if (!me?.id) return c.html(page("Connexion refusée", "Profil Discord introuvable."), 400);
    if (!isAllowed(ctx, me.id)) return c.html(page("Accès non autorisé", "Ce Novabot est privé : ton compte Discord n'est invité sur aucun projet. Demande à son propriétaire de te partager un projet."), 403);
    const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : null;
    const user = upsertDiscordUser(ctx.db, { id: me.id, name: me.global_name ?? me.username, avatar });
    createSession(ctx.db, c, user.id);
    return c.redirect("/");
  });
}
