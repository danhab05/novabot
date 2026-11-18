// Palette de commandes (⌘K / Ctrl+K) : navigation et actions rapides au clavier.
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, LayoutDashboard, MessageSquarePlus, Search, Sparkles, Plus } from "lucide-react";
import { useStore, store } from "../lib/store";
import { openProject, newThread, setMobileTab } from "../lib/actions";
import { openSessions, createSession, sessionsFor } from "../lib/sessions";
import { cls } from "../lib/format";
import { ProjectAvatar } from "./ProjectAvatar";
import { ClaudeIcon, CodexIcon } from "./AgentIcons";

interface Cmd { id: string; group: string; label: string; hint?: string; icon: React.ReactNode; run: () => void; keywords?: string }

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export default function CommandPalette() {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projects.find((p) => p.id === s.projectId) ?? null);
  const sessions = useStore((s) => s.sessions);
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => store.set({ paletteOpen: false });

  useEffect(() => { input.current?.focus(); }, []);

  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    out.push({ id: "new", group: "Actions", label: "Nouvelle conversation", hint: current ? current.name : "fil global", icon: <MessageSquarePlus size={15} />, run: () => newThread() });
    out.push({ id: "global", group: "Actions", label: "Fil global Novabot", icon: <Sparkles size={15} />, run: () => openProject(null) });
    out.push({ id: "cockpit", group: "Actions", label: "Ouvrir le cockpit", hint: "agents · quotas · santé", icon: <LayoutDashboard size={15} />, run: () => { store.set({ view: "cockpit" }); setMobileTab("cockpit"); } });
    if (isAdmin && current) {
      const nC = sessionsFor(sessions, current.id, "claude").length, nX = sessionsFor(sessions, current.id, "codex").length;
      out.push({ id: "s-cl", group: "Sessions", label: `Sessions Claude Code`, hint: `${current.name} · ${nC}`, icon: <ClaudeIcon />, run: () => openSessions("claude") });
      out.push({ id: "s-cx", group: "Sessions", label: `Sessions Codex`, hint: `${current.name} · ${nX}`, icon: <CodexIcon />, run: () => openSessions("codex") });
      if (current.path) {
        out.push({ id: "n-cl", group: "Sessions", label: "Nouvelle session Claude Code", hint: current.name, icon: <Plus size={15} />, run: () => { openSessions("claude"); createSession(current.id, "claude").catch((e) => alert(e?.message)); } });
        out.push({ id: "n-cx", group: "Sessions", label: "Nouvelle session Codex", hint: current.name, icon: <Plus size={15} />, run: () => { openSessions("codex"); createSession(current.id, "codex").catch((e) => alert(e?.message)); } });
      }
    }
    for (const p of projects) {
      out.push({ id: "p-" + p.id, group: "Projets", label: p.name, hint: p.id, keywords: `${p.id} ${p.stack ?? ""}`, icon: <ProjectAvatar id={p.id} name={p.name} size={20} />, run: () => openProject(p.id) });
    }
    if (isAdmin) {
      for (const s of sessions ?? []) {
        if (!s.projectId || (s.kind !== "claude" && s.kind !== "codex")) continue;
        const p = projects.find((x) => x.id === s.projectId);
        out.push({ id: "ss-" + s.paneId, group: "Sessions ouvertes", label: s.title || s.name || s.paneId, hint: `${p?.name ?? s.projectId} · ${s.status}`, keywords: `${s.kind} ${p?.name ?? ""}`,
          icon: s.kind === "codex" ? <CodexIcon /> : <ClaudeIcon />, run: async () => { await openProject(s.projectId); openSessions(s.kind as "claude" | "codex", s.paneId); } });
      }
    }
    return out;
  }, [projects, current, sessions, isAdmin]);

  const filtered = useMemo(() => {
    const nq = norm(q.trim());
    if (!nq) return cmds.filter((c) => c.group !== "Sessions ouvertes").slice(0, 40);
    const words = nq.split(/\s+/);
    return cmds.filter((c) => { const hay = norm(`${c.label} ${c.hint ?? ""} ${c.keywords ?? ""} ${c.group}`); return words.every((w) => hay.includes(w)); }).slice(0, 50);
  }, [cmds, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const run = (c: Cmd | undefined) => { if (!c) return; close(); c.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered[sel]); }
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-3 fade-in" onMouseDown={close} style={{ background: "rgba(3,4,8,.55)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-[600px] glass border border-line2 rounded-2xl overflow-hidden pop-in" style={{ boxShadow: "var(--shadow-lg)" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 h-14 hairline-b">
          <Search size={16} className="text-fg3" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Aller à un projet, ouvrir une session, lancer une action…" className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-fg3" />
          <span className="kbd">Échap</span>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.map((c, i) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <div key={c.id}>
                {head && <div className="label-xs px-3 pt-2.5 pb-1">{head}</div>}
                <button data-i={i} onMouseMove={() => setSel(i)} onClick={() => run(c)}
                  className={cls("w-full flex items-center gap-3 px-3 h-10 rounded-xl text-left text-[13.5px] transition-colors", i === sel ? "bg-bg3 text-fg" : "text-fg2")}>
                  <span className="w-5 flex items-center justify-center shrink-0 text-fg2">{c.icon}</span>
                  <span className="truncate flex-1">{c.label}</span>
                  {c.hint && <span className="text-[12px] text-fg3 truncate max-w-[40%]">{c.hint}</span>}
                  {i === sel && <CornerDownLeft size={13} className="text-fg3 shrink-0" />}
                </button>
              </div>
            );
          })}
          {!filtered.length && <div className="text-center text-fg3 text-[13px] py-8">Aucun résultat.</div>}
        </div>
      </div>
    </div>
  );
}
