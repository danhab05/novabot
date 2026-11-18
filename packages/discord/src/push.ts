// Web Push (VAPID) : clés générées au premier démarrage et ajoutées à secrets.env.
import webpush from "web-push";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "@novabot/daemon/core";
import { now } from "@novabot/shared";

const SECRETS = process.env.NOVABOT_SECRETS ?? join(process.env.NOVABOT_DATA ?? join(process.env.HOME || homedir(), ".novabot"), "secrets.env");

export function ensureVapid(ctx: Ctx, opts: { persist?: boolean } = {}) {
  const v = ctx.config.vapid;
  if (!v.publicKey || !v.privateKey) {
    const keys = webpush.generateVAPIDKeys();
    v.publicKey = keys.publicKey; v.privateKey = keys.privateKey;
    if (opts.persist !== false) {
      const cur = existsSync(SECRETS) ? readFileSync(SECRETS, "utf8") : "";
      const sep = cur && !cur.endsWith("\n") ? "\n" : "";
      appendFileSync(SECRETS, `${sep}VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`, { mode: 0o600 });
      ctx.log("push", "clés VAPID générées et ajoutées à secrets.env");
    }
  }
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
}

export function saveSubscription(ctx: Ctx, userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("abonnement invalide");
  ctx.db.query("INSERT INTO push_subscriptions (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys")
    .run(sub.endpoint, userId, JSON.stringify(sub.keys), now());
}

/** Destinataires : admins + membres du projet. */
function recipients(ctx: Ctx, projectId: string | null | undefined) {
  const rows = ctx.db.query(`
    SELECT s.endpoint, s.keys FROM push_subscriptions s JOIN users u ON u.id = s.user_id
    WHERE u.role = 'admin' OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_id = ?))`).all(projectId ?? null, projectId ?? null) as any[];
  return rows.map((r) => ({ endpoint: r.endpoint as string, keys: JSON.parse(r.keys) }));
}

export async function pushNotify(ctx: Ctx, n: { title: string; body: string; url?: string; projectId?: string | null; level: string }) {
  if (!ctx.config.vapid.publicKey) return;
  const payload = JSON.stringify({ title: n.title, body: n.body.slice(0, 300), url: n.url ?? "/", level: n.level, projectId: n.projectId ?? null });
  await Promise.allSettled(recipients(ctx, n.projectId).map(async (sub) => {
    try { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: n.level === "info" ? "normal" : "high" }); }
    catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) ctx.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
      else ctx.log("push", "échec envoi", e?.statusCode ?? e?.message);
    }
  }));
}
