import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "nbcat-r-"));
process.env.NOVABOT_CATALOG_HOME = home;
process.env.NOVABOT_INTERNAL_TOKEN = "test-token";
process.env.NOVABOT_SECRETS = join(home, "secrets.env");
process.env.NOVABOT_DATA = join(home, "data");
mkdirSync(join(home, ".claude/skills/propre"), { recursive: true });
writeFileSync(join(home, ".claude/skills/propre/SKILL.md"), "---\nname: propre\ndescription: skill sans secret\n---\nfais bien");
mkdirSync(join(home, ".claude/skills/sale"), { recursive: true });
writeFileSync(join(home, ".claude/skills/sale/SKILL.md"), "---\nname: sale\ndescription: skill avec secret\n---\ntoken = ghp_abcdefghijklmnopqrstuvwxyz0123");

const { createApp } = await import("../../../apps/daemon/src/index.ts");
const mod = (await import("../src/index.ts")).default;
const { app, ctx } = await createApp({ dbPath: ":memory:", modules: [mod as any] });
const H = { authorization: "Bearer test-token", "content-type": "application/json" };
const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });

test("catalogue listé avec skills + registre", async () => {
  const list = (await (await req("/api/catalog")).json()) as any[];
  const ids = list.map((i) => i.id);
  expect(ids).toEqual(expect.arrayContaining(["skill-propre", "skill-sale", "mcp-gmail", "mcp-coolify", "agent-seo"]));
  expect(list.find((i) => i.id === "mcp-github").installed).toBe(true); // activé d'office
  expect(ctx.tools.get("gmail_send")!.reserved).toBe(true);
  expect(ctx.tools.get("whatsapp_send")!.reserved).toBe(true);
});
test("publication : refus si secret, sinon page publique + manifeste", async () => {
  const bad = await req("/api/catalog/skill-sale/publish", { method: "POST" });
  expect(bad.status).toBe(422);
  expect(((await bad.json()) as any).findings[0].kind).toBe("jeton GitHub");
  expect((await req("/api/catalog/skill-propre/publish", { method: "POST" })).status).toBe(200);
  const page = await app.request("/pub/catalogue");
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain("propre");
  expect(html).not.toContain("skill-sale");
  expect((await app.request("/pub/catalogue/skill-propre.json")).status).toBe(200);
  expect((await app.request("/pub/catalogue/skill-sale.json")).status).toBe(404);
});
test("agent : installation dans un nouveau projet puis désinstallation", async () => {
  const r = (await (await req("/api/catalog/agent-seo/install", { method: "POST", body: "{}" })).json()) as any;
  expect(r.detail.projectId).toBe("seo");
  expect((ctx.db.query("SELECT notes FROM projects WHERE id = 'seo'").get() as any).notes).toContain("agent SEO");
  await req("/api/catalog/agent-seo/uninstall", { method: "POST" });
  expect(ctx.db.query("SELECT 1 FROM projects WHERE id = 'seo'").get()).toBeNull();
});
test("skill Hermes-like : install dans le HOME de test uniquement", async () => {
  expect((await req("/api/catalog/skill-propre/install", { method: "POST", body: "{}" })).status).toBe(400); // existe déjà
});
test("import distant : https uniquement, adresses locales refusées", async () => {
  const r1 = await req("/api/catalog/import", { method: "POST", body: JSON.stringify({ url: "http://exemple.fr/x.json" }) });
  expect(((await r1.json()) as any).error).toContain("https");
  const r2 = await req("/api/catalog/import", { method: "POST", body: JSON.stringify({ url: "https://127.0.0.1/x.json" }) });
  expect(((await r2.json()) as any).error).toContain("locale");
});
test("OAuth Google sans session admin : redirection login ; page install sans session : invite à se connecter", async () => {
  const r = await app.request("/auth/google");
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/auth/discord");
  expect(await (await app.request("/catalog/install?src=https://x/y.json")).text()).toContain("Connecte-toi");
});
test("intégrations : Google à configurer avec instructions", async () => {
  const s = (await (await req("/api/integrations")).json()) as any;
  expect(s.google.state).toBe("à configurer");
  expect(s.google.howto).toContain("callback");
});
test("rien écrit dans le vrai ~/.claude", () => {
  expect(existsSync(join(homedir(), ".claude/skills/propre"))).toBe(false);
});
