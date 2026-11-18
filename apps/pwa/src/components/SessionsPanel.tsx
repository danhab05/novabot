import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CornerDownLeft, History, Loader2, Plus, RefreshCw, Send, SquareTerminal, Radio, Maximize2, Minimize2 } from "lucide-react";
import { useStore, store, type SessionInfo, type SessionKind } from "../lib/store";
import { createSession, createInputSender, refreshSessions, sessionsFor, STATUS_COLOR, STATUS_LABEL, type TermOp } from "../lib/sessions";
import { cls } from "../lib/format";
import { ClaudeIcon, CodexIcon } from "./AgentIcons";
import type { ScreenInfo } from "./XTerm";

const XTerm = lazy(() => import("./XTerm"));

export const KIND_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

export default function SessionsPanel() {
  const projectId = useStore((s) => s.projectId);
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId) ?? null);
  const kind = useStore((s) => s.sessionKind);
  const pane = useStore((s) => s.sessionPane);
  const sessions = useStore((s) => s.sessions);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { refreshSessions(); }, [projectId, kind]);

  const list = useMemo(() => sessionsFor(sessions, projectId, kind).sort((a, b) => rank(a.status) - rank(b.status) || b.revision - a.revision), [sessions, projectId, kind]);
  const selected = pane ? (sessions ?? []).find((s) => s.paneId === pane) ?? null : null;

  const create = async () => {
    if (!projectId) return;
    setCreating(true); setErr(null);
    try { await createSession(projectId, kind); }
    catch (e: any) { setErr(e?.message ?? "Impossible de créer la session"); }
    finally { setCreating(false); }
  };

  if (pane) return <SessionView key={pane} paneId={pane} info={selected} />;

  return (
    <div className="h-full flex flex-col slide-in-r">
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <KindSwitch kind={kind} />
        <span className="flex-1" />
        <button onClick={() => refreshSessions()} className="icon-btn" title="Rafraîchir" aria-label="Rafraîchir"><RefreshCw size={14} /></button>
      </div>
      <div className="px-3 pb-3 text-[12px] text-fg3">
        Sessions {KIND_LABEL[kind]} ouvertes dans Herdr {project ? <>sur <span className="text-fg2">{project.name}</span></> : "hors projet"}.
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-2">
        {sessions === null && [0, 1].map((i) => <div key={i} className="skeleton h-16" />)}
        {sessions !== null && !list.length && (
          <div className="card p-6 text-center fade-in">
            <div className="mx-auto w-11 h-11 rounded-2xl bg-bg3 border border-line flex items-center justify-center mb-3">{kind === "codex" ? <CodexIcon size={20} /> : <ClaudeIcon size={20} />}</div>
            <div className="font-medium mb-1">Aucune session {KIND_LABEL[kind]}</div>
            <div className="text-[12.5px] text-fg3 mb-4">{project?.path ? <>Ouvre-en une dans <span className="font-mono">{project.path}</span>.</> : "Ce projet n'a pas de dossier."}</div>
          </div>
        )}
        {list.map((s) => <SessionRow key={s.paneId} s={s} onOpen={() => store.set({ sessionPane: s.paneId })} />)}
      </div>
      {project?.path && (
        <div className="p-3 hairline-t">
          {err && <div className="text-bad text-[12px] mb-2">{err}</div>}
          <button onClick={create} disabled={creating} className="btn btn-primary w-full h-10">
            {creating ? <><Loader2 size={15} className="animate-spin" />Démarrage de {KIND_LABEL[kind]}…</> : <><Plus size={15} />Nouvelle session {KIND_LABEL[kind]}</>}
          </button>
        </div>
      )}
    </div>
  );
}

const rank = (st: string) => ({ working: 0, blocked: 1, idle: 2, done: 3 } as Record<string, number>)[st] ?? 4;

function KindSwitch({ kind }: { kind: SessionKind }) {
  return (
    <div className="inline-flex p-0.5 rounded-xl bg-bg3 border border-line">
      {(["claude", "codex"] as const).map((k) => (
        <button key={k} onClick={() => store.set({ sessionKind: k, sessionPane: null })}
          className={cls("inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[10px] text-[12.5px] font-medium transition-all", kind === k ? "bg-bg2 text-fg shadow-[0_1px_2px_rgba(0,0,0,.3),inset_0_0_0_1px_var(--line2)]" : "text-fg3 hover:text-fg2")}>
          {k === "claude" ? <ClaudeIcon size={13} /> : <CodexIcon size={13} />}{KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

export function SessionStatus({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? "var(--fg3)";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium" style={{ color: c }}>
      <span className={cls("dot", status === "working" && "dot-live")} style={{ background: c, color: c, width: 6, height: 6 }} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function SessionRow({ s, onOpen, showProject }: { s: SessionInfo; onOpen: () => void; showProject?: string | null }) {
  return (
    <button onClick={onOpen} className={cls("card p-3 text-left w-full hover:bg-bg3/70 transition-colors group", s.status === "working" && "halo")}>
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-bg3 border border-line flex items-center justify-center shrink-0">{s.kind === "codex" ? <CodexIcon size={17} /> : s.kind === "claude" ? <ClaudeIcon size={17} /> : <SquareTerminal size={16} />}</div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[13.5px] truncate">{s.title || s.name || s.paneId}</div>
          <div className="flex items-center gap-2 mt-0.5 text-[11.5px] text-fg3 min-w-0">
            <SessionStatus status={s.status} />
            {s.novabot && <span className="chip h-[18px] px-1.5 text-[10px] chip-on">Novabot</span>}
            {showProject !== undefined && <span className="truncate">{showProject ?? s.cwd}</span>}
            {s.name && showProject === undefined && <span className="font-mono truncate">{s.name}</span>}
          </div>
        </div>
        <span className="text-[11px] text-fg3 font-mono opacity-0 group-hover:opacity-100 transition-opacity">{s.paneId}</span>
      </div>
    </button>
  );
}

const QUICK: { label: string; keys: string[]; title: string; danger?: boolean }[] = [
  { label: "Échap", keys: ["esc"], title: "Échap" },
  { label: "Ctrl+C", keys: ["ctrl+c"], title: "Interrompre", danger: true },
  { label: "↑", keys: ["up"], title: "Haut" },
  { label: "↓", keys: ["down"], title: "Bas" },
  { label: "Tab", keys: ["tab"], title: "Tab" },
  { label: "⇧Tab", keys: ["shift+tab"], title: "Maj+Tab (mode)" },
  { label: "↵", keys: ["enter"], title: "Entrée" },
];

function SessionView({ paneId, info }: { paneId: string; info: SessionInfo | null }) {
  const [mode, setMode] = useState<"live" | "history">("live");
  const [screen, setScreen] = useState<ScreenInfo | null>(null);
  const [text, setText] = useState("");
  const [nudge, setNudge] = useState(0);
  const sender = useMemo(() => createInputSender(paneId), [paneId]);
  const coarse = useRef(typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches).current;
  const status = screen?.status ?? info?.status ?? "unknown";

  const onInput = (op: TermOp) => {
    if ("key" in op && op.key === "ctrl+c" && !confirm("Envoyer Ctrl+C à cette session (interrompt l'agent) ?")) return;
    sender.send(op);
  };
  const quick = (q: (typeof QUICK)[number]) => {
    if (q.danger && !confirm("Envoyer Ctrl+C à cette session (interrompt l'agent) ?")) return;
    sender.keys(q.keys).then(() => setNudge((n) => n + 1));
  };
  const submit = () => {
    if (!text) return;
    sender.text(text, true).then(() => setNudge((n) => n + 1));
    setText("");
  };

  return (
    <div className="h-full flex flex-col slide-in-r">
      <div className="px-2 py-2 flex items-center gap-1.5 hairline-b">
        <button onClick={() => store.set({ sessionPane: null })} className="icon-btn" title="Retour à la liste" aria-label="Retour"><ArrowLeft size={16} /></button>
        <div className="w-7 h-7 rounded-lg bg-bg3 border border-line flex items-center justify-center shrink-0">{info?.kind === "codex" ? <CodexIcon size={14} /> : <ClaudeIcon size={14} />}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium truncate leading-tight">{screen?.title || info?.title || info?.name || paneId}</div>
          <div className="flex items-center gap-2 leading-tight"><SessionStatus status={status} />{info?.novabot && <span className="text-[10.5px] grad-text font-semibold">Novabot</span>}</div>
        </div>
        <WideButton />
        <div className="inline-flex p-0.5 rounded-lg bg-bg3 border border-line">
          <button onClick={() => setMode("live")} className={cls("h-6 px-2 rounded-md text-[11.5px] inline-flex items-center gap-1", mode === "live" ? "bg-bg2 text-fg" : "text-fg3")} title="Écran en direct"><Radio size={11} />Live</button>
          <button onClick={() => setMode("history")} className={cls("h-6 px-2 rounded-md text-[11.5px] inline-flex items-center gap-1", mode === "history" ? "bg-bg2 text-fg" : "text-fg3")} title="Historique (1000 lignes)"><History size={11} />Historique</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative" style={{ background: "#090b12" }}>
        {screen?.error && <div className="absolute inset-x-0 top-0 z-10 text-[12px] text-bad bg-bad/10 px-3 py-1.5">{screen.error}</div>}
        <Suspense fallback={<div className="p-4"><div className="skeleton h-4 w-2/3 mb-2" /><div className="skeleton h-4 w-1/2" /></div>}>
          <XTerm paneId={paneId} mode={mode} onInfo={setScreen} onInput={onInput} nudge={nudge} />
        </Suspense>
      </div>
      <div className="p-2 hairline-t flex flex-col gap-2 safe-bottom">
        <div className="flex gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {QUICK.map((q) => (
            <button key={q.label} onClick={() => quick(q)} title={q.title} className={cls("kbd h-8 max-md:h-10 min-w-10 px-2.5 text-[12px] shrink-0 hover:text-fg hover:border-line2", q.danger && "text-bad")}>{q.label}</button>
          ))}
        </div>
        {(coarse || mode === "history") ? (
          <div className="flex gap-1.5">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Écrire dans la session…" className="input flex-1 min-w-0 h-10 font-mono text-[13px]" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button onClick={submit} disabled={!text} className="btn btn-primary h-10 w-11 px-0" aria-label="Envoyer"><Send size={15} /></button>
          </div>
        ) : (
          <div className="text-[11px] text-fg3 flex items-center gap-1.5 px-1"><CornerDownLeft size={11} />Clique dans le terminal pour taper directement (Ctrl+C demande confirmation).</div>
        )}
      </div>
    </div>
  );
}

function WideButton() {
  const wide = useStore((s) => s.panelWide);
  return (
    <button onClick={() => store.set({ panelWide: !wide })} className="icon-btn max-md:hidden" title={wide ? "Réduire le panneau" : "Élargir le panneau"} aria-label="Élargir">
      {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  );
}
