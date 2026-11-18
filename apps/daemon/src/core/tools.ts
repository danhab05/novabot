import type { Ctx } from "./context.ts";
import { fromRow, insert, update } from "./db.ts";
import type { Task, Project, TaskStatus } from "@novabot/shared";
import { id, now } from "@novabot/shared";

export function getTask(ctx: Ctx, taskId: string): Task | null {
  return fromRow<Task>(ctx.db.query("SELECT * FROM tasks WHERE id = ?").get(taskId)) ?? null;
}

export function addTaskEvent(ctx: Ctx, taskId: string, type: string, data: Record<string, unknown> | null = null) {
  const ev = { id: id("e_"), taskId, type, data, createdAt: now() };
  insert(ctx.db, "task_events", ev);
  const t = getTask(ctx, taskId);
  ctx.bus.emit({ type: "task.event", event: ev, projectId: t?.projectId ?? null });
  return ev;
}

export function patchTask(ctx: Ctx, taskId: string, patch: Partial<Task>): Task {
  const p: any = { ...patch, updatedAt: now() };
  if (patch.status && ["done", "failed", "cancelled"].includes(patch.status)) p.finishedAt = now();
  update(ctx.db, "tasks", "id", taskId, p);
  const t = getTask(ctx, taskId)!;
  ctx.bus.emit({ type: "task", task: t });
  return t;
}

/** Crée une tâche en base (queued) et la soumet à l'orchestrateur. */
export function createTask(ctx: Ctx, t: Pick<Task, "title" | "goal"> & Partial<Task>): Task {
  const task: Task = {
    id: id("k_"), projectId: t.projectId ?? null, threadId: t.threadId ?? null, title: t.title, goal: t.goal,
    doneCriteria: t.doneCriteria ?? null, status: "queued", priority: t.priority ?? 1, agentKind: t.agentKind ?? null,
    model: t.model ?? null, effort: t.effort ?? null, herdrAgent: null, herdrPane: null, branch: t.branch ?? null, worktree: null,
    attempts: 0, evidence: null, summary: null, question: null, createdBy: t.createdBy ?? null, createdAt: now(), updatedAt: now(), finishedAt: null,
  };
  insert(ctx.db, "tasks", task as any);
  addTaskEvent(ctx, task.id, "created", { title: task.title });
  ctx.bus.emit({ type: "task", task });
  if (ctx.services.orchestrator) ctx.services.orchestrator.submit(task);
  else addTaskEvent(ctx, task.id, "warning", { message: "orchestrateur absent : tâche en attente" });
  return task;
}

export function coreTools(ctx: Ctx) {
  const T = ctx.tools;
  const owner = ctx.config.ownerName;

  T.register({
    name: "project_list", description: `Liste les projets de ${owner} (id, nom, dossier, chemin, stack).`,
    inputSchema: { type: "object", properties: {} },
    async run() { return (ctx.db.query("SELECT id, name, folder_id, path, stack FROM projects ORDER BY name").all() as any[]).map((r) => fromRow(r)); },
  });
  T.register({
    name: "project_info", description: "Fiche complète d'un projet (notes, chemin, stack, autonomie, tâches actives).",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    async run({ projectId }: { projectId: string }, tc) {
      const pid = projectId ?? tc.projectId;
      const p = fromRow<Project>(ctx.db.query("SELECT * FROM projects WHERE id = ?").get(pid));
      if (!p) throw new Error(`projet inconnu: ${pid}`);
      const tasks = (ctx.db.query("SELECT id, title, status FROM tasks WHERE project_id = ? AND status NOT IN ('done','failed','cancelled')").all(pid) as any[]);
      return { ...p, activeTasks: tasks };
    },
  });
  T.register({
    name: "task_create",
    description: "Crée une tâche lourde (code, déploiement, recherche longue) exécutée par un agent Claude Code ou Codex dans Herdr. Donne un objectif autonome et un critère de fin vérifiable.",
    inputSchema: {
      type: "object", required: ["title", "goal", "projectId"],
      properties: {
        projectId: { type: "string" }, title: { type: "string" }, goal: { type: "string", description: "Prompt autonome et complet pour l'agent" },
        doneCriteria: { type: "string", description: "Critère de fin vérifiable (tests, URL, fichier…)" },
        priority: { type: "integer", enum: [0, 1, 2], description: `0 = prod cassée, 1 = demande de ${owner}, 2 = fond` },
        agentKind: { type: "string", enum: ["claude", "codex"] }, model: { type: "string" }, effort: { type: "string" },
      },
    },
    async run(i: any, tc) {
      const t = createTask(ctx, { ...i, threadId: tc.threadId, createdBy: tc.userId ?? "brain" });
      return { taskId: t.id, status: t.status };
    },
  });
  T.register({
    name: "task_list", description: "Liste les tâches (filtre statut/projet).",
    inputSchema: { type: "object", properties: { status: { type: "string", description: "ex. running,queued" }, projectId: { type: "string" } } },
    async run(i: { status?: string; projectId?: string }) {
      let sql = "SELECT id, project_id, title, status, agent_kind, model, attempts, summary, question, updated_at FROM tasks WHERE 1=1"; const a: any[] = [];
      if (i.status) { const s = i.status.split(","); sql += ` AND status IN (${s.map(() => "?").join(",")})`; a.push(...s); }
      if (i.projectId) { sql += " AND project_id = ?"; a.push(i.projectId); }
      return (ctx.db.query(sql + " ORDER BY updated_at DESC LIMIT 50").all(...a) as any[]).map((r) => fromRow(r));
    },
  });
  T.register({
    name: "task_update", description: "Ajoute une note de progression à une tâche (visible en direct dans la PWA).",
    inputSchema: { type: "object", required: ["message"], properties: { taskId: { type: "string" }, message: { type: "string" } } },
    async run(i: { taskId?: string; message: string }, tc) {
      const tid = i.taskId ?? tc.taskId; if (!tid) throw new Error("taskId requis");
      addTaskEvent(ctx, tid, "progress", { message: i.message });
      return { ok: true };
    },
  });
  T.register({
    name: "task_done",
    description: "Déclare la tâche terminée AVEC la preuve (commandes lancées et leur résultat, URL vérifiée, fichiers modifiés). Le vérificateur de Novabot contrôlera.",
    inputSchema: { type: "object", required: ["summary", "evidence"], properties: { taskId: { type: "string" }, summary: { type: "string" }, evidence: { type: "string" } } },
    async run(i: { taskId?: string; summary: string; evidence: string }, tc) {
      const tid = i.taskId ?? tc.taskId; if (!tid) throw new Error("taskId requis");
      patchTask(ctx, tid, { summary: i.summary, evidence: i.evidence });
      addTaskEvent(ctx, tid, "agent_done", { summary: i.summary, evidence: i.evidence });
      return { ok: true, next: "verification" };
    },
  });
  const askOwner = {
    inputSchema: { type: "object", required: ["question", "recommendation"], properties: { taskId: { type: "string" }, question: { type: "string" }, recommendation: { type: "string" } } },
    async run(i: { taskId?: string; question: string; recommendation: string }, tc: any) {
      const q = `${i.question}\n\n**Je recommande :** ${i.recommendation}`;
      const tid = i.taskId ?? tc.taskId;
      let projectId = tc.projectId;
      if (tid) { const t = patchTask(ctx, tid, { status: "waiting" as TaskStatus, question: q }); projectId = t.projectId; addTaskEvent(ctx, tid, "ask_owner", { question: q }); }
      if (tc.threadId) ctx.postMessage({ threadId: tc.threadId, role: "assistant", authorId: null, content: `❓ ${q}`, meta: { kind: "question", taskId: tid } });
      await ctx.services.notify.send({ title: "Novabot a besoin de toi", body: i.question, level: "blocked", projectId, threadId: tc.threadId, url: tid ? `/tasks/${tid}` : undefined });
      return { ok: true, status: "waiting", note: `Arrête-toi ici : la réponse de ${owner} relancera la tâche.` };
    },
  };
  T.register({
    name: "ask_owner",
    description: `Pose UNE question à ${owner}, seulement si l'action est réservée (suppression, DNS, billing, secret manquant, envoi en son nom, paiement) ET qu'il est seul à avoir la réponse. Toujours avec ta recommandation. La tâche passe en attente.`,
    ...askOwner,
  });
  // Alias déprécié (anciens prompts / agents déjà lancés). Caché du cerveau, gardé pour le MCP.
  T.register({ name: "ask_dan", description: "Alias déprécié de ask_owner (même comportement).", ...askOwner });
  T.register({
    name: "notify", description: `Envoie une notification à ${owner} (push + Discord). Pour une fin de tâche, une alerte, un résultat important.`,
    inputSchema: { type: "object", required: ["title", "body"], properties: { title: { type: "string" }, body: { type: "string" }, level: { type: "string", enum: ["info", "done", "blocked", "alert"] }, url: { type: "string" } } },
    async run(i: any, tc) { await ctx.services.notify.send({ ...i, level: i.level ?? "info", projectId: tc.projectId, threadId: tc.threadId }); return { ok: true }; },
  });
  T.register({
    name: "message_post", description: "Poste un message dans le fil courant (ou un fil donné).",
    inputSchema: { type: "object", required: ["content"], properties: { threadId: { type: "string" }, content: { type: "string" } } },
    async run(i: { threadId?: string; content: string }, tc) {
      const th = i.threadId ?? tc.threadId; if (!th) throw new Error("threadId requis");
      const m = ctx.postMessage({ threadId: th, role: "assistant", authorId: null, content: i.content, meta: { via: tc.caller, taskId: tc.taskId } });
      return { messageId: m.id };
    },
  });
}
