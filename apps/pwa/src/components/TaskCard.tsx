import { useState } from "react";
import { Ban, ChevronDown, GitBranch, Send, SquareTerminal, Timer } from "lucide-react";
import type { Task } from "@novabot/shared";
import { STATUS_COLOR, STATUS_LABEL, ago, isActive, cls } from "../lib/format";
import { answerTask, cancelTask, openTerminal } from "../lib/actions";
import { openSessions } from "../lib/sessions";
import { renderMarkdown } from "../lib/markdown";
import { useStore } from "../lib/store";
import { ClaudeIcon, CodexIcon } from "./AgentIcons";

export function StatusBadge({ status }: { status: Task["status"] }) {
  const c = STATUS_COLOR[status];
  const live = status === "running" || status === "verifying";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 h-[22px] rounded-full" style={{ color: c, background: `color-mix(in oklab, ${c} 13%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 30%, transparent)` }}>
      <span className={cls("dot", live && "dot-live")} style={{ background: c, color: c, width: 6, height: 6 }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

const STEPS = ["File", "En cours", "Vérification", "Fait"] as const;
function stepIndex(s: Task["status"]): number {
  switch (s) {
    case "queued": return 0;
    case "running": case "waiting": case "blocked": return 1;
    case "verifying": return 2;
    case "done": return 3;
    default: return -1;
  }
}

function duration(t: Task): string {
  const end = t.finishedAt ?? (isActive(t.status) ? Date.now() : t.updatedAt);
  const s = Math.max(0, Math.round((end - t.createdAt) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function Steps({ status }: { status: Task["status"] }) {
  const idx = stepIndex(status);
  const failed = status === "failed" || status === "cancelled";
  const color = status === "blocked" || status === "waiting" ? "var(--warn)" : failed ? "var(--bad)" : "var(--accent)";
  return (
    <div className="flex items-center gap-1.5" aria-label="Progression">
      {STEPS.map((label, i) => {
        const done = !failed && i < idx || status === "done";
        const cur = !failed && i === idx && status !== "done";
        return (
          <div key={label} className="flex-1 min-w-0">
            <div className="h-1 rounded-full overflow-hidden bg-bg4">
              <div className={cls("h-full rounded-full transition-all duration-500", cur && "animate-pulse")} style={{ width: done || cur ? "100%" : "0%", background: done ? "var(--grad)" : color, opacity: cur ? .75 : 1 }} />
            </div>
            <div className={cls("text-[10.5px] mt-1 truncate", done || cur ? "text-fg2" : "text-fg3")}>{label}</div>
          </div>
        );
      })}
    </div>
  );
}

export function TaskCard({ task, compact = false }: { task: Task; compact?: boolean }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState(false);
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const session = useStore((s) => (task.herdrPane ? s.sessions?.find((x) => x.paneId === task.herdrPane) : undefined));
  const active = isActive(task.status);
  const working = task.status === "running" || task.status === "verifying";
  const model = [task.model, task.effort].filter(Boolean).join(" · ");

  const submit = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    try { await answerTask(task.id, answer.trim()); setAnswer(""); } finally { setBusy(false); }
  };
  const openSession = () => {
    if (session && (session.kind === "claude" || session.kind === "codex")) openSessions(session.kind, session.paneId);
    else openTerminal(task.id);
  };

  return (
    <div className={cls("card msg-in transition-shadow", !compact && "task-card", compact ? "p-3" : "p-4", working && "halo")}>
      <div className="flex items-start gap-3">
        <div className={cls("shrink-0 rounded-xl flex items-center justify-center bg-bg3 border border-line", compact ? "w-8 h-8" : "w-9 h-9")}>
          {task.agentKind === "codex" ? <CodexIcon size={16} /> : <ClaudeIcon size={16} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold tracking-tight truncate text-[14px]">{task.title}</span>
            <StatusBadge status={task.status} />
          </div>
          <div className="text-fg3 text-[11.5px] mt-1 flex items-center gap-x-3 gap-y-0.5 flex-wrap">
            <span className="text-fg2">{task.agentKind === "codex" ? "Codex" : task.agentKind === "claude" ? "Claude Code" : "Agent"}{model && <span className="text-fg3"> · {model}</span>}</span>
            <span className="inline-flex items-center gap-1"><Timer size={11} />{duration(task)}</span>
            {task.attempts > 0 && <span>tentative {task.attempts}</span>}
            {task.branch && <span className="inline-flex items-center gap-1 font-mono"><GitBranch size={11} />{task.branch}</span>}
            <span>{ago(task.updatedAt)}</span>
          </div>
        </div>
        <div className="flex gap-0.5 shrink-0">
          {isAdmin && task.herdrPane && (
            <button onClick={openSession} className="btn btn-ghost h-8 px-2 gap-1 text-[12px]" title="Ouvrir la session Herdr" aria-label="Session"><SquareTerminal size={14} /><span className="max-sm:hidden">Session</span></button>
          )}
          {active && (
            <button onClick={() => { if (confirm("Annuler cette tâche ?")) cancelTask(task.id); }} className="icon-btn hover:text-bad" title="Annuler" aria-label="Annuler"><Ban size={15} /></button>
          )}
        </div>
      </div>

      {stepIndex(task.status) >= 0 && <div className="mt-3"><Steps status={task.status} /></div>}

      {task.summary && !compact && <div className="md mt-3 text-[13.5px] text-fg2" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.summary) }} />}
      {task.evidence && (
        <div className="mt-2.5">
          <button onClick={() => setProof((v) => !v)} className="inline-flex items-center gap-1 text-[12px] text-fg2 hover:text-fg">
            <ChevronDown size={13} className={cls("transition-transform", proof && "rotate-180")} />Preuve
          </button>
          <div className="grid transition-all duration-300" style={{ gridTemplateRows: proof ? "1fr" : "0fr" }}>
            <div className="overflow-hidden">
              <pre className="mt-1.5 rounded-xl p-3 overflow-x-auto text-[11.5px] font-mono whitespace-pre-wrap border border-line" style={{ background: "var(--term-bg)", color: "#cfd5e6" }}>{task.evidence}</pre>
            </div>
          </div>
        </div>
      )}
      {task.status === "waiting" && task.question && (
        <div className="mt-3 rounded-xl p-3 border" style={{ borderColor: "color-mix(in oklab, var(--warn) 35%, transparent)", background: "color-mix(in oklab, var(--warn) 7%, transparent)" }}>
          <div className="md text-[13.5px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.question) }} />
          {isAdmin && (
            <div className="flex gap-2 mt-2.5">
              <input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Ta réponse…" className="input flex-1 min-w-0" />
              <button disabled={busy || !answer.trim()} onClick={submit} className="btn btn-primary"><Send size={14} />Répondre</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
