import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { DB } from "./db.ts";
import { fromRow, insert } from "./db.ts";
import type { User } from "@novabot/shared";
import { id, now } from "@novabot/shared";
import { config } from "./config.ts";

export const SESSION_COOKIE = "nb_session";
const SESSION_DAYS = 30;

export function createSession(db: DB, c: Context, userId: string) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  insert(db, "sessions", { token, userId, expiresAt: now() + SESSION_DAYS * 86400_000 });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: !config.dev, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
}

export function destroySession(db: DB, c: Context) {
  const t = getCookie(c, SESSION_COOKIE);
  if (t) db.query("DELETE FROM sessions WHERE token = ?").run(t);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function userFromRequest(db: DB, c: Context): User | null {
  // 1) jeton interne (MCP, tests) -> admin
  const auth = c.req.header("authorization");
  if (config.internalToken && auth === `Bearer ${config.internalToken}`) return adminUser(db);
  // 2) cookie de session (glissant)
  const t = getCookie(c, SESSION_COOKIE);
  if (!t) return null;
  const row = db.query("SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").get(t) as any;
  if (!row || row.s_exp < now()) return null;
  if (row.s_exp - now() < (SESSION_DAYS - 1) * 86400_000) db.query("UPDATE sessions SET expires_at = ? WHERE token = ?").run(now() + SESSION_DAYS * 86400_000, t);
  delete row.s_exp;
  return fromRow<User>(row);
}

/** Utilisateur admin (le propriétaire). Créé au premier besoin. */
export function adminUser(db: DB): User {
  const row = db.query("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  if (row) return fromRow<User>(row);
  const u = { id: id("u_"), discordId: config.adminDiscordId || null, name: config.ownerName, avatar: null, role: "admin" as const, createdAt: now() };
  insert(db, "users", u);
  return u;
}

/** Trouve ou crée un utilisateur à partir d'un compte Discord. Le propriétaire (adminDiscordId) = admin, sinon invité. */
export function upsertDiscordUser(db: DB, d: { id: string; name: string; avatar: string | null }): User {
  const existing = db.query("SELECT * FROM users WHERE discord_id = ?").get(d.id);
  if (existing) {
    db.query("UPDATE users SET name = ?, avatar = ? WHERE discord_id = ?").run(d.name, d.avatar, d.id);
    return fromRow<User>(db.query("SELECT * FROM users WHERE discord_id = ?").get(d.id));
  }
  if (config.adminDiscordId && d.id === config.adminDiscordId) {
    const admin = db.query("SELECT * FROM users WHERE role = 'admin' AND discord_id IS NULL LIMIT 1").get() as any;
    if (admin) {
      db.query("UPDATE users SET discord_id = ?, name = ?, avatar = ? WHERE id = ?").run(d.id, d.name, d.avatar, admin.id);
      return fromRow<User>(db.query("SELECT * FROM users WHERE id = ?").get(admin.id));
    }
  }
  const u = { id: id("u_"), discordId: d.id, name: d.name, avatar: d.avatar, role: (d.id === config.adminDiscordId ? "admin" : "guest") as User["role"], createdAt: now() };
  insert(db, "users", u);
  return u;
}

export function canAccessProject(db: DB, user: User | null, projectId: string | null): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!projectId) return false; // fils globaux = propriétaire seulement
  return !!db.query("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, user.id);
}

export function accessibleProjectIds(db: DB, user: User): string[] | "all" {
  if (user.role === "admin") return "all";
  return (db.query("SELECT project_id FROM project_members WHERE user_id = ?").all(user.id) as any[]).map((r) => r.project_id);
}

export const requireUser = (db: DB) => async (c: Context, next: Next) => {
  const u = userFromRequest(db, c);
  if (!u) return c.json({ error: "unauthorized" }, 401);
  c.set("user", u);
  await next();
};
