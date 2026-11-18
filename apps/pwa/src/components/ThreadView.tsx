import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Menu, PanelRight, Plus, MessagesSquare, UserPlus } from "lucide-react";
import type { Message, Task } from "@novabot/shared";
import { useStore, store, projKey } from "../lib/store";
import { loadOlder, newThread, openThread, setMobileTab } from "../lib/actions";
import { openSessions, sessionsFor } from "../lib/sessions";
import { MessageItem } from "./MessageItem";
import { TaskCard } from "./TaskCard";
import { Composer } from "./Composer";
import { ProjectAvatar } from "./ProjectAvatar";
import { ClaudeIcon, CodexIcon } from "./AgentIcons";
import { ShareDialog } from "./ShareDialog";
import { cls } from "../lib/format";

const EMPTY: Message[] = [];

type Row = { kind: "msg"; at: number; m: Message } | { kind: "task"; at: number; t: Task };

export function ThreadView() {
  const projectId = useStore((s) => s.projectId);
  const threadId = useStore((s) => s.threadId);
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId) ?? null);
  const threads = useStore((s) => s.threads[projKey(s.projectId)]);
  const messages = useStore((s) => (s.threadId ? s.messages[s.threadId] : undefined) ?? EMPTY);
  const loaded = useStore((s) => !!(s.threadId && s.messages[s.threadId]));
  const streaming = useStore((s) => s.streaming);
  const tasks = useStore((s) => s.tasks);
  const panelOpen = useStore((s) => s.panelOpen);
  const [threadMenu, setThreadMenu] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [noMore, setNoMore] = useState(false);

  useEffect(() => { setNoMore(false); stick.current = true; }, [threadId]);

  const live = useMemo(() => Object.entries(streaming).filter(([, v]) => v.threadId === threadId).map(([id, v]) => ({ id, text: v.text })), [streaming, threadId]);

  const rows = useMemo<Row[]>(() => {
    const r: Row[] = messages.map((m) => ({ kind: "msg", at: m.createdAt, m }));
    const shown = new Set<string>();
    for (const t of Object.values(tasks)) {
      if (t.threadId && t.threadId === threadId && !shown.has(t.id)) { shown.add(t.id); r.push({ kind: "task", at: t.createdAt, t }); }
    }
    return r.sort((a, b) => a.at - b.at);
  }, [messages, tasks, threadId]);

  // le cerveau « réfléchit » : dernier message du propriétaire sans réponse ni streaming
  const last = messages[messages.length - 1];
  const thinking = !live.length && last?.role === "user" && Date.now() - last.createdAt < 120_000;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, live, threadId, thinking]);

  // bouton « copier » des blocs de code (délégation)
  const onClick = (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest("[data-copy]") as HTMLButtonElement | null;
    if (!b) return;
    const code = b.closest(".code")?.querySelector("code")?.textContent ?? "";
    navigator.clipboard?.writeText(code).then(() => { b.textContent = "Copié ✓"; setTimeout(() => (b.textContent = "Copier"), 1400); }).catch(() => {});
  };

  const onScroll = async () => {
    const el = scroller.current; if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && threadId && !loadingOlder && !noMore && messages.length >= 80) {
      setLoadingOlder(true);
      const h = el.scrollHeight;
      try {
        const n = await loadOlder(threadId);
        if (!n) setNoMore(true);
        requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - h; });
      } finally { setLoadingOlder(false); }
    }
  };

  const thread = threads?.find((t) => t.id === threadId);
  const title = project ? project.name : "Novabot";

  return (
    <section className="h-full flex flex-col min-w-0 relative">
      <header className="h-14 shrink-0 glass hairline-b flex items-center gap-2 px-3 md:px-4 safe-top z-10">
        <button className="md:hidden icon-btn -ml-1" onClick={() => setMobileTab("projects")} aria-label="Projets"><Menu size={18} /></button>
        {project ? <ProjectAvatar id={project.id} name={project.name} size={28} /> : <div className="orb" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate leading-tight tracking-tight text-[14.5px]">{title}</div>
          <div className="text-[11.5px] text-fg3 truncate leading-tight">{project?.path ? <span className="font-mono">{project.path}</span> : project ? project.stack : "fil global · tous les projets"}</div>
        </div>
        {project && <SessionButtons projectId={project.id} />}
        {project && <ShareButton project={project} />}
        <div className="relative">
          <button onClick={() => setThreadMenu((v) => !v)} className="btn btn-ghost h-8 px-2 max-w-[150px]" title="Fils de discussion">
            <MessagesSquare size={14} className="shrink-0" /><span className="truncate max-sm:hidden">{thread?.title ?? "Fil"}</span><ChevronDown size={13} className="shrink-0" />
          </button>
          {threadMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setThreadMenu(false)} />
              <div className="absolute right-0 top-full mt-2 z-30 w-72 max-h-96 overflow-y-auto glass border border-line rounded-2xl p-1.5 pop-in" style={{ boxShadow: "var(--shadow-lg)" }}>
                <button onClick={() => { setThreadMenu(false); newThread(); }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-bg3 text-[13px] font-medium"><span className="w-6 h-6 rounded-lg grad-bg flex items-center justify-center"><Plus size={13} /></span>Nouveau fil</button>
                <div className="label-xs px-2.5 pt-2 pb-1">Fils</div>
                {(threads ?? []).map((t) => (
                  <button key={t.id} onClick={() => { setThreadMenu(false); openThread(t.id); }} className={cls("w-full text-left px-2.5 py-2 rounded-xl hover:bg-bg3 text-[13px] truncate", t.id === threadId ? "text-fg bg-bg3" : "text-fg2")}>
                    {t.title}{t.discordThreadId && <span className="text-fg3"> · discord</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button onClick={() => store.set((s) => ({ panelOpen: !s.panelOpen }))} className={cls("hidden md:inline-flex icon-btn", panelOpen && "text-fg bg-bg3")} title="Panneau latéral" aria-label="Panneau latéral"><PanelRight size={16} /></button>
      </header>

      <div ref={scroller} onScroll={onScroll} onClick={onClick} className="flex-1 overflow-y-auto px-4 md:px-8 pt-6 pb-40">
        <div className="max-w-[760px] mx-auto flex flex-col gap-5">
          {loadingOlder && <div className="text-center text-fg3 text-[12px]">Chargement…</div>}
          {!loaded && threadId && (
            <div className="flex flex-col gap-4">
              {[0, 1, 2].map((i) => <div key={i} className={cls("flex flex-col gap-2", i % 2 ? "items-end" : "")}><div className="skeleton h-3 w-24" /><div className={cls("skeleton h-12", i % 2 ? "w-1/2" : "w-3/4")} /></div>)}
            </div>
          )}
          {loaded && !rows.length && !live.length && <EmptyState name={project?.name ?? null} />}
          {rows.map((r) => r.kind === "msg"
            ? (r.m.meta as any)?.taskId && tasks[(r.m.meta as any).taskId] && (r.m.meta as any).kind === "task"
              ? null
              : <MessageItem key={r.m.id} m={r.m} />
            : <TaskCard key={"t" + r.t.id} task={r.t} />)}
          {live.map((l) => <MessageItem key={l.id} m={{ id: l.id, role: "assistant", content: l.text, createdAt: Date.now(), meta: null, authorId: null }} streamingText />)}
          {thinking && (
            <div className="flex items-center gap-3 msg-in">
              <div className="orb orb-think" />
              <div className="typing flex gap-1 items-center"><span /><span /><span /></div>
              <span className="text-[12.5px] text-fg3">Novabot réfléchit…</span>
            </div>
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 pointer-events-none">
        <div className="pointer-events-auto bg-gradient-to-t from-[var(--bg)] from-55% to-transparent pt-8">
          <Composer key={threadId ?? "none"} disabled={!threadId} placeholder={project ? `Message pour ${project.name}…` : undefined} />
        </div>
      </div>
    </section>
  );
}

function EmptyState({ name }: { name: string | null }) {
  return (
    <div className="text-center py-16 fade-in">
      <div className="mx-auto w-14 h-14 rounded-2xl grad-bg flex items-center justify-center mb-5 shadow-[0_12px_40px_-12px_rgba(99,102,241,.8)]">
        <span className="text-xl font-bold">N</span>
      </div>
      <div className="text-[22px] font-semibold tracking-tight mb-1.5">{name ? <>Que fait-on sur <span className="grad-text">{name}</span> ?</> : <>Que veux-tu <span className="grad-text">faire</span> ?</>}</div>
      <div className="text-[13.5px] text-fg2 max-w-md mx-auto">Je réponds directement, ou je lance Claude Code / Codex dans Herdr et je te rends le résultat vérifié.</div>
    </div>
  );
}

/** Boutons « Claude Code » et « Codex » : compteur des sessions Herdr du projet, ouvre le panneau des sessions. */
function SessionButtons({ projectId }: { projectId: string }) {
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const sessions = useStore((s) => s.sessions);
  const panel = useStore((s) => s.panel);
  const panelOpen = useStore((s) => s.panelOpen);
  const kind = useStore((s) => s.sessionKind);
  if (!isAdmin) return null;
  const claude = sessionsFor(sessions, projectId, "claude");
  const codex = sessionsFor(sessions, projectId, "codex");
  const btn = (k: "claude" | "codex", list: typeof claude, label: string, icon: React.ReactNode) => {
    const working = list.some((s) => s.status === "working");
    const on = panelOpen && panel === "sessions" && kind === k;
    return (
      <button onClick={() => (on ? store.set({ panelOpen: false }) : openSessions(k))} className={cls("btn h-8 px-2.5 gap-1.5 whitespace-nowrap shrink-0", on && "chip-on", working && "halo")} title={`Sessions ${label} dans Herdr`}>
        {icon}<span className="max-lg:hidden">{label}</span>
        <span className={cls("tabular-nums text-[11px] min-w-[18px] h-[18px] px-1 rounded-md inline-flex items-center justify-center", list.length ? "bg-bg4 text-fg" : "text-fg3")}>{list.length}</span>
        {working && <span className="dot dot-live" style={{ width: 6, height: 6, background: "var(--info)", color: "var(--info)" }} />}
      </button>
    );
  };
  return (
    <div className="flex items-center gap-1.5">
      {btn("claude", claude, "Claude Code", <ClaudeIcon />)}
      {btn("codex", codex, "Codex", <CodexIcon />)}
    </div>
  );
}

/** Bouton « Partager » (admin) : inviter des gens sur le projet via leur compte Discord. */
function ShareButton({ project }: { project: import("@novabot/shared").Project }) {
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className="btn btn-ghost h-8 px-2 shrink-0" title="Partager le projet (invités Discord)" aria-label="Partager le projet">
        <UserPlus size={14} /><span className="max-xl:hidden">Partager</span>
      </button>
      {open && <ShareDialog project={project} onClose={() => setOpen(false)} />}
    </>
  );
}
