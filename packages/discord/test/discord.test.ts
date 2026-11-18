import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createECDH, randomBytes } from "node:crypto";

// secrets de test isolés (ensureVapid écrit dans ce fichier, pas dans ~/.novabot)
const dir = mkdtempSync(join(tmpdir(), "nb-discord-"));
process.env.NOVABOT_SECRETS = join(dir, "secrets.env");
process.env.NOVABOT_ADMIN_DISCORD_ID = "1000";
process.env.NOVABOT_DATA = dir;
delete process.env.DISCORD_BOT_TOKEN;

const { createApp } = await import("../../../apps/daemon/src/index.ts");
const discord = (await import("../src/index.ts")).default;
const { chunkMessage } = await import("../src/chunk.ts");
const { routeIncoming, outboundTarget, addGuest, setSetting } = await import("../src/routing.ts");
const { mainThread } = await import("@novabot/daemon/core");

let ctx: any; let app: any;
const dispatched: any[] = [];
const base = { attachments: [], isBot: false, isThread: false, parentId: null, authorAvatar: null };

beforeAll(async () => {
  ({ ctx, app } = await createApp({ dbPath: ":memory:", modules: [discord] }));
  ctx.services.brain = { handleMessage: async (m: any) => { dispatched.push(m); }, complete: async () => "" };
  for (const [pid, ch] of [["alpha", "c-alpha"], ["beta", "c-beta"]]) {
    ctx.db.query("INSERT INTO projects (id, name, discord_channel_id, autonomy, created_at) VALUES (?, ?, ?, 'full', 0)").run(pid, pid, ch);
  }
  setSetting(ctx, "discord.global_channel", "c-global");
});

test("découpe ≤ 2000 en conservant le texte et les blocs de code", () => {
  const text = Array.from({ length: 300 }, (_, i) => `ligne ${i} ` + "x".repeat(20)).join("\n");
  const parts = chunkMessage(text);
  expect(parts.length).toBeGreaterThan(3);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
  expect(parts.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  const code = "```ts\n" + "const a = 1;\n".repeat(400) + "```";
  const cp = chunkMessage(code);
  for (const p of cp) { expect(p.length).toBeLessThanOrEqual(2000); expect((p.match(/```/g) ?? []).length % 2).toBe(0); }
  expect(chunkMessage("court")).toEqual(["court"]);
});

test("message du propriétaire dans un salon projet → fil principal + cerveau", async () => {
  const r = routeIncoming(ctx, { ...base, id: "d1", channelId: "c-alpha", authorId: "1000", authorName: "Alice", content: "salut" });
  expect(r.kind).toBe("posted");
  if (r.kind !== "posted") return;
  expect(r.thread.id).toBe(mainThread(ctx, "alpha").id);
  expect(r.message.meta?.source).toBe("discord");
  expect(r.user.role).toBe("admin");
  await Bun.sleep(5);
  expect(dispatched.at(-1)?.id).toBe(r.message.id);
});

test("bots et salons hors Novabot ignorés ; salon global", () => {
  expect(routeIncoming(ctx, { ...base, id: "d2", channelId: "c-alpha", authorId: "1000", authorName: "x", content: "x", isBot: true }).kind).toBe("ignored");
  expect(routeIncoming(ctx, { ...base, id: "d3", channelId: "hermes-123", authorId: "1000", authorName: "x", content: "x" }).kind).toBe("ignored");
  const g = routeIncoming(ctx, { ...base, id: "d4", channelId: "c-global", authorId: "1000", authorName: "Alice", content: "global" });
  expect(g.kind).toBe("posted");
  if (g.kind === "posted") expect(g.thread.projectId).toBeNull();
});

test("invité : refusé avant invitation, puis seulement sur son projet", () => {
  const msg = (ch: string, id: string) => ({ ...base, id, channelId: ch, authorId: "2000", authorName: "Avi", content: "hello" });
  expect(routeIncoming(ctx, msg("c-alpha", "g1")).kind).toBe("denied");
  addGuest(ctx, "alpha", { id: "2000", name: "Avi", avatar: null });
  expect(routeIncoming(ctx, msg("c-alpha", "g2"), { dispatch: false }).kind).toBe("posted");
  expect(routeIncoming(ctx, msg("c-beta", "g3")).kind).toBe("denied");
  expect(routeIncoming(ctx, msg("c-global", "g4")).kind).toBe("denied");
});

test("thread Discord inconnu → nouveau fil Novabot lié", () => {
  const r = routeIncoming(ctx, { ...base, id: "t1", channelId: "dthread-1", parentId: "c-alpha", isThread: true, authorId: "1000", authorName: "Alice", content: "dans un fil" }, { dispatch: false });
  expect(r.kind).toBe("posted");
  if (r.kind === "posted") expect(r.thread.discordThreadId).toBe("dthread-1");
  const r2 = routeIncoming(ctx, { ...base, id: "t2", channelId: "dthread-1", parentId: "c-alpha", isThread: true, authorId: "1000", authorName: "Alice", content: "encore" }, { dispatch: false });
  if (r.kind === "posted" && r2.kind === "posted") expect(r2.thread.id).toBe(r.thread.id);
});

test("cible sortante", () => {
  const th = mainThread(ctx, "alpha");
  const project = ctx.db.query("SELECT id, discord_channel_id AS discordChannelId FROM projects WHERE id = 'alpha'").get();
  const mk = (role: string, meta: any) => ({ id: "x", threadId: th.id, role, authorId: null, content: "c", meta, createdAt: 0 });
  expect(outboundTarget(ctx, mk("user", { source: "discord" }) as any, th, project)).toBeNull();
  expect(outboundTarget(ctx, mk("assistant", null) as any, th, project)).toEqual({ channelId: "c-alpha", prefix: "" });
  expect(outboundTarget(ctx, mk("user", { source: "pwa", authorName: "Alice" }) as any, th, project)?.prefix).toContain("(PWA)");
  expect(outboundTarget(ctx, mk("tool", null) as any, th, project)).toBeNull();
});

test("routes : statut + clé VAPID générée hors /root", async () => {
  const H = { authorization: "Bearer " + ctx.config.internalToken };
  ctx.config.internalToken ||= "t";
  const st = await (await app.request("/api/discord/status", { headers: { authorization: "Bearer " + ctx.config.internalToken } })).json();
  expect(st.configured).toBe(false);
  const v = await (await app.request("/api/push/vapid", { headers: { authorization: "Bearer " + ctx.config.internalToken } })).json();
  expect(v.publicKey?.length).toBeGreaterThan(40);
  expect(readFileSync(process.env.NOVABOT_SECRETS!, "utf8")).toContain("VAPID_PUBLIC_KEY=");
  void H;
});

test("chiffrement Web Push aes128gcm déchiffrable par l'abonné", () => {
  const require = createRequire(import.meta.url);
  const webpush = require("web-push");
  const ece = createRequire(require.resolve("web-push"))("http_ece");
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: "https://push.example.com/abc", keys: { p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") } };
  const det = webpush.generateRequestDetails(sub, JSON.stringify({ title: "Novabot", body: "test" }), { vapidDetails: { subject: "mailto:a@b.c", publicKey: ctx.config.vapid.publicKey, privateKey: ctx.config.vapid.privateKey } });
  expect(det.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(det.headers.Authorization).toMatch(/^vapid t=/);
  const plain = ece.decrypt(det.body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth });
  expect(JSON.parse(plain.toString()).title).toBe("Novabot");
});

test("partage PWA : inviter, accès, retirer (admin seulement)", async () => {
  const { isAllowed } = await import("../src/oauth.ts");
  const H = { authorization: "Bearer " + ctx.config.internalToken, "content-type": "application/json" };
  const guestId = "222222222222222222";
  expect(isAllowed(ctx, guestId)).toBe(false);
  expect(isAllowed(ctx, "1000")).toBe(true); // admin
  expect((await app.request("/api/projects/alpha/members", { method: "POST", headers: H, body: JSON.stringify({ discordId: "x" }) })).status).toBe(400);
  expect((await app.request("/api/projects/alpha/members", { method: "POST", headers: H, body: JSON.stringify({ discordId: "1000" }) })).status).toBe(400);
  const r = await app.request("/api/projects/alpha/members", { method: "POST", headers: H, body: JSON.stringify({ discordId: guestId }) });
  expect(r.status).toBe(200);
  const u = await r.json();
  expect(isAllowed(ctx, guestId)).toBe(true);
  const list = await (await app.request("/api/projects/alpha/members", { headers: H })).json();
  expect(list.map((m: any) => m.discordId)).toContain(guestId);
  ctx.db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok-guest', ?, ?)").run(u.id, Date.now() + 1e9);
  // un invité ne peut ni partager ni chercher des membres
  const G = { cookie: "nb_session=tok-guest", "content-type": "application/json" };
  expect((await app.request("/api/projects/alpha/members", { method: "POST", headers: G, body: JSON.stringify({ discordId: "333333333333333333" }) })).status).toBe(403);
  expect((await app.request("/api/projects/beta/members", { headers: G })).status).toBe(403);
  expect((await app.request(`/api/projects/alpha/members/${u.id}`, { method: "DELETE", headers: H })).status).toBe(200);
  expect(isAllowed(ctx, guestId)).toBe(false);
  expect(ctx.db.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(u.id).n).toBe(0);
});
