// Module « proactive » : scheduler (heure de Paris), brief du matin, santé + auto-fix, quotas,
// relance des tâches en suspens, idées, migration des crons Hermes (désactivés, pour revue).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Module, Ctx } from "@novabot/daemon/core";
import { coolifyToken, fromRow, insert, update, ensureModuleSchema, createTask, patchTask, addTaskEvent, mainThread, dispatchToBrain, canAccessProject } from "@novabot/daemon/core";
import type { Cron, HealthCheck, Idea, Quota, Task } from "@novabot/shared";
import { id, now } from "@novabot/shared";
import { nextRun, parseAt, parseCron, formatParis } from "./cron.ts";
import { readClaudeQuotas, readCodexQuotas, effective } from "./quotas.ts";
import { buildTargets, evaluate, canAutofix, type CheckState } from "./health.ts";

export const BRIEF_PROMPT = "@system:brief";
const TICK_MS = 30_000, HEALTH_MS = 5 * 60_000, QUOTA_MS = 2 * 60_000, RELAUNCH_MS = 5 * 60_000;
const CATCHUP_MAX_MS = 3600_000;

// ---------------- crons ----------------
function listCrons(ctx: Ctx): Cron[] { return (ctx.db.query("SELECT * FROM crons ORDER BY name").all() as any[]).map((r) => fromRow<Cron>(r)); }
function getCron(ctx: Ctx, cid: string): Cron | null { return fromRow<Cron>(ctx.db.query("SELECT * FROM crons WHERE id = ?").get(cid)) ?? null; }

export function computeNext(c: Pick<Cron, "schedule" | "onceAt" | "enabled">, from: number): number | null {
  if (!c.enabled) return null;
  if (c.onceAt) return c.onceAt;
  if (c.schedule) return nextRun(c.schedule, from);
  return null;
}

export function addCron(ctx: Ctx, i: { name: string; schedule?: string | null; at?: string | null; onceAt?: number | null; prompt: string; projectId?: string | null; enabled?: boolean }): Cron {
  if (!i.schedule && !i.at && !i.onceAt) throw new Error("schedule (cron 5 champs, heure de Paris) ou at (\"AAAA-MM-JJ HH:MM\", heure de Paris) requis");
  if (i.schedule) parseCron(i.schedule); // valide
  const onceAt = i.onceAt ?? (i.at ? parseAt(i.at) : null);
  if (onceAt && onceAt < now() - 60_000) throw new Error(`date passée : ${formatParis(onceAt)} (heure de Paris)`);
  const c: Cron = { id: id("c_"), name: i.name, schedule: i.schedule ?? null, onceAt, prompt: i.prompt, projectId: i.projectId ?? null, enabled: i.enabled ?? true, lastRun: null, nextRun: null };
  c.nextRun = computeNext(c, now());
  insert(ctx.db, "crons", c as any);
  return c;
}

function patchCron(ctx: Ctx, cid: string, p: Partial<Cron>): Cron {
  const cur = getCron(ctx, cid); if (!cur) throw new Error(`cron inconnu: ${cid}`);
  if (p.schedule) parseCron(p.schedule);
  const merged = { ...cur, ...p };
  update(ctx.db, "crons", "id", cid, { ...p, nextRun: computeNext(merged, now()) });
  return getCron(ctx, cid)!;
}

/** Tick du scheduler. Exporté pour les tests (horloge injectable). */
export async function tick(ctx: Ctx, t = now(), run: (c: Cron) => Promise<void> = (c) => executeCron(ctx, c)) {
  const due = (ctx.db.query("SELECT * FROM crons WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?").all(t) as any[]).map((r) => fromRow<Cron>(r));
  for (const c of due) {
    const late = t - (c.nextRun ?? t);
    const once = !!c.onceAt;
    // prochaine échéance calculée AVANT l'exécution : pas de double déclenchement si l'exécution est lente
    const next = once ? null : c.schedule ? nextRun(c.schedule, t) : null;
    update(ctx.db, "crons", "id", c.id, { nextRun: next, lastRun: late <= CATCHUP_MAX_MS ? t : c.lastRun, ...(once ? { enabled: false } : {}) });
    if (late > CATCHUP_MAX_MS) { ctx.log("proactive", `cron ${c.name} manqué de ${Math.round(late / 60000)} min : ignoré`); continue; }
    try { await run(c); } catch (e) { ctx.log("proactive", `cron ${c.name} erreur`, e); }
  }
  // crons actifs sans échéance (créés à la main, ou après redémarrage) -> calcul
  for (const r of ctx.db.query("SELECT * FROM crons WHERE enabled = 1 AND next_run IS NULL").all() as any[]) {
    const c = fromRow<Cron>(r);
    const n = computeNext(c, t);
    if (n !== null && !(c.onceAt && c.lastRun)) update(ctx.db, "crons", "id", c.id, { nextRun: n });
  }
}

async function executeCron(ctx: Ctx, c: Cron) {
  if (c.prompt === BRIEF_PROMPT) { await runBrief(ctx); return; }
  const thread = mainThread(ctx, c.projectId);
  const m = ctx.postMessage({ threadId: thread.id, role: "user", authorId: null, content: c.prompt, meta: { source: "cron", cronId: c.id, cronName: c.name, authorName: `⏰ ${c.name}` } });
  dispatchToBrain(ctx, m, thread, null);
}

function ensureBrief(ctx: Ctx) {
  const has = ctx.db.query("SELECT 1 FROM crons WHERE prompt = ?").get(BRIEF_PROMPT);
  if (!has) addCron(ctx, { name: "brief", schedule: "0 7 * * *", prompt: BRIEF_PROMPT, projectId: null });
}

// ---------------- brief ----------------
export function briefData(ctx: Ctx, t = now()) {
  const since = t - 24 * 3600_000;
  const q = (sql: string, ...a: any[]) => (ctx.db.query(sql).all(...a) as any[]).map((r) => fromRow<any>(r));
  return {
    done: q("SELECT id, project_id, title, summary FROM tasks WHERE status = 'done' AND finished_at >= ? ORDER BY finished_at", since),
    failed: q("SELECT id, project_id, title, summary FROM tasks WHERE status = 'failed' AND finished_at >= ?", since),
    waiting: q("SELECT id, project_id, title, question FROM tasks WHERE status IN ('waiting','blocked')"),
    running: q("SELECT id, project_id, title FROM tasks WHERE status IN ('running','verifying','queued')"),
    alerts: q("SELECT target, status, detail FROM health_checks WHERE status != 'ok'"),
    quotas: q("SELECT * FROM quotas").map((x: Quota) => effective(x, t)),
    ideas: q("SELECT project_id, title FROM ideas WHERE status = 'new' AND created_at >= ?", since),
  };
}

export async function runBrief(ctx: Ctx) {
  const d = briefData(ctx);
  let agenda: unknown = null;
  const cal = ctx.tools.get("calendar_today");
  if (cal) { try { agenda = await cal.run({}, { userId: null, projectId: null, threadId: null, taskId: null, caller: "brain" }); } catch (e) { agenda = `indisponible (${String((e as any)?.message ?? e).slice(0, 80)})`; } }
  const data = JSON.stringify({ ...d, agenda, date: formatParis(now()) });
  let text: string;
  const brain = ctx.services.brain;
  if (brain) {
    try {
      text = await brain.complete({
        tier: "fast",
        system: `Tu es Novabot, l'assistant de ${ctx.config.ownerName}. Tu tutoies, tu écris en français, court et concret. Pas de formule de politesse.`,
        prompt: `Rédige le brief du matin de ${ctx.config.ownerName} à partir de ces données JSON (24 dernières heures). Sections courtes avec puces, dans cet ordre, en omettant celles qui sont vides : 📅 Agenda du jour, ✅ Fini cette nuit, ⏳ En attente de toi (avec la question), 🔴 Alertes, 📊 Quotas (seulement si > 70 %), 💡 Idées. Termine par une ligne « Aujourd'hui je m'occupe de : … » si des tâches tournent. 15 lignes max.\n\n${data}`,
      });
    } catch (e) { text = fallbackBrief(d) + `\n\n_(cerveau indisponible : ${String((e as any)?.message ?? e).slice(0, 100)})_`; }
  } else text = fallbackBrief(d);
  const thread = mainThread(ctx, null);
  ctx.postMessage({ threadId: thread.id, role: "assistant", authorId: null, content: text, meta: { kind: "brief", source: "cron" } });
  await ctx.services.notify.send({ title: "☀️ Brief du matin", body: text.slice(0, 300), level: "info", projectId: null, threadId: thread.id });
  return text;
}

function fallbackBrief(d: ReturnType<typeof briefData>) {
  const L: string[] = ["**Brief du matin**"];
  const sec = (title: string, items: string[]) => { if (items.length) L.push(`\n${title}`, ...items.map((s) => `- ${s}`)); };
  sec("✅ Fini", d.done.map((t: any) => `${t.projectId ?? "global"} : ${t.title}`));
  sec("❌ Échoué", d.failed.map((t: any) => `${t.projectId ?? "global"} : ${t.title}`));
  sec("⏳ En attente de toi", d.waiting.map((t: any) => `${t.projectId ?? "global"} : ${t.title}${t.question ? ` — ${t.question.split("\n")[0]}` : ""}`));
  sec("🔴 Alertes", d.alerts.map((a: any) => `${a.target} : ${a.status} (${a.detail ?? ""})`));
  sec("📊 Quotas", d.quotas.filter((q: Quota) => q.usedPct >= 70).map((q: Quota) => `${q.provider} ${q.window} : ${q.usedPct} %`));
  sec("💡 Idées", d.ideas.map((i: any) => i.title));
  if (L.length === 1) L.push("Rien à signaler.");
  return L.join("\n");
}

// ---------------- santé ----------------
const states = new Map<string, CheckState>();

function lastAutofix(ctx: Ctx, target: string) {
  const r = ctx.db.query("SELECT a.created_at, t.status FROM proactive_autofix a LEFT JOIN tasks t ON t.id = a.task_id WHERE a.target = ? ORDER BY a.created_at DESC LIMIT 1").get(target) as any;
  return r ? { createdAt: r.created_at as number, taskStatus: (r.status ?? null) as string | null } : null;
}

/** Applique un résultat de sonde : état, évènement, notification, auto-fix. Exporté pour les tests. */
export async function applyResult(ctx: Ctx, tg: { kind: HealthCheck["kind"]; target: string; projectId: string | null }, r: { status: HealthCheck["status"]; detail: string | null }, t = now()) {
  const prevRow = fromRow<HealthCheck>(ctx.db.query("SELECT * FROM health_checks WHERE target = ?").get(tg.target));
  const prev = states.get(tg.target) ?? (prevRow ? { status: prevRow.status, fails: prevRow.status === "down" ? 2 : 0 } : undefined);
  const { next, transition } = evaluate(prev, r);
  states.set(tg.target, next);
  const check: HealthCheck = { id: prevRow?.id ?? id("h_"), kind: tg.kind, target: tg.target, status: next.status, detail: r.detail, checkedAt: t };
  ctx.db.query("INSERT INTO health_checks (id, kind, target, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at, kind = excluded.kind")
    .run(check.id, check.kind, check.target, check.status, check.detail, check.checkedAt);
  if (!prevRow || prevRow.status !== next.status) ctx.bus.emit({ type: "health", check });
  if (transition === "down") {
    await ctx.services.notify.send({ title: `🔴 ${tg.target} est down`, body: r.detail ?? "", level: "alert", projectId: tg.projectId });
    if (tg.projectId && canAutofix(lastAutofix(ctx, tg.target), t)) {
      const task = createTask(ctx, {
        projectId: tg.projectId, priority: 0, title: `Auto-fix : ${tg.target}`,
        goal: `Diagnostique et corrige : ${tg.target} est down (${r.detail ?? "sans détail"}). Lis les logs (voir la fiche projet : logs/services), trouve la cause racine, corrige, redéploie si nécessaire (push sur la branche déployée), puis vérifie avec curl que c'est rétabli. Rien de destructif.`,
        doneCriteria: `${tg.target} répond correctement (curl / statut OK) et la cause est expliquée.`, createdBy: "proactive",
      });
      insert(ctx.db, "proactive_autofix", { id: id("af_"), target: tg.target, taskId: task.id, createdAt: t });
    }
  } else if (transition === "up") {
    await ctx.services.notify.send({ title: `🟢 ${tg.target} rétabli`, body: r.detail ?? "", level: "info", projectId: tg.projectId });
  }
  return { check, transition };
}

let healthRunning = false;
export async function runHealth(ctx: Ctx, concurrency = 6) {
  if (healthRunning) return { checked: 0 };
  healthRunning = true;
  try {
    const projects = (ctx.db.query("SELECT id, notes FROM projects").all() as any[]);
    const cf = ctx.config.coolify;
    const coolify = cf?.url ? { url: cf.url, token: coolifyToken(cf), appProjectMap: cf.appProjectMap, ignoreDomainSuffix: cf.ignoreDomainSuffix } : null;
    const targets = await buildTargets({ coolify, projects, extraUrls: ctx.config.healthUrls ?? [] });
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const tg = targets[i++];
        try { await applyResult(ctx, tg, await tg.probe()); } catch (e) { ctx.log("proactive", `check ${tg.target}`, e); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { checked: targets.length };
  } finally { healthRunning = false; }
}

// ---------------- quotas ----------------
export function refreshQuotas(ctx: Ctx, read = () => [...readClaudeQuotas(), ...readCodexQuotas()]) {
  const qs = read();
  for (const q of qs) {
    const prev = ctx.db.query("SELECT used_pct, resets_at FROM quotas WHERE provider = ? AND window = ?").get(q.provider, q.window) as any;
    ctx.db.query("INSERT INTO quotas (provider, window, used_pct, resets_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, window) DO UPDATE SET used_pct = excluded.used_pct, resets_at = excluded.resets_at, updated_at = excluded.updated_at")
      .run(q.provider, q.window, q.usedPct, q.resetsAt, q.updatedAt);
    if (!prev || prev.used_pct !== q.usedPct || prev.resets_at !== q.resetsAt) ctx.bus.emit({ type: "quota", quota: q });
  }
  return qs;
}
const allQuotas = (ctx: Ctx, t = now()): Quota[] => (ctx.db.query("SELECT * FROM quotas ORDER BY provider, window").all() as any[]).map((r) => effective(fromRow<Quota>(r), t));

// ---------------- relances ----------------
export function relaunch(ctx: Ctx, t = now()) {
  const orch = ctx.services.orchestrator;
  if (!orch) return { resumed: 0, resubmitted: 0 };
  let resumed = 0, resubmitted = 0;
  const waiting = (ctx.db.query("SELECT * FROM tasks WHERE status = 'waiting' AND question IS NULL").all() as any[]).map((r) => fromRow<Task>(r));
  for (const task of waiting) {
    const ev = fromRow<any>(ctx.db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task.id));
    if (!ev || ev.type !== "quota_wait") continue;
    let resetsAt: number | null = Number(ev.data?.resetsAt) || null;
    if (!resetsAt && ev.data?.provider) resetsAt = (ctx.db.query("SELECT MAX(resets_at) AS r FROM quotas WHERE provider = ?").get(ev.data.provider) as any)?.r ?? null;
    if (!resetsAt || resetsAt > t) continue;
    const tk = patchTask(ctx, task.id, { status: "queued" });
    addTaskEvent(ctx, task.id, "resumed", { reason: "quota rétabli" });
    orch.submit(tk); resumed++;
  }
  const st = orch.status();
  if (st.queued === 0 && st.running === 0) {
    const orphans = (ctx.db.query("SELECT * FROM tasks WHERE status = 'queued' AND updated_at < ?").all(t - 10 * 60_000) as any[]).map((r) => fromRow<Task>(r));
    for (const task of orphans) { const tk = patchTask(ctx, task.id, {}); addTaskEvent(ctx, task.id, "resubmitted", { reason: "tâche orpheline" }); orch.submit(tk); resubmitted++; }
  }
  return { resumed, resubmitted };
}

// ---------------- migration crons Hermes / crontab ----------------
function tzNote(expr: string) { return `horaire d'origine en UTC : \`${expr}\` — à convertir en heure de Paris avant activation`; }
export function intervalToCron(minutes: number): string | null {
  if (minutes > 0 && minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes >= 60 && minutes % 60 === 0 && 24 % (minutes / 60) === 0) return `0 */${minutes / 60} * * *`;
  return null;
}

/** Migration optionnelle (une seule fois) des crons Hermes Agent (NOVABOT_IMPORT_HERMES_DIR/cron/jobs.json)
 *  et, si NOVABOT_IMPORT_CRONTAB=1, de la crontab de l'utilisateur. Tout est importé désactivé, pour revue. */
export function migrateHermes(ctx: Ctx, opts: { jobsPath?: string; crontab?: string | null } = {}) {
  if (ctx.db.query("SELECT 1 FROM settings WHERE key = 'import.hermes_crons'").get()) return { imported: 0, skipped: true };
  const jobsPath = opts.jobsPath ?? join(ctx.config.import?.hermesDir ?? join(homedir(), ".hermes"), "cron/jobs.json");
  const wantCrontab = opts.crontab !== undefined || ctx.config.import?.crontab === true;
  if (!existsSync(jobsPath) && !wantCrontab) return { imported: 0, skipped: true }; // rien à migrer : ignoré silencieusement
  let imported = 0;
  if (existsSync(jobsPath)) {
    try {
      const jobs = JSON.parse(readFileSync(jobsPath, "utf8")).jobs ?? [];
      for (const j of jobs) {
        const s = j.schedule ?? {};
        const schedule = s.kind === "interval" ? intervalToCron(Number(s.minutes)) : null; // cron Hermes = UTC -> pas d'horaire auto
        const lines = [`[Origine Hermes] job « ${j.name} » (${j.id}), état ${j.state ?? (j.enabled ? "actif" : "en pause")}.`];
        if (s.kind === "cron") lines.push(tzNote(s.expr));
        if (s.kind === "interval") lines.push(`intervalle d'origine : ${s.display ?? s.minutes + " min"}`);
        if (j.script) lines.push(`script Hermes : ${j.script} (dans ~/.hermes/scripts)`);
        if (j.deliver) lines.push(`livraison d'origine : ${j.deliver}`);
        if (j.prompt) lines.push("", j.prompt);
        addCron(ctx, { name: `[hermes] ${j.name}`, schedule: schedule ?? "0 0 1 1 *", prompt: lines.join("\n"), enabled: false });
        if (!schedule) ctx.db.query("UPDATE crons SET schedule = NULL WHERE name = ?").run(`[hermes] ${j.name}`);
        imported++;
      }
    } catch (e) { ctx.log("proactive", "migration jobs.json", e); }
  }
  const crontab = opts.crontab !== undefined ? opts.crontab : wantCrontab ? readCrontab() : null;
  if (crontab) {
    let cronTz = "UTC"; // fuseau système = Etc/UTC
    let n = 0;
    for (const raw of crontab.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const env = line.match(/^([A-Z_]+)=(.*)$/);
      if (env) { if (env[1] === "CRON_TZ") cronTz = env[2].trim(); continue; }
      const m = line.match(/^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (!m) continue;
      const [, expr, cmd] = m;
      const tag = cmd.match(/#\s*([\w.-]+)\s*$/)?.[1];
      const paris = cronTz === "Europe/Paris";
      let schedule: string | null = null;
      try { if (paris && expr !== "@reboot") { parseCron(expr); schedule = expr; } } catch { schedule = null; }
      const prompt = [`[Origine crontab, CRON_TZ=${cronTz}] — NE PAS activer sans retirer la ligne de la crontab (doublon).`, paris ? `horaire : \`${expr}\` (Paris)` : expr === "@reboot" ? "au démarrage (@reboot)" : tzNote(expr), "", "Commande d'origine :", "```", cmd, "```"].join("\n");
      const name = `[hermes] crontab ${tag ?? ++n}`;
      addCron(ctx, { name, schedule: schedule ?? "0 0 1 1 *", prompt, enabled: false });
      if (!schedule) ctx.db.query("UPDATE crons SET schedule = NULL WHERE name = ?").run(name);
      imported++;
    }
  }
  ctx.db.query("INSERT INTO settings (key, value) VALUES ('import.hermes_crons', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now()));
  ctx.log("proactive", `${imported} crons Hermes/crontab importés (désactivés)`);
  return { imported, skipped: false };
}

function readCrontab(): string | null {
  try { const p = Bun.spawnSync(["crontab", "-l"], { stdout: "pipe", stderr: "pipe" }); return p.exitCode === 0 ? p.stdout.toString() : null; } catch { return null; }
}

// ---------------- module ----------------
const timers: ReturnType<typeof setInterval>[] = [];

const mod: Module = {
  name: "proactive",
  init(ctx) {
    ensureModuleSchema(ctx.db, "proactive", 1, `CREATE TABLE IF NOT EXISTS proactive_autofix (id TEXT PRIMARY KEY, target TEXT NOT NULL, task_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS proactive_autofix_target ON proactive_autofix(target, created_at);`);
    ensureBrief(ctx);
    if (process.env.NOVABOT_SKIP_HERMES_IMPORT !== "1") migrateHermes(ctx);
    const T = ctx.tools;
    const shape = (c: Cron) => ({ ...c, nextRunParis: c.nextRun ? formatParis(c.nextRun) : null, onceAtParis: c.onceAt ? formatParis(c.onceAt) : null });
    T.register({
      name: "cron_add",
      description: "Programme une action récurrente (schedule = cron 5 champs, heure de Paris, ex. \"0 9 * * 1\") ou ponctuelle (at = \"AAAA-MM-JJ HH:MM\" heure de Paris, one-shot supprimé après exécution). Le prompt sera envoyé au cerveau à l'échéance.",
      inputSchema: { type: "object", required: ["name", "prompt"], properties: { name: { type: "string" }, prompt: { type: "string" }, schedule: { type: "string" }, at: { type: "string" }, projectId: { type: "string" } } },
      async run(i: any, tc) { return shape(addCron(ctx, { ...i, projectId: i.projectId ?? tc.projectId })); },
    });
    T.register({ name: "cron_list", description: "Liste les crons (avec prochaine exécution en heure de Paris).", inputSchema: { type: "object", properties: {} }, async run() { return listCrons(ctx).map(shape); } });
    T.register({
      name: "cron_remove", description: "Supprime un cron Novabot.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      async run({ id: cid }: { id: string }) { const c = getCron(ctx, cid); if (!c) throw new Error("cron inconnu"); if (c.prompt === BRIEF_PROMPT) throw new Error("le brief se désactive (cron_toggle), il ne se supprime pas"); ctx.db.query("DELETE FROM crons WHERE id = ?").run(cid); return { ok: true }; },
    });
    T.register({
      name: "cron_toggle", description: "Active ou désactive un cron.", inputSchema: { type: "object", required: ["id", "enabled"], properties: { id: { type: "string" }, enabled: { type: "boolean" } } },
      async run(i: { id: string; enabled: boolean }) { return shape(patchCron(ctx, i.id, { enabled: i.enabled })); },
    });
    T.register({ name: "quota_status", description: "Quotas d'abonnement Claude et Codex (fenêtres 5 h et 7 j, % utilisé, reset).", inputSchema: { type: "object", properties: {} }, async run() { return allQuotas(ctx).map((q) => ({ ...q, resetsAtParis: q.resetsAt ? formatParis(q.resetsAt) : null })); } });
    T.register({
      name: "health_status", description: "État de santé des sites, déploiements Coolify et services (seulement ce qui n'est pas OK par défaut).",
      inputSchema: { type: "object", properties: { all: { type: "boolean" } } },
      async run(i: { all?: boolean }) { return (ctx.db.query(i.all ? "SELECT * FROM health_checks ORDER BY target" : "SELECT * FROM health_checks WHERE status != 'ok' ORDER BY target").all() as any[]).map((r) => fromRow(r)); },
    });
    T.register({
      name: "idea_add", description: "Note une idée / suggestion d'amélioration pour le propriétaire (boîte à idées). Ne l'applique jamais toi-même.",
      inputSchema: { type: "object", required: ["title", "body"], properties: { title: { type: "string" }, body: { type: "string" }, projectId: { type: "string" } } },
      async run(i: { title: string; body: string; projectId?: string }, tc) {
        const idea: Idea = { id: id("i_"), projectId: i.projectId ?? tc.projectId ?? null, title: i.title, body: i.body, status: "new", createdAt: now() };
        insert(ctx.db, "ideas", idea as any); ctx.bus.emit({ type: "idea", idea }); return { ideaId: idea.id };
      },
    });
  },
  routes(app, ctx) {
    const admin = (c: any) => c.get("user").role === "admin";
    app.get("/api/crons", (c) => {
      const u = c.get("user");
      return c.json(listCrons(ctx).filter((x) => admin(c) || (x.projectId && canAccessProject(ctx.db, u, x.projectId))).map((x) => ({ ...x, nextRunParis: x.nextRun ? formatParis(x.nextRun) : null })));
    });
    app.post("/api/crons", async (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      try { return c.json(addCron(ctx, await c.req.json())); } catch (e: any) { return c.json({ error: String(e.message) }, 400); }
    });
    app.patch("/api/crons/:id", async (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      const b = await c.req.json<any>();
      const p: Partial<Cron> = {};
      for (const k of ["name", "schedule", "prompt", "projectId", "enabled"] as const) if (b[k] !== undefined) (p as any)[k] = b[k];
      if (b.at !== undefined) p.onceAt = b.at ? parseAt(b.at) : null;
      try { return c.json(patchCron(ctx, c.req.param("id"), p)); } catch (e: any) { return c.json({ error: String(e.message) }, 400); }
    });
    app.delete("/api/crons/:id", (c) => {
      if (!admin(c)) return c.json({ error: "forbidden" }, 403);
      const cr = getCron(ctx, c.req.param("id"));
      if (cr?.prompt === BRIEF_PROMPT) return c.json({ error: "le brief se désactive, il ne se supprime pas" }, 400);
      ctx.db.query("DELETE FROM crons WHERE id = ?").run(c.req.param("id")); return c.json({ ok: true });
    });
    app.get("/api/health", (c) => {
      if (!admin(c)) return c.json([]); // santé = infra du propriétaire
      return c.json((ctx.db.query("SELECT * FROM health_checks ORDER BY status DESC, target").all() as any[]).map((r) => fromRow<HealthCheck>(r)));
    });
    app.post("/api/health/run", async (c) => admin(c) ? c.json(await runHealth(ctx)) : c.json({ error: "forbidden" }, 403));
    app.get("/api/quotas", (c) => admin(c) ? c.json(allQuotas(ctx)) : c.json([]));
    app.get("/api/ideas", (c) => {
      const u = c.get("user");
      const status = c.req.query("status");
      const rows = (status ? ctx.db.query("SELECT * FROM ideas WHERE status = ? ORDER BY created_at DESC LIMIT 200").all(status) : ctx.db.query("SELECT * FROM ideas ORDER BY created_at DESC LIMIT 200").all()) as any[];
      return c.json(rows.map((r) => fromRow<Idea>(r)).filter((i) => admin(c) || (i.projectId && canAccessProject(ctx.db, u, i.projectId))));
    });
    app.patch("/api/ideas/:id", async (c) => {
      const idea = fromRow<Idea>(ctx.db.query("SELECT * FROM ideas WHERE id = ?").get(c.req.param("id")));
      if (!idea || !(admin(c) || (idea.projectId && canAccessProject(ctx.db, c.get("user"), idea.projectId)))) return c.json({ error: "not_found" }, 404);
      const b = await c.req.json<{ status: Idea["status"] }>();
      if (!["new", "accepted", "dismissed"].includes(b.status)) return c.json({ error: "status invalide" }, 400);
      update(ctx.db, "ideas", "id", idea.id, { status: b.status });
      const updated = { ...idea, status: b.status }; ctx.bus.emit({ type: "idea", idea: updated }); return c.json(updated);
    });
    app.post("/api/brief/run", async (c) => admin(c) ? c.json({ text: await runBrief(ctx) }) : c.json({ error: "forbidden" }, 403));
  },
  start(ctx) {
    const safe = (name: string, f: () => unknown) => async () => { try { await f(); } catch (e) { ctx.log("proactive", `${name} erreur`, e); } };
    const sched = safe("tick", () => tick(ctx));
    const health = safe("health", () => runHealth(ctx));
    const quotas = safe("quotas", () => refreshQuotas(ctx));
    const rel = safe("relaunch", () => relaunch(ctx));
    quotas(); sched();
    setTimeout(health, 20_000); // laisse le daemon démarrer
    timers.push(setInterval(sched, TICK_MS), setInterval(health, HEALTH_MS), setInterval(quotas, QUOTA_MS), setInterval(rel, RELAUNCH_MS));
  },
  stop() { for (const t of timers.splice(0)) clearInterval(t); },
};
export default mod;
