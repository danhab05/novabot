import { lazy, Suspense, useState } from "react";
import { ArrowLeft, Globe, ListChecks, SquareTerminal, X } from "lucide-react";
import { useStore, store, type Panel } from "../lib/store";
import { setPanel, setMobileTab } from "../lib/actions";
import { isActive, cls } from "../lib/format";
import { TaskCard } from "./TaskCard";
import { ClaudeIcon } from "./AgentIcons";

const BrowserPanel = lazy(() => import("./BrowserPanel"));
const TerminalPanel = lazy(() => import("./TerminalPanel"));
const SessionsPanel = lazy(() => import("./SessionsPanel"));

const TABS: { id: Panel; label: string; icon: React.ReactNode; admin?: boolean }[] = [
  { id: "tasks", label: "Tâches", icon: <ListChecks size={14} /> },
  { id: "sessions", label: "Sessions", icon: <ClaudeIcon size={13} />, admin: true },
  { id: "browser", label: "Navigateur", icon: <Globe size={14} />, admin: true },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal size={14} />, admin: true },
];

export function RightPanel({ only, mobile }: { only?: Panel[]; mobile?: boolean }) {
  const panel = useStore((s) => s.panel);
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const nActive = useStore((s) => Object.values(s.tasks).filter((t) => isActive(t.status) && (s.projectId ? t.projectId === s.projectId : true)).length);
  const tabs = TABS.filter((t) => (!only || only.includes(t.id)) && (isAdmin || !t.admin));
  const current = tabs.find((t) => t.id === panel)?.id ?? tabs[0]?.id ?? "tasks";
  return (
    <aside className={cls("h-full flex flex-col min-w-0", mobile ? "" : "glass border-l border-line")}>
      <div className="h-14 shrink-0 flex items-center gap-1 px-2 hairline-b safe-top">
        {mobile && <button onClick={() => setMobileTab("thread")} className="icon-btn" aria-label="Retour au fil"><ArrowLeft size={17} /></button>}
        <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-bg3/70 border border-line overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setPanel(t.id)} className={cls("inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] text-[12.5px] font-medium whitespace-nowrap transition-all", current === t.id ? "bg-bg2 text-fg shadow-[inset_0_0_0_1px_var(--line2)]" : "text-fg3 hover:text-fg2")}>
              {t.icon}{t.label}
              {t.id === "tasks" && nActive > 0 && <span className="text-[10.5px] tabular-nums px-1.5 rounded-md bg-info/15 text-info">{nActive}</span>}
            </button>
          ))}
        </div>
        {!mobile && <button onClick={() => store.set({ panelOpen: false })} className="ml-auto icon-btn" aria-label="Fermer le panneau"><X size={16} /></button>}
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="p-4 flex flex-col gap-2"><div className="skeleton h-16" /><div className="skeleton h-16" /></div>}>
          {current === "tasks" && <TasksPanel />}
          {current === "sessions" && <SessionsPanel />}
          {current === "browser" && <BrowserPanel />}
          {current === "terminal" && <TerminalPanel />}
        </Suspense>
      </div>
    </aside>
  );
}

function TasksPanel() {
  const projectId = useStore((s) => s.projectId);
  const tasks = useStore((s) => s.tasks);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const list = Object.values(tasks)
    .filter((t) => (projectId ? t.projectId === projectId : true))
    .filter((t) => filter === "all" || isActive(t.status))
    .sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt);
  return (
    <div className="h-full flex flex-col fade-in">
      <div className="flex gap-1.5 px-3 py-3 text-[12.5px] items-center">
        {(["active", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cls("chip", filter === f && "chip-on")}>
            {f === "active" ? "Actives" : "Toutes"}
          </button>
        ))}
        <span className="ml-auto text-fg3 tabular-nums">{list.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-2.5">
        {list.map((t) => <TaskCard key={t.id} task={t} compact />)}
        {!list.length && (
          <div className="text-center py-14 fade-in">
            <div className="mx-auto w-11 h-11 rounded-2xl bg-bg3 border border-line flex items-center justify-center mb-3 text-fg3"><ListChecks size={18} /></div>
            <div className="text-fg2 text-[13px]">{filter === "active" ? "Aucune tâche en cours." : "Aucune tâche."}</div>
            <div className="text-fg3 text-[12px] mt-1">Les tâches lourdes lancées par Novabot apparaissent ici.</div>
          </div>
        )}
      </div>
    </div>
  );
}
