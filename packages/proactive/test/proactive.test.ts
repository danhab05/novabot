import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCron, nextRun, parseAt, wallToUtc, formatParis } from "../src/cron.ts";
import { readClaudeQuotas, readCodexQuotas, effective } from "../src/quotas.ts";
import { evaluate, canAutofix } from "../src/health.ts";

process.env.NOVABOT_SKIP_HERMES_IMPORT = "1";
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

// ---------- parseur cron ----------
test("parse: listes, plages, pas, noms, dimanche = 0 ou 7", () => {
  const s = parseCron("*/15 9-17/4 1,15 jan-mar mon-fri");
  expect([...s.minute]).toEqual([0, 15, 30, 45]);
  expect([...s.hour]).toEqual([9, 13, 17]);
  expect([...s.month]).toEqual([1, 2, 3]);
  expect([...s.dow]).toEqual([1, 2, 3, 4, 5]);
  expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
  expect(() => parseCron("61 * * * *")).toThrow();
  expect(() => parseCron("* * *")).toThrow();
  expect([...parseCron("@daily").hour]).toEqual([0]);
});

test("7 h Paris en hiver = 06:00 UTC, en été = 05:00 UTC", () => {
  expect(iso(nextRun("0 7 * * *", Date.parse("2026-11-18T08:00:00Z")))).toBe("2026-11-19T06:00:00.000Z");
  expect(iso(nextRun("0 7 * * *", Date.parse("2026-07-01T00:00:00Z")))).toBe("2026-07-01T05:00:00.000Z");
});

test("DST printemps (29/03/2026) : 02:30 n'existe pas -> sauté", () => {
  expect(wallToUtc(2026, 3, 29, 2, 30)).toBeNull();
  // le cron quotidien 02:30 saute le 29 et tombe le 30 (heure d'été, UTC+2)
  expect(iso(nextRun("30 2 * * *", Date.parse("2026-03-28T12:00:00Z")))).toBe("2026-03-30T00:30:00.000Z");
  // 03:00 existe : 01:00 UTC
  expect(iso(nextRun("0 3 * * *", Date.parse("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:00:00.000Z");
});

test("DST automne (25/10/2026) : 02:30 ambigu -> une seule exécution", () => {
  const first = nextRun("30 2 * * *", Date.parse("2026-10-24T12:00:00Z"))!;
  expect(iso(first)).toBe("2026-10-25T00:30:00.000Z"); // première occurrence (UTC+2)
  const second = nextRun("30 2 * * *", first)!;
  expect(iso(second)).toBe("2026-10-26T01:30:00.000Z"); // pas de 2e déclenchement le 25 (01:30Z)
  // un cron horaire passe bien par les 25 heures de la journée
  let t = Date.parse("2026-10-24T22:00:00Z"), n = 0;
  const end = Date.parse("2026-10-25T23:00:00Z");
  while ((t = nextRun("0 * * * *", t)!) < end) n++;
  expect(n).toBe(23); // 24 instants UTC, mais 02:00 (ambiguë, vécue 2 fois) ne déclenche qu'une fois
});

test("parseAt heure de Paris + formatParis", () => {
  expect(iso(parseAt("2026-11-18 21:00"))).toBe("2026-11-18T20:00:00.000Z");
  expect(iso(parseAt("2026-07-14 21:00"))).toBe("2026-07-14T19:00:00.000Z");
  expect(() => parseAt("2026-03-29 02:30")).toThrow();
  expect(() => parseAt("demain soir")).toThrow();
  expect(formatParis(Date.parse("2026-11-18T20:00:00Z"))).toBe("2026-11-18 21:00");
});

test("dom et dow restreints = OU (sémantique cron)", () => {
  // le 1er du mois OU un lundi ; depuis le mercredi 18/11/2026 -> lundi 23/11
  expect(iso(nextRun("0 12 1 * 1", Date.parse("2026-11-18T12:00:00Z")))).toBe("2026-11-23T11:00:00.000Z");
});

// ---------- quotas ----------
test("lecture quotas sur fixtures", () => {
  const dir = mkdtempSync(join(tmpdir(), "nbq-"));
  writeFileSync(join(dir, "rl.json"), JSON.stringify({ saved_at: 1794990128, rate_limits: { five_hour: { used_percentage: 28.4, resets_at: 1794996600 }, seven_day: { used_percentage: 65, resets_at: 1795258800 } } }));
  const c = readClaudeQuotas(join(dir, "rl.json"));
  expect(c).toEqual([
    { provider: "claude", window: "5h", usedPct: 28, resetsAt: 1794996600000, updatedAt: 1794990128000 },
    { provider: "claude", window: "7d", usedPct: 65, resetsAt: 1795258800000, updatedAt: 1794990128000 },
  ]);
  const sess = join(dir, "sessions/2026/11/18"); mkdirSync(sess, { recursive: true });
  const ev = (p: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: p, window_minutes: 10080, resets_at: 1794985283 }, secondary: { used_percent: 12, window_minutes: 300, resets_at: 1794980000 } } } });
  writeFileSync(join(sess, "rollout-a.jsonl"), [ev(80), '{"type":"other"}', ev(93)].join("\n") + "\n");
  const x = readCodexQuotas(join(dir, "sessions"));
  expect(x.map((q) => [q.provider, q.window, q.usedPct, q.resetsAt])).toEqual([["codex", "7d", 93, 1794985283000], ["codex", "5h", 12, 1794980000000]]);
  expect(effective(x[0], 1794985283001).usedPct).toBe(0);
  expect(readClaudeQuotas(join(dir, "absent.json"))).toEqual([]);
});

// ---------- santé ----------
test("2 échecs consécutifs avant down, retour ok = up", () => {
  let s = evaluate(undefined, { status: "down", detail: "x" });
  expect(s).toEqual({ next: { status: "warn", fails: 1 }, transition: null });
  s = evaluate(s.next, { status: "down", detail: "x" });
  expect(s).toEqual({ next: { status: "down", fails: 2 }, transition: "down" });
  s = evaluate(s.next, { status: "down", detail: "x" });
  expect(s.transition).toBeNull();
  s = evaluate(s.next, { status: "ok", detail: "x" });
  expect(s).toEqual({ next: { status: "ok", fails: 0 }, transition: "up" });
});

test("anti-boucle auto-fix", () => {
  const t = 10_000_000;
  expect(canAutofix(null, t)).toBe(true);
  expect(canAutofix({ createdAt: t - 7200_000, taskStatus: "running" }, t)).toBe(false); // tâche ouverte
  expect(canAutofix({ createdAt: t - 1800_000, taskStatus: "done" }, t)).toBe(false); // < 1 h
  expect(canAutofix({ createdAt: t - 3700_000, taskStatus: "failed" }, t)).toBe(true);
});

// ---------- intégration daemon (base en mémoire) ----------
let app: any, ctx: any, mod: any;
beforeAll(async () => {
  const daemon = await import("../../../apps/daemon/src/index.ts");
  mod = await import("../src/index.ts");
  const r = await daemon.createApp({ dbPath: ":memory:", modules: [mod.default] });
  app = r.app; ctx = r.ctx;
});

test("brief système créé à 7 h Paris", () => {
  const b = ctx.db.query("SELECT * FROM crons WHERE prompt = ?").get(mod.BRIEF_PROMPT);
  expect(b.schedule).toBe("0 7 * * *");
  expect(b.next_run).toBeGreaterThan(Date.now());
});

test("one-shot : exécuté une fois puis désactivé ; rattrapage > 1 h ignoré", async () => {
  const t0 = Date.parse("2030-01-01T10:00:00Z");
  const runs: string[] = [];
  const c = mod.addCron(ctx, { name: "rappel", at: "2030-01-01 12:00", prompt: "rappelle-moi" }); // 11:00Z
  const rec = mod.addCron(ctx, { name: "horaire", schedule: "0 * * * *", prompt: "x" });
  ctx.db.query("UPDATE crons SET next_run = ? WHERE id = ?").run(t0 - 2 * 3600_000, rec.id); // manqué de 2 h
  await mod.tick(ctx, t0, async (cr: any) => { runs.push(cr.name); });
  expect(runs).toEqual([]); // rappel pas encore dû, horaire manqué > 1 h ignoré
  expect(ctx.db.query("SELECT next_run FROM crons WHERE id = ?").get(rec.id).next_run).toBe(t0 + 3600_000);
  await mod.tick(ctx, Date.parse("2030-01-01T11:00:30Z"), async (cr: any) => { runs.push(cr.name); });
  await mod.tick(ctx, Date.parse("2030-01-01T11:01:00Z"), async (cr: any) => { runs.push(cr.name); });
  expect(runs.sort()).toEqual(["horaire", "rappel"]); // chacun une seule fois
  const row = ctx.db.query("SELECT enabled, next_run FROM crons WHERE id = ?").get(c.id);
  expect(row).toEqual({ enabled: 0, next_run: null });
});

test("auto-fix : une tâche par cible, pas de doublon", async () => {
  ctx.db.query("INSERT INTO projects (id, name, created_at) VALUES ('infra', 'Infra', 0)").run();
  const tg = { kind: "http", target: "https://exemple.test", projectId: "infra" };
  for (let i = 0; i < 4; i++) await mod.applyResult(ctx, tg, { status: "down", detail: "timeout" });
  const tasks = ctx.db.query("SELECT * FROM tasks WHERE title LIKE 'Auto-fix%'").all();
  expect(tasks.length).toBe(1);
  expect(tasks[0].priority).toBe(0);
  // rétabli puis re-down immédiatement : tâche encore ouverte -> pas de 2e tâche
  await mod.applyResult(ctx, tg, { status: "ok", detail: "200" });
  await mod.applyResult(ctx, tg, { status: "down", detail: "500" });
  await mod.applyResult(ctx, tg, { status: "down", detail: "500" });
  expect(ctx.db.query("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Auto-fix%'").get().n).toBe(1);
});

test("routes /api/crons, /api/ideas, /api/quotas + outils", async () => {
  const H = { authorization: `Bearer ${ctx.config.internalToken}`, "content-type": "application/json" };
  let r = await app.request("/api/crons", { method: "POST", headers: H, body: JSON.stringify({ name: "test", schedule: "0 9 * * 1", prompt: "lundi" }) });
  expect(r.status).toBe(200);
  r = await app.request("/api/crons", { method: "POST", headers: H, body: JSON.stringify({ name: "bad", schedule: "nope", prompt: "x" }) });
  expect(r.status).toBe(400);
  const list = await (await app.request("/api/crons", { headers: H })).json();
  expect(list.find((c: any) => c.name === "test").nextRunParis).toMatch(/ 09:00$/);
  await ctx.tools.run("idea_add", { title: "SEO", body: "ajouter un sitemap" }, { userId: null, projectId: "infra", threadId: null, taskId: null, caller: "brain" });
  const ideas = await (await app.request("/api/ideas", { headers: H })).json();
  expect(ideas[0].title).toBe("SEO");
  mod.refreshQuotas(ctx, () => [{ provider: "claude", window: "5h", usedPct: 40, resetsAt: Date.now() + 1000, updatedAt: Date.now() }]);
  const q = await (await app.request("/api/quotas", { headers: H })).json();
  expect(q[0].usedPct).toBe(40);
});

test("migration Hermes : crons importés désactivés, horaires UTC non repris", () => {
  const dir = mkdtempSync(join(tmpdir(), "nbh-"));
  writeFileSync(join(dir, "jobs.json"), JSON.stringify({ jobs: [
    { id: "a1", name: "brief-hn", schedule: { kind: "cron", expr: "0 6 * * *" }, script: "x.py", enabled: false },
    { id: "b2", name: "suivi", schedule: { kind: "interval", minutes: 20 }, prompt: "surveille", enabled: true },
  ] }));
  ctx.db.query("DELETE FROM settings WHERE key = 'import.hermes_crons'").run();
  const crontab = "CRON_TZ=UTC\n0 10 * * * /usr/bin/a.sh\nCRON_TZ=Europe/Paris\n*/30 * * * * /usr/bin/b.sh # tag-b\n";
  const res = mod.migrateHermes(ctx, { jobsPath: join(dir, "jobs.json"), crontab });
  expect(res.imported).toBe(4);
  const rows = ctx.db.query("SELECT name, schedule, enabled FROM crons WHERE name LIKE '[hermes]%' ORDER BY name").all();
  expect(rows.every((r: any) => r.enabled === 0)).toBe(true);
  expect(rows.find((r: any) => r.name === "[hermes] brief-hn").schedule).toBeNull();
  expect(rows.find((r: any) => r.name === "[hermes] suivi").schedule).toBe("*/20 * * * *");
  expect(rows.find((r: any) => r.name === "[hermes] crontab tag-b").schedule).toBe("*/30 * * * *");
  expect(mod.migrateHermes(ctx, { jobsPath: join(dir, "jobs.json"), crontab }).skipped).toBe(true);
});
