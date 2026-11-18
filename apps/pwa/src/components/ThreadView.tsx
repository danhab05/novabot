import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronDown, Menu, PanelRight, Plus, SquarePen, UserPlus } from "lucide-react";
import type { Message, Task } from "@novabot/shared";
import { useStore, store, projKey } from "../lib/store";
import { loadOlder, newThread, openThread, setMobileTab } from "../lib/actions";
import { openSessions, sessionsFor } from "../lib/sessions";
import { MessageItem } from "./MessageItem";
import { TaskCard } from "./TaskCard";
import { Composer, type ComposerApi } from "./Composer";
import { ProjectAvatar } from "./ProjectAvatar";
import { ClaudeIcon, CodexIcon } from "./AgentIcons";
import { ShareDialog } from "./ShareDialog";
import { cls } from "../lib/format";

const EMPTY: Message[] = [];

type Live = { id: string; role: "assistant"; content: string; createdAt: number; meta: null; authorId: null };
type Row = { kind: "msg"; at: number; m: Message } | { kind: "live"; at: number; m: Live } | { kind: "task"; at: number; t: Task };

const SUGGEST_PROJECT = ["Où en est le projet ?", "Corrige le dernier bug signalé", "Déploie la branche en cours", "Fais une passation"];
const SUGGEST_GLOBAL = ["Brief de la journée", "Qu'est-ce qui est bloqué ?", "État des quotas", "Rappelle-moi ce soir à 21 h…"];

export function ThreadView() {
  const threadId = useStore((s) => s.threadId);
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId) ?? null);
  const threads = useStore((s) => s.threads[projKey(s.projectId)]);
  const messages = useStore((s) => (s.threadId ? s.messages[s.threadId] : undefined) ?? EMPTY);
  const loaded = useStore((s) => !!(s.threadId && s.messages[s.threadId]));
  const streaming = useStore((s) => s.streaming);
  const tasks = useStore((s) => s.tasks);
  const panelOpen = useStore((s) => s.panelOpen);
  const [threadMenu, setThreadMenu] = useState(false);
  const section = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerApi>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [noMore, setNoMore] = useState(false);

  useEffect(() => { setNoMore(false); stick.current = true; setAtBottom(true); setUnread(false); }, [threadId]);
  useKeyboardInset();

  // Un seul tableau : le message en streaming garde sa clé quand il devient définitif (pas de remount, pas de saut).
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    const ids = new Set<string>();
    for (const m of messages) {
      ids.add(m.id);
      const meta = m.meta as any;
      if (meta?.kind === "task" && meta.taskId && tasks[meta.taskId]) continue;
      r.push({ kind: "msg", at: m.createdAt, m });
    }
    for (const t of Object.values(tasks)) if (t.threadId && t.threadId === threadId) r.push({ kind: "task", at: t.createdAt, t });
    r.sort((a, b) => a.at - b.at);
    for (const [id, v] of Object.entries(streaming)) {
      if (v.threadId !== threadId || ids.has(id)) continue;
      r.push({ kind: "live", at: Infinity, m: { id, role: "assistant", content: v.text, createdAt: Date.now(), meta: null, authorId: null } });
    }
    return r;
  }, [messages, tasks, threadId, streaming]);
  const hasLive = rows.length > 0 && rows[rows.length - 1].kind === "live";

  // le cerveau « réfléchit » : dernier message du propriétaire sans réponse ni streaming
  const last = messages[messages.length - 1];
  const thinking = !hasLive && last?.role === "user" && Date.now() - last.createdAt < 120_000;

  // mon propre message : on recolle en bas ; sinon, nouveau contenu hors de vue → pastille sur le bouton
  const prevLast = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (last?.id && last.id !== prevLast.current) {
      if (last.role === "user") stick.current = true;
      else if (!stick.current && prevLast.current) setUnread(true);
    }
    prevLast.current = last?.id;
  }, [last?.id, last?.role]);

  const toBottom = (smooth = false) => {
    const el = scroller.current; if (!el) return;
    if (smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => { if (stick.current) toBottom(); }, [rows, thinking, threadId]);

  // Toute variation de taille (streaming, images, cartes qui s'ouvrent, clavier, composer) garde le bas collé.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const d = dock.current, sec = section.current;
      if (d && sec) sec.style.setProperty("--composer-h", d.offsetHeight + "px");
      if (stick.current) toBottom();
    });
    for (const el of [scroller.current, content.current, dock.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // bouton « copier » des blocs de code (délégation)
  const onClick = (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest("[data-copy]") as HTMLButtonElement | null;
    if (!b) return;
    const code = b.closest(".code")?.querySelector("code")?.textContent ?? "";
    navigator.clipboard?.writeText(code).then(() => {
      b.textContent = "Copié"; b.classList.add("copied");
      setTimeout(() => { b.textContent = "Copier"; b.classList.remove("copied"); }, 1400);
    }).catch(() => {});
  };

  const onScroll = async () => {
    const el = scroller.current; if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom && unread) setUnread(false);
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
  const empty = loaded && !rows.length;

  return (
    <section ref={section} className="h-full flex flex-col min-w-0 relative">
      <header className="h-14 shrink-0 glass hairline-b flex items-center gap-1.5 md:gap-2 px-2 md:px-4 safe-top z-10 box-content">
        <button className="md:hidden icon-btn w-10 h-10" onClick={() => setMobileTab("projects")} aria-label="Projets"><Menu size={19} /></button>
        {project ? <ProjectAvatar id={project.id} name={project.name} size={28} /> : <div className="orb" />}
        <div className="min-w-[72px] flex-1 relative">
          <button onClick={() => setThreadMenu((v) => !v)} className="group max-w-full flex flex-col items-start text-left rounded-lg px-1.5 -mx-0.5 py-0.5 hover:bg-bg3 transition-colors" title="Fils de discussion" aria-label="Fils de discussion">
            <span className="font-semibold truncate max-w-full leading-tight tracking-tight text-[14.5px]">{title}</span>
            <span className="text-[11.5px] text-fg3 leading-tight flex items-center gap-1 max-w-full">
              <span className="truncate">{thread?.title ?? (project ? project.stack : "fil global")}</span>
              <ChevronDown size={12} className={cls("shrink-0 transition-transform", threadMenu && "rotate-180")} />
            </span>
          </button>
          {threadMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setThreadMenu(false)} />
              <div className="absolute left-0 top-full mt-2 z-30 w-72 max-w-[calc(100vw-24px)] max-h-96 overflow-y-auto glass border border-line rounded-2xl p-1.5 pop-in" style={{ boxShadow: "var(--shadow-lg)" }}>
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
        {project && <SessionButtons projectId={project.id} />}
        {project && <ShareButton project={project} />}
        <button onClick={() => newThread()} className="icon-btn shrink-0 max-md:w-10 max-md:h-10" title="Nouveau fil" aria-label="Nouveau fil"><SquarePen size={16} /></button>
        <button onClick={() => store.set((s) => ({ panelOpen: !s.panelOpen }))} className={cls("hidden md:inline-flex icon-btn shrink-0", panelOpen && "text-fg bg-bg3")} title="Panneau latéral" aria-label="Panneau latéral"><PanelRight size={16} /></button>
      </header>

      <div ref={scroller} onScroll={onScroll} onClick={onClick} className="flex-1 overflow-y-auto overscroll-contain px-4 md:px-8" style={{ overflowAnchor: "none" }}>
        <div ref={content} className={cls("max-w-[var(--chat-w)] mx-auto flex flex-col gap-7 pt-6", empty && "min-h-full")} style={{ paddingBottom: "calc(var(--composer-h, 120px) + 28px)" }}>
          {loadingOlder && <div className="text-center text-fg3 text-[12px] shimmer-text">Chargement des anciens messages…</div>}
          {!loaded && threadId && (
            <div className="flex flex-col gap-6">
              {[0, 1, 2].map((i) => i % 2
                ? <div key={i} className="skeleton h-10 w-2/5 self-end rounded-[20px]" />
                : <div key={i} className="flex gap-3"><div className="skeleton w-[26px] h-[26px] rounded-[9px]" /><div className="flex-1 flex flex-col gap-2"><div className="skeleton h-3 w-11/12" /><div className="skeleton h-3 w-4/5" /><div className="skeleton h-3 w-3/5" /></div></div>)}
            </div>
          )}
          {empty && <EmptyState name={project?.name ?? null} suggestions={project ? SUGGEST_PROJECT : SUGGEST_GLOBAL} onPick={(s) => (s.endsWith("…") ? composer.current?.prefill(s.slice(0, -1)) : composer.current?.send(s))} />}
          {rows.map((r) => r.kind === "task"
            ? <div key={"t" + r.t.id} className="md:pl-[42px]"><TaskCard task={r.t} /></div>
            : <MessageItem key={r.m.id} m={r.m} streamingText={r.kind === "live"} />)}
          {thinking && (
            <div className="flex items-center gap-3 md:gap-4 msg-in" role="status">
              <div className="orb orb-think" />
              <span className="shimmer-text text-[14.5px] font-medium">Novabot réfléchit…</span>
            </div>
          )}
        </div>
      </div>

      <button className={cls("to-bottom", atBottom && "off")} onClick={() => { stick.current = true; setUnread(false); toBottom(true); }} aria-label="Revenir en bas" tabIndex={atBottom ? -1 : 0}>
        <ArrowDown size={17} />{unread && <span className="new" />}
      </button>

      <div className="absolute inset-x-0 bottom-0 pointer-events-none">
        <div ref={dock} className="pointer-events-auto fade-bottom pt-6">
          <Composer key={threadId ?? "none"} apiRef={composer} disabled={!threadId} placeholder={project ? `Message pour ${project.name}…` : undefined} />
        </div>
      </div>
    </section>
  );
}

/** iOS ne redimensionne pas la page à l'ouverture du clavier : on suit le visualViewport. */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const root = document.getElementById("root"); if (!root) return;
    const on = () => {
      const kb = Math.abs(vv.scale - 1) < 0.01 && window.innerHeight - vv.height > 120;
      document.documentElement.classList.toggle("kb-open", kb);
      root.style.height = kb ? vv.height + "px" : "";
      if (kb) window.scrollTo(0, 0);
    };
    vv.addEventListener("resize", on);
    return () => { vv.removeEventListener("resize", on); document.documentElement.classList.remove("kb-open"); root.style.height = ""; };
  }, []);
}

function EmptyState({ name, suggestions, onPick }: { name: string | null; suggestions: string[]; onPick: (s: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center py-10 fade-in">
      <div className="orb orb-lg orb-float mb-6" />
      <div className="text-[24px] md:text-[28px] font-semibold tracking-tight mb-2 leading-tight">{name ? <>Que fait-on sur <span className="grad-text" style={{ backgroundImage: "var(--grad-nova)" }}>{name}</span> ?</> : <>Que veux-tu <span className="grad-text" style={{ backgroundImage: "var(--grad-nova)" }}>faire</span> ?</>}</div>
      <div className="text-[14px] text-fg2 max-w-md mx-auto mb-8">Je réponds directement, ou je lance Claude Code / Codex dans Herdr et je te rends le résultat vérifié.</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-[560px]">
        {suggestions.map((s, i) => (
          <button key={s} className="suggest msg-in" style={{ animationDelay: `${80 + i * 50}ms` }} onClick={() => onPick(s)}>{s}</button>
        ))}
      </div>
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
