// Orchestrateur Herdr : file persistante, lancement des agents, suivi, vérification, reprise.
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, OrchestratorService } from "@novabot/daemon/core";
import { fromRow, ensureModuleSchema, getTask, patchTask, addTaskEvent } from "@novabot/daemon/core";
import type { Task, Project, AgentKind } from "@novabot/shared";
import { type Exec, realExec } from "./exec.ts";
import { Herdr, HerdrError, type HerdrAgent } from "./herdr.ts";
import { DEFAULT_LIMITS, type Limits, type Resources, readResources, resourceBlock, readQuotas, type QuotaState, choose, isCritical, LIMIT_RE, CLAUDE, CODEX } from "./policy.ts";
import { taskPrompt, fixPrompt, answerPrompt, reviewPrompt, verifyPrompt, parseVerdict } from "./prompt.ts";
import { repoInfo, ensureWorktree, gitSummary, isMerged, removeWorktree, slugify } from "./git.ts";

export interface Run {
  taskId: string; agentName: string | null; kind: AgentKind | null; model: string | null; effort: string | null;
  paneId: string | null; workspaceId: string | null; sessionId: string | null; repo: string | null; worktree: string | null; cwd: string | null;
  baseRef: string | null; baseBranch: string | null; branch: string | null; resumeAt: number | null; failures: number; launches: number;
  reviewed: boolean; lastPromptAt: number | null; lastHash: string | null; lastChangeAt: number | null; idleChecks: number; stallNotified: boolean;
}

export interface OrchestratorOpts {
  exec?: Exec; // herdr
  gitExec?: Exec;
  pollMs?: number; // intervalle de la file
  waitMs?: number; // durée d'un agent wait borné
  watchdogMs?: number;
  stallMs?: number; // agent « working » sans changement de sortie → alerte
  resources?: () => Resources;
  quotas?: () => Promise<QuotaState>;
  now?: () => number;
}

const ACTIVE = ["running", "verifying"];
const MAX_FIX = 4; // au-delà : échec
const ESCALATE_AT = 2; // corrections avant escalade

export class Orchestrator implements OrchestratorService {
  readonly herdr: Herdr;
  private exec: Exec; private git: Exec;
  private monitors = new Map<string, Promise<void>>();
  private ticking = false; private timers: ReturnType<typeof setInterval>[] = [];
  private lastBlock: string | null = null;
  private o: Required<Omit<OrchestratorOpts, "exec" | "gitExec">>;

  constructor(private ctx: Ctx, opts: OrchestratorOpts = {}) {
    this.exec = opts.exec ?? realExec; this.git = opts.gitExec ?? realExec;
    this.herdr = new Herdr(this.exec);
    this.o = {
      pollMs: opts.pollMs ?? 15_000, waitMs: opts.waitMs ?? 240_000, watchdogMs: opts.watchdogMs ?? 60_000, stallMs: opts.stallMs ?? 30 * 60_000,
      resources: opts.resources ?? readResources, quotas: opts.quotas ?? (() => readQuotas(realExec)), now: opts.now ?? Date.now,
    };
    ensureModuleSchema(ctx.db, "herdr", 1, `
      CREATE TABLE IF NOT EXISTS herdr_runs (task_id TEXT PRIMARY KEY, agent_name TEXT, kind TEXT, model TEXT, effort TEXT, pane_id TEXT, workspace_id TEXT,
        session_id TEXT, repo TEXT, worktree TEXT, cwd TEXT, base_ref TEXT, base_branch TEXT, branch TEXT, resume_at INTEGER, failures INTEGER NOT NULL DEFAULT 0,
        launches INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0, last_prompt_at INTEGER, last_hash TEXT, last_change_at INTEGER,
        idle_checks INTEGER NOT NULL DEFAULT 0, stall_notified INTEGER NOT NULL DEFAULT 0);`);
  }

  // ---------------- état persistant ----------------
  run(taskId: string): Run | null {
    const r = this.ctx.db.query("SELECT * FROM herdr_runs WHERE task_id = ?").get(taskId) as any;
    if (!r) return null;
    const o = fromRow<any>(r);
    return { ...o, reviewed: !!r.reviewed, stallNotified: !!r.stall_notified } as Run;
  }
  private saveRun(taskId: string, patch: Partial<Run>) {
    const cur = this.run(taskId) ?? ({ taskId, failures: 0, launches: 0, reviewed: false, idleChecks: 0, stallNotified: false } as Run);
    const r = { ...cur, ...patch };
    this.ctx.db.query(`INSERT INTO herdr_runs (task_id, agent_name, kind, model, effort, pane_id, workspace_id, session_id, repo, worktree, cwd, base_ref, base_branch, branch,
        resume_at, failures, launches, reviewed, last_prompt_at, last_hash, last_change_at, idle_checks, stall_notified)
      VALUES ($t,$an,$k,$m,$e,$p,$w,$s,$repo,$wt,$cwd,$br,$bb,$b,$ra,$f,$l,$rv,$lp,$lh,$lc,$ic,$sn)
      ON CONFLICT(task_id) DO UPDATE SET agent_name=$an, kind=$k, model=$m, effort=$e, pane_id=$p, workspace_id=$w, session_id=$s, repo=$repo, worktree=$wt, cwd=$cwd,
        base_ref=$br, base_branch=$bb, branch=$b, resume_at=$ra, failures=$f, launches=$l, reviewed=$rv, last_prompt_at=$lp, last_hash=$lh, last_change_at=$lc, idle_checks=$ic, stall_notified=$sn`).run({
      t: taskId, an: r.agentName ?? null, k: r.kind ?? null, m: r.model ?? null, e: r.effort ?? null, p: r.paneId ?? null, w: r.workspaceId ?? null, s: r.sessionId ?? null,
      repo: r.repo ?? null, wt: r.worktree ?? null, cwd: r.cwd ?? null, br: r.baseRef ?? null, bb: r.baseBranch ?? null, b: r.branch ?? null, ra: r.resumeAt ?? null,
      f: r.failures ?? 0, l: r.launches ?? 0, rv: r.reviewed ? 1 : 0, lp: r.lastPromptAt ?? null, lh: r.lastHash ?? null, lc: r.lastChangeAt ?? null, ic: r.idleChecks ?? 0, sn: r.stallNotified ? 1 : 0,
    } as any);
    return r;
  }
  private project(t: Task): Project | null {
    return t.projectId ? fromRow<Project>(this.ctx.db.query("SELECT * FROM projects WHERE id = ?").get(t.projectId)) ?? null : null;
  }
  limits(): Limits {
    const row = this.ctx.db.query("SELECT value FROM settings WHERE key = 'herdr.limits'").get() as any;
    // priorité : réglage en base (settings herdr.limits) > NOVABOT_HERDR_LIMITS (JSON) > défauts
    let envL: Partial<Limits> = {};
    try { envL = process.env.NOVABOT_HERDR_LIMITS ? JSON.parse(process.env.NOVABOT_HERDR_LIMITS) : {}; } catch { /* JSON invalide : ignoré */ }
    try { return { ...DEFAULT_LIMITS, ...envL, ...(row ? JSON.parse(row.value) : {}) }; } catch { return { ...DEFAULT_LIMITS, ...envL }; }
  }
  private log(...a: unknown[]) { this.ctx.log("herdr", ...a); }

  // ---------------- interface OrchestratorService ----------------
  submit(_task: Task) { queueMicrotask(() => this.tick().catch((e) => this.log("tick", e))); }

  status() {
    const c = (s: string) => (this.ctx.db.query("SELECT COUNT(*) AS n FROM tasks WHERE status = ?").get(s) as any).n as number;
    return { running: c("running") + c("verifying"), queued: c("queued"), resources: this.o.resources() };
  }

  async cancel(taskId: string) {
    const r = this.run(taskId);
    if (r?.paneId && r.agentName?.startsWith("nb-")) await this.closePane(r.paneId);
    patchTask(this.ctx, taskId, { status: "cancelled" });
    addTaskEvent(this.ctx, taskId, "cancelled", null);
    this.cleanupRunFiles(taskId);
    await this.closeWorkspaceIfIdle(r?.workspaceId ?? null);
  }

  async answer(taskId: string, answer: string, userId: string | null) {
    const t = getTask(this.ctx, taskId);
    if (!t) throw new Error("tâche inconnue");
    addTaskEvent(this.ctx, taskId, "answered", { answer, userId });
    const r = this.run(taskId);
    const alive = r?.agentName ? await this.herdr.agentGet(r.agentName) : null;
    patchTask(this.ctx, taskId, { status: "running", question: null });
    if (alive) {
      await this.prompt(taskId, r!.agentName!, answerPrompt(answer));
      this.monitor(taskId);
    } else if (r) {
      await this.relaunch(getTask(this.ctx, taskId)!, answerPrompt(answer));
    } else {
      patchTask(this.ctx, taskId, { status: "queued" });
      this.submit(t);
    }
  }

  // ---------------- cycle de vie ----------------
  async start() {
    // reprise après redémarrage du daemon
    for (const row of this.ctx.db.query(`SELECT * FROM tasks WHERE status IN ('running','verifying')`).all() as any[]) {
      const t = fromRow<Task>(row); const r = this.run(t.id);
      const alive = r?.agentName ? await this.herdr.agentGet(r.agentName).catch(() => null) : null;
      addTaskEvent(this.ctx, t.id, "recovered", { alive: !!alive });
      if (alive) { if (t.status === "verifying") patchTask(this.ctx, t.id, { status: "running" }); this.monitor(t.id); }
      else if (r) await this.relaunch(t).catch((e) => this.fail(t.id, `reprise impossible : ${e.message}`));
      else patchTask(this.ctx, t.id, { status: "queued" });
    }
    this.timers.push(setInterval(() => this.tick().catch((e) => this.log("tick", e)), this.o.pollMs));
    this.timers.push(setInterval(() => this.watchdog().catch((e) => this.log("watchdog", e)), this.o.watchdogMs));
    await this.tick();
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // reprises après quota
      const due = this.ctx.db.query(`SELECT t.* FROM tasks t JOIN herdr_runs r ON r.task_id = t.id WHERE t.status = 'waiting' AND t.question IS NULL AND r.resume_at IS NOT NULL AND r.resume_at <= ?`).all(this.o.now()) as any[];
      for (const row of due) await this.resumeAfterQuota(fromRow<Task>(row));

      const queued = (this.ctx.db.query(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority, created_at`).all() as any[]).map((r) => fromRow<Task>(r));
      for (const t of queued) {
        const running = (this.ctx.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running','verifying')`).get() as any).n;
        const block = resourceBlock(this.o.resources(), this.limits(), t.priority, running);
        if (block) {
          if (this.lastBlock !== `${t.id}:${block}`) { addTaskEvent(this.ctx, t.id, "queued_resources", { reason: block }); this.lastBlock = `${t.id}:${block}`; }
          break; // FIFO par priorité : on n'en saute pas une
        }
        await this.launch(t);
      }
    } finally { this.ticking = false; }
  }

  // ---------------- lancement ----------------
  private agentName(t: Task, launches: number, prefix = "nb") {
    const p = (t.projectId ?? "x").replace(/[^a-z0-9-]/g, "").slice(0, 12) || "x";
    return `${prefix}-${p}-${t.id.slice(2, 8)}-${launches}`.slice(0, 32);
  }

  private async prepareCwd(t: Task, project: Project | null): Promise<Partial<Run>> {
    const existing = this.run(t.id);
    if (existing?.cwd && existsSync(existing.cwd)) return existing;
    const base = project?.path && existsSync(project.path) ? project.path : join(this.ctx.config.dataDir, "workspace", t.projectId ?? "global");
    mkdirSync(base, { recursive: true });
    const repo = await repoInfo(this.git, base);
    if (!repo || project?.autonomy === "readonly") return { cwd: base, repo: repo?.top ?? null, worktree: null, branch: null, baseRef: repo?.head ?? null, baseBranch: repo?.branch ?? null };
    const slug = `${slugify(t.title, 30)}-${t.id.slice(2, 6)}`;
    const branch = t.branch ?? `nb/${slug}`;
    const wtPath = join(this.ctx.config.dataDir, "worktrees", t.projectId ?? "global", slug);
    const { cwd } = await ensureWorktree(this.git, { repo, projectPath: base, wtPath, branch });
    return { cwd, repo: repo.top, worktree: wtPath, branch, baseRef: repo.head, baseBranch: repo.branch };
  }

  private mcpEnv(t: Task): Record<string, string> {
    const url = `http://${this.ctx.config.host === "0.0.0.0" ? "127.0.0.1" : this.ctx.config.host}:${this.ctx.config.port}`;
    return {
      NOVABOT_URL: url, NOVABOT_INTERNAL_TOKEN: this.ctx.config.internalToken,
      NOVA_TASK_ID: t.id, ...(t.projectId ? { NOVA_PROJECT_ID: t.projectId } : {}), ...(t.threadId ? { NOVA_THREAD_ID: t.threadId } : {}),
    };
  }

  /** Arguments natifs de l'agent (Claude skip-permissions + IS_SANDBOX, Codex --yolo). */
  agentArgs(t: Task, kind: AgentKind, model: string, effort: string, resumeId?: string | null): string[] {
    const mcpScript = new URL("../../mcp/src/index.ts", import.meta.url).pathname;
    const bun = process.execPath;
    const env = this.mcpEnv(t);
    if (kind === "claude") {
      const dir = join(this.ctx.config.dataDir, "run"); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${t.id}.mcp.json`);
      writeFileSync(file, JSON.stringify({ mcpServers: { novabot: { type: "stdio", command: bun, args: [mcpScript], env } } }, null, 2), { mode: 0o600 });
      return [...(resumeId ? ["--resume", resumeId] : []), "--dangerously-skip-permissions", "--model", model, "--effort", effort, "--mcp-config", file];
    }
    const toml = (o: Record<string, string>) => `{${Object.entries(o).filter(([k]) => k !== "NOVABOT_INTERNAL_TOKEN").map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")}}`;
    return [
      ...(resumeId ? ["resume", resumeId] : []),
      "-m", model, "-c", `model_reasoning_effort="${effort}"`, "--yolo",
      "-c", `mcp_servers.novabot.command=${JSON.stringify(bun)}`,
      "-c", `mcp_servers.novabot.args=[${JSON.stringify(mcpScript)}]`,
      "-c", `mcp_servers.novabot.env=${toml(env)}`,
      // le jeton n'est pas mis dans argv : transmis par l'environnement du panneau
      "-c", `mcp_servers.novabot.env_vars=["NOVABOT_INTERNAL_TOKEN"]`,
    ];
  }

  /** Ouvre un panneau shell dédié (workspace nb-<projet>, un onglet par agent). */
  private async openPane(t: Task, cwd: string, label: string): Promise<{ paneId: string; workspaceId: string }> {
    const wsLabel = `nb-${t.projectId ?? "global"}`.slice(0, 40);
    const env = { IS_SANDBOX: "1", NOVABOT_INTERNAL_TOKEN: this.ctx.config.internalToken };
    const ws = (await this.herdr.workspaces()).find((w) => w.label === wsLabel);
    if (ws) {
      const r = await this.herdr.tabCreate({ workspaceId: ws.workspace_id, cwd, label, env });
      return { paneId: r.paneId, workspaceId: ws.workspace_id };
    }
    const r = await this.herdr.workspaceCreate({ cwd, label: wsLabel, env });
    return { paneId: r.paneId, workspaceId: r.workspaceId };
  }

  private async closePane(paneId: string) {
    try { await this.herdr.paneClose(paneId); } catch (e) { this.log("close", paneId, (e as Error).message); }
  }

  /** Ferme un workspace nb-* quand plus aucun agent n'y tourne (jamais un workspace qui n'est pas à Novabot). */
  private async closeWorkspaceIfIdle(workspaceId: string | null) {
    if (!workspaceId) return;
    try {
      const ws = (await this.herdr.workspaces()).find((w) => w.workspace_id === workspaceId);
      if (!ws || !ws.label.startsWith("nb-")) return;
      const busy = (await this.herdr.agents()).some((a) => a.workspace_id === workspaceId);
      const pending = (this.ctx.db.query(`SELECT COUNT(*) AS n FROM tasks t JOIN herdr_runs r ON r.task_id = t.id WHERE r.workspace_id = ? AND t.status IN ('running','verifying','waiting','blocked')`).get(workspaceId) as any).n;
      if (!busy && !pending) await this.herdr.workspaceClose(workspaceId);
    } catch (e) { this.log("workspace", workspaceId, (e as Error).message); }
  }

  private cleanupRunFiles(taskId: string) {
    try { rmSync(join(this.ctx.config.dataDir, "run", `${taskId}.mcp.json`), { force: true }); } catch {}
  }

  async launch(t: Task, opts: { resumeId?: string | null; initialPrompt?: string; escalate?: boolean } = {}) {
    const project = this.project(t);
    const prev = this.run(t.id);
    const launches = (prev?.launches ?? 0) + 1;
    try {
      const where = await this.prepareCwd(t, project);
      const quotas = await this.o.quotas();
      const c = opts.resumeId && prev?.kind && prev.model
        ? { kind: prev.kind, model: prev.model, effort: prev.effort ?? "high", reason: "reprise" }
        : choose(t, quotas, opts.escalate ? ESCALATE_AT : 0);
      const name = this.agentName(t, launches);
      const { paneId, workspaceId } = await this.openPane(t, where.cwd!, name);
      this.saveRun(t.id, { ...where, kind: c.kind, model: c.model, effort: c.effort, paneId, workspaceId, agentName: name, launches, resumeAt: null, idleChecks: 0, stallNotified: false });
      let agent: HerdrAgent | null;
      try {
        agent = await this.startAgent(name, c.kind, paneId, this.agentArgs(t, c.kind, c.model, c.effort, opts.resumeId));
      } catch (e) { await this.closePane(paneId); throw e; }
      const info = agent ?? (await this.herdr.agentGet(name));
      this.saveRun(t.id, { sessionId: info?.agent_session?.value ?? prev?.sessionId ?? null });
      patchTask(this.ctx, t.id, { status: "running", agentKind: c.kind, model: c.model, effort: c.effort, herdrAgent: name, herdrPane: paneId, branch: where.branch ?? null, worktree: where.worktree ?? null });
      addTaskEvent(this.ctx, t.id, "launched", { agent: name, pane: paneId, kind: c.kind, model: c.model, effort: c.effort, reason: c.reason, cwd: where.cwd, branch: where.branch ?? null, resume: !!opts.resumeId });
      const context = this.ctx.services.memory?.contextFor(t.projectId) ?? null;
      const text = opts.initialPrompt && opts.resumeId ? opts.initialPrompt
        : taskPrompt({ task: t, project, cwd: where.cwd!, branch: where.branch ?? null, context }) + (opts.initialPrompt ? `\n\n${opts.initialPrompt}` : "");
      await this.prompt(t.id, name, text);
      this.monitor(t.id);
    } catch (e: any) {
      this.saveRun(t.id, { launches });
      addTaskEvent(this.ctx, t.id, "launch_failed", { error: String(e?.message ?? e).slice(0, 500), launches });
      const lastOk = (this.ctx.db.query(`SELECT MAX(created_at) AS t FROM task_events WHERE task_id = ? AND type = 'launched'`).get(t.id) as any)?.t ?? 0;
      const consecutive = (this.ctx.db.query(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND type = 'launch_failed' AND created_at >= ?`).get(t.id, lastOk) as any).n;
      if (consecutive >= 3) await this.fail(t.id, `lancement impossible après ${consecutive} essais : ${e?.message ?? e}`);
      else patchTask(this.ctx, t.id, { status: "queued" });
    }
  }

  /** Attend que le shell du panneau soit libre, puis démarre l'agent (réessaie sur agent_pane_busy). */
  private async startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<HerdrAgent | null> {
    for (let i = 0; i < 30 && !(await this.herdr.shellReady(paneId)); i++) await Bun.sleep(500);
    for (let i = 0; ; i++) {
      try { const a = await this.herdr.agentStart({ name, kind, paneId, args }); await this.startupDialogs(name); return a; }
      catch (e) {
        if (i >= 4 || !(e instanceof HerdrError) || !/agent_pane_busy/.test(e.stderr)) throw e;
        await Bun.sleep(2000);
      }
    }
  }

  /**
   * Écrans de démarrage interactifs : « faire confiance à ce dossier » (Claude/Codex, sur le worktree créé par Novabot)
   * et proposition de mise à jour Codex (→ « Skip », règle du skill). Sans ça, le premier prompt + Entrée choisirait « No, exit ».
   */
  private async startupDialogs(name: string) {
    for (let i = 0; i < 12; i++) {
      const screen = await this.herdr.agentRead(name, 40, "visible").catch(() => "");
      if (/Yes, I trust this folder|Do you trust (the files in )?this (folder|directory)|trust this (folder|directory)\?/i.test(screen)) {
        // Claude : option 2 « Yes, I trust this folder » ; Codex : option 1 « Yes, allow… » déjà sélectionnée
        await this.herdr.agentSendKeys(name, /❯\s*No, exit|1\. No/.test(screen) ? ["down", "enter"] : ["enter"]);
      } else if (/codex/i.test(screen) && /update (available|now)/i.test(screen) && /\bSkip\b/.test(screen)) {
        await this.herdr.agentSendKeys(name, ["down", "enter"]);
      } else if (i >= 2) return; // écran normal stable
      await Bun.sleep(Math.min(1500, this.o.pollMs));
    }
  }

  private async prompt(taskId: string, agent: string, text: string) {
    for (let i = 0; i < 3; i++) {
      try {
        await this.herdr.agentPrompt(agent, text);
        this.saveRun(taskId, { lastPromptAt: this.o.now(), idleChecks: 0 });
        addTaskEvent(this.ctx, taskId, "prompt_sent", { chars: text.length });
        // l'agent est encore idle juste après l'envoi : attendre qu'il passe à working (sinon wait() reviendrait aussitôt)
        await this.herdr.agentWait(agent, 20_000, "working").catch(() => null);
        return;
      } catch (e) {
        if (i === 2 || !(e instanceof HerdrError)) throw e;
        await Bun.sleep(3000);
      }
    }
  }

  /** Relance après crash/panneau disparu : reprise de session native si possible, sinon relancement complet. */
  async relaunch(t: Task, extraPrompt?: string) {
    const r = this.run(t.id);
    if ((r?.launches ?? 0) >= 6) { await this.fail(t.id, `agent relancé ${r!.launches} fois sans aboutir`); return; }
    addTaskEvent(this.ctx, t.id, "relaunch", { session: r?.sessionId ?? null });
    await this.launch(t, { resumeId: r?.sessionId ?? null, initialPrompt: extraPrompt ?? (r?.sessionId ? "[Novabot] Ta session a été relancée. Reprends la tâche là où tu en étais, puis termine par `task_done` avec la preuve." : undefined) });
  }

  // ---------------- suivi ----------------
  monitor(taskId: string) {
    if (this.monitors.has(taskId)) return;
    const p = this.loop(taskId).catch((e) => this.log("monitor", taskId, e)).finally(() => this.monitors.delete(taskId));
    this.monitors.set(taskId, p);
  }
  isMonitored(taskId: string) { return this.monitors.has(taskId); }

  private async loop(taskId: string) {
    let unknowns = 0;
    for (;;) {
      const t = getTask(this.ctx, taskId); const r = this.run(taskId);
      if (!t || t.status !== "running" || !r?.agentName) return;
      const waited = await this.herdr.agentWait(r.agentName, this.o.waitMs);
      const a = (await this.herdr.agentGet(r.agentName)) ?? waited;
      const t2 = getTask(this.ctx, taskId)!;
      if (t2.status !== "running") return; // annulée, ask_owner (waiting)…
      if (!a) { addTaskEvent(this.ctx, taskId, "agent_missing", null); await this.relaunch(t2); continue; } // relaunch() rouvre un agent : on continue de le suivre ici
      const tail = await this.herdr.agentRead(r.agentName, 15).catch(() => "");
      this.trackChange(taskId, tail);
      if (LIMIT_RE.test(tail)) { await this.quotaWait(t2, tail); return; }
      if (a.agent_status === "working") { unknowns = 0; continue; }
      if (a.agent_status === "unknown" && ++unknowns < 3) { await Bun.sleep(Math.min(5000, this.o.pollMs)); continue; }
      if (a.agent_status === "blocked") { await this.blocked(t2, await this.herdr.agentRead(r.agentName, 40).catch(() => tail)); return; }
      // idle / done : tâches de fond de l'agent encore actives ?
      const visible = await this.herdr.agentRead(r.agentName, 6, "visible").catch(() => "");
      if (/\b\d+ (shells?|monitors?)\b/.test(visible) && r.idleChecks < 15) { this.saveRun(taskId, { idleChecks: r.idleChecks + 1 }); await Bun.sleep(this.o.pollMs); continue; }
      const next = await this.verify(t2);
      if (next === "stop") return;
    }
  }

  private trackChange(taskId: string, out: string) {
    const h = Bun.hash(out).toString(36);
    const r = this.run(taskId);
    if (r && r.lastHash !== h) this.saveRun(taskId, { lastHash: h, lastChangeAt: this.o.now(), stallNotified: false });
  }

  private async blocked(t: Task, output: string) {
    const q = output.trim().split("\n").slice(-15).join("\n");
    patchTask(this.ctx, t.id, { status: "blocked", question: q });
    addTaskEvent(this.ctx, t.id, "blocked", { output: q });
    await this.ctx.services.notify.send({ title: `Agent bloqué : ${t.title}`, body: q.slice(-500), level: "blocked", projectId: t.projectId, threadId: t.threadId, url: `/tasks/${t.id}` });
  }

  private async quotaWait(t: Task, tail: string) {
    const r = this.run(t.id)!; const q = await this.o.quotas();
    const reset = r.kind === "codex" ? q.codexReset : q.claudeReset;
    const resumeAt = reset && reset > this.o.now() ? reset + 60_000 : this.o.now() + 30 * 60_000;
    this.saveRun(t.id, { resumeAt });
    patchTask(this.ctx, t.id, { status: "waiting", question: null });
    addTaskEvent(this.ctx, t.id, "quota_wait", { resumeAt, excerpt: tail.slice(-300) });
  }

  private async resumeAfterQuota(t: Task) {
    const r = this.run(t.id)!;
    this.saveRun(t.id, { resumeAt: null });
    addTaskEvent(this.ctx, t.id, "quota_resume", null);
    const alive = r.agentName ? await this.herdr.agentGet(r.agentName) : null;
    patchTask(this.ctx, t.id, { status: "running" });
    if (alive) { await this.prompt(t.id, r.agentName!, "[Novabot] Le quota est revenu : reprends la tâche là où tu t'es arrêté, puis termine par `task_done` avec la preuve."); this.monitor(t.id); }
    else await this.relaunch(t);
  }

  // ---------------- vérification (boucle d'autonomie) ----------------
  private agentDone(t: Task, since: number | null): { summary?: string; evidence?: string } | null {
    const row = this.ctx.db.query(`SELECT data FROM task_events WHERE task_id = ? AND type = 'agent_done' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(t.id, since ?? 0) as any;
    return row ? JSON.parse(row.data) : null;
  }

  async verify(t: Task): Promise<"continue" | "stop"> {
    const r = this.run(t.id)!;
    patchTask(this.ctx, t.id, { status: "verifying" });
    addTaskEvent(this.ctx, t.id, "verifying", { attempts: t.attempts });
    const output = await this.herdr.agentRead(r.agentName!, 200).catch(() => "");
    const git = r.worktree && r.baseRef ? await gitSummary(this.git, r.cwd ?? r.worktree, r.baseRef) : "(pas de worktree git)";
    const done = this.agentDone(t, r.lastPromptAt);
    let v = null as ReturnType<typeof parseVerdict>;
    const brain = this.ctx.services.brain;
    if (brain) {
      const p = verifyPrompt({ task: t, git, output, agentDone: done });
      try { v = parseVerdict(await brain.complete({ system: p.system, prompt: p.prompt, tier: "reason", json: true })); }
      catch (e) { addTaskEvent(this.ctx, t.id, "verify_error", { error: String((e as Error).message) }); }
    }
    if (!v) v = done ? { verdict: "done", reason: "task_done déclaré (pas de vérificateur)" } : { verdict: "fix", reason: "Tu t'es arrêté sans appeler `task_done`.", fix: "Si c'est fini : vérifie et appelle `task_done` avec la preuve. Sinon continue jusqu'au bout." };

    // relecture par l'autre famille pour les tâches critiques
    if (v.verdict === "done" && isCritical(t) && !r.reviewed && r.worktree && r.baseRef) {
      const rv = await this.review(t, r);
      this.saveRun(t.id, { reviewed: true });
      if (rv && !rv.ok) v = { verdict: "fix", reason: `relecture ${rv.by} : ${rv.problems}`, fix: "Corrige les problèmes relevés par le relecteur." };
    }
    addTaskEvent(this.ctx, t.id, "verdict", v as any);

    if (v.verdict === "done") { await this.finish(t, done, v.reason); return "stop"; }
    if (v.verdict === "blocked") {
      const q = v.question ?? v.reason;
      patchTask(this.ctx, t.id, { status: "waiting", question: q });
      if (t.threadId) this.ctx.postMessage({ threadId: t.threadId, role: "assistant", authorId: null, content: `❓ ${t.title} : ${q}`, meta: { kind: "question", taskId: t.id } });
      await this.ctx.services.notify.send({ title: "Novabot a besoin de toi", body: q, level: "blocked", projectId: t.projectId, threadId: t.threadId, url: `/tasks/${t.id}` });
      return "stop";
    }
    // fix
    const attempts = t.attempts + 1;
    if (attempts >= MAX_FIX) { await this.fail(t.id, `non validée après ${t.attempts} corrections : ${v.reason}`); return "stop"; }
    patchTask(this.ctx, t.id, { status: "running", attempts });
    if (attempts === ESCALATE_AT) {
      addTaskEvent(this.ctx, t.id, "escalate", { reason: v.reason });
      if (r.paneId) await this.closePane(r.paneId);
      this.saveRun(t.id, { failures: r.failures + 1 });
      await this.launch(getTask(this.ctx, t.id)!, { escalate: true, initialPrompt: `Un agent précédent n'a pas réussi cette tâche dans ce même dossier (son travail est là). Problème : ${v.reason}${v.fix ? `\nAttendu : ${v.fix}` : ""}` });
      return "continue"; // la boucle de suivi courante reprend avec le nouvel agent
    }
    await this.prompt(t.id, r.agentName!, fixPrompt(v.reason, v.fix ?? null));
    return "continue";
  }

  private async review(t: Task, r: Run): Promise<{ ok: boolean; problems: string; by: string } | null> {
    const kind: AgentKind = r.kind === "claude" ? "codex" : "claude";
    const m = kind === "claude" ? CLAUDE[3] : CODEX[3];
    const name = this.agentName(t, r.launches, "nb-r");
    try {
      const { paneId } = await this.openPane(t, r.cwd!, name);
      try {
        await this.herdr.agentStart({ name, kind, paneId, args: this.agentArgs(t, kind, m.model, m.effort) });
        await this.herdr.agentPrompt(name, reviewPrompt({ task: t, base: r.baseRef!, cwd: r.cwd! }));
        addTaskEvent(this.ctx, t.id, "review_started", { agent: name, kind, model: m.model });
        const deadline = this.o.now() + 45 * 60_000;
        let a: HerdrAgent | null = null;
        do { await this.herdr.agentWait(name, this.o.waitMs); a = await this.herdr.agentGet(name); }
        while (a?.agent_status === "working" && this.o.now() < deadline);
        const out = await this.herdr.agentRead(name, 120);
        const m2 = [...out.matchAll(/VERDICT:\s*(OK|KO)\s*[—-]?\s*(.*)/g)].pop();
        const res = { ok: !m2 || m2[1] === "OK", problems: m2?.[2]?.trim() ?? "", by: `${kind}/${m.model}` };
        addTaskEvent(this.ctx, t.id, "review_done", res as any);
        return res;
      } finally { await this.closePane(paneId); }
    } catch (e) {
      addTaskEvent(this.ctx, t.id, "review_failed", { error: String((e as Error).message) });
      return null;
    }
  }

  private async finish(t: Task, done: { summary?: string; evidence?: string } | null, reason: string) {
    const r = this.run(t.id)!;
    const summary = done?.summary ?? t.summary ?? reason;
    const fin = patchTask(this.ctx, t.id, { status: "done", summary, evidence: done?.evidence ?? t.evidence });
    addTaskEvent(this.ctx, t.id, "done", { summary });
    if (t.threadId) this.ctx.postMessage({ threadId: t.threadId, role: "assistant", authorId: null, content: `✅ **${t.title}** — ${summary}${fin.evidence ? `\n\nPreuve : ${fin.evidence}` : ""}`, meta: { kind: "task_done", taskId: t.id } });
    if (t.projectId) {
      try {
        const dir = join(this.ctx.config.dataDir, "handoffs"); mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${t.projectId}.md`), `\n\n## ${new Date().toISOString().slice(0, 10)} — ${t.title} (Novabot)\n${summary}${r.branch ? `\nBranche : ${r.branch}` : ""}\n`);
      } catch {}
    }
    await this.ctx.services.notify.send({ title: `Terminé : ${t.title}`, body: summary.slice(0, 300), level: "done", projectId: t.projectId, threadId: t.threadId, url: `/tasks/${t.id}` });
    if (r.paneId) await this.closePane(r.paneId);
    if (r.repo && r.worktree && r.branch && r.baseBranch && (await isMerged(this.git, r.repo, r.branch, r.baseBranch))) {
      const ok = await removeWorktree(this.git, r.repo, r.worktree);
      addTaskEvent(this.ctx, t.id, "worktree", { removed: ok, path: r.worktree });
    }
    this.cleanupRunFiles(t.id);
    await this.closeWorkspaceIfIdle(r.workspaceId);
  }

  private async fail(taskId: string, reason: string) {
    const t = patchTask(this.ctx, taskId, { status: "failed", summary: reason });
    addTaskEvent(this.ctx, taskId, "failed", { reason });
    const r = this.run(taskId);
    if (r?.paneId) await this.closePane(r.paneId);
    this.cleanupRunFiles(taskId);
    await this.closeWorkspaceIfIdle(r?.workspaceId ?? null);
    await this.ctx.services.notify.send({ title: `Échec : ${t.title}`, body: reason.slice(0, 400), level: "alert", projectId: t.projectId, threadId: t.threadId, url: `/tasks/${taskId}` });
  }

  // ---------------- watchdog ----------------
  async watchdog() {
    if (!(await this.herdr.serverRunning())) {
      this.log("watchdog", "serveur Herdr arrêté → démarrage");
      await this.exec("bash", ["-c", "setsid nohup herdr server >/dev/null 2>&1 < /dev/null &"]);
      await Bun.sleep(5000);
    }
    for (const row of this.ctx.db.query(`SELECT * FROM tasks WHERE status IN ('running','verifying')`).all() as any[]) {
      const t = fromRow<Task>(row); const r = this.run(t.id);
      if (!r?.agentName) continue;
      if (this.monitors.has(t.id)) {
        // agent figé : sortie inchangée depuis stallMs
        if (r.lastChangeAt && this.o.now() - r.lastChangeAt > this.o.stallMs && !r.stallNotified) {
          this.saveRun(t.id, { stallNotified: true });
          addTaskEvent(this.ctx, t.id, "stalled", { since: r.lastChangeAt });
          await this.ctx.services.notify.send({ title: `Agent figé ? ${t.title}`, body: `Aucune sortie depuis ${Math.round((this.o.now() - r.lastChangeAt) / 60000)} min.`, level: "alert", projectId: t.projectId, threadId: t.threadId, url: `/tasks/${t.id}` });
        }
        continue;
      }
      const alive = await this.herdr.agentGet(r.agentName).catch(() => null);
      if (alive) { if (t.status === "verifying") patchTask(this.ctx, t.id, { status: "running" }); this.monitor(t.id); }
      else await this.relaunch(t).catch((e) => this.log("relaunch", e));
    }
    await this.tick();
  }
}
