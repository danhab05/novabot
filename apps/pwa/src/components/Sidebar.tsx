import { useMemo, useState } from "react";
import { ChevronRight, Command, LayoutDashboard, LogOut, Search, SquareTerminal, Moon, Sun, Monitor } from "lucide-react";
import { getTheme, setTheme, nextTheme, type Theme } from "../lib/theme";
import { useStore, projectAgentState, store } from "../lib/store";
import { openProject, logout, setMobileTab } from "../lib/actions";
import { cacheGet, cacheSet } from "../lib/cache";
import { cls } from "../lib/format";
import { ProjectAvatar } from "./ProjectAvatar";

const DOT: Record<string, string> = { blocked: "var(--bad)", waiting: "var(--warn)", running: "var(--info)", queued: "var(--fg3)" };
const DOT_LABEL: Record<string, string> = { blocked: "bloqué", waiting: "attend ta réponse", running: "agent au travail", queued: "en file" };

export function Sidebar() {
  const folders = useStore((s) => s.folders);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.projectId);
  const view = useStore((s) => s.view);
  const user = useStore((s) => s.user);
  const connected = useStore((s) => s.connected);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => cacheGet("collapsed") ?? {});

  const toggle = (id: string) => setCollapsed((c) => { const n = { ...c, [id]: !c[id] }; cacheSet("collapsed", n); return n; });

  // sessions Herdr par projet : total + au travail
  const sess = useMemo(() => {
    const m = new Map<string, { n: number; working: number }>();
    for (const s of sessions ?? []) {
      if (!s.projectId) continue;
      const cur = m.get(s.projectId) ?? { n: 0, working: 0 };
      cur.n++; if (s.status === "working") cur.working++;
      m.set(s.projectId, cur);
    }
    return m;
  }, [sessions]);
  const workingTotal = (sessions ?? []).filter((s) => s.status === "working").length;

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const match = (p: { id: string; name: string }) => !ql || p.name.toLowerCase().includes(ql) || p.id.includes(ql);
    const byFolder = new Map<string | null, typeof projects>();
    for (const p of projects) if (match(p)) byFolder.set(p.folderId, [...(byFolder.get(p.folderId) ?? []), p]);
    const out = folders.map((f) => ({ id: f.id, name: f.name, projects: byFolder.get(f.id) ?? [] }));
    const orphans = byFolder.get(null);
    if (orphans?.length) out.push({ id: "__none", name: "Divers", projects: orphans });
    return out.filter((g) => g.projects.length || !ql);
  }, [folders, projects, q]);

  const globalState = projectAgentState(tasks, null);

  return (
    <nav className="h-full flex flex-col glass border-r border-line min-w-0">
      <div className="px-3 pt-3 pb-2 flex items-center gap-2.5 safe-top">
        <div className={cls("orb", globalState === "running" && "orb-think")} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] tracking-tight leading-none">Novabot</div>
          <div className="text-[11px] text-fg3 mt-1 flex items-center gap-1.5">
            <span className="dot" style={{ width: 6, height: 6, background: connected ? "var(--ok)" : "var(--warn)" }} />
            {connected ? "en ligne" : "reconnexion…"}
            {workingTotal > 0 && <span className="text-info">· {workingTotal} session{workingTotal > 1 ? "s" : ""} active{workingTotal > 1 ? "s" : ""}</span>}
          </div>
        </div>
      </div>

      <div className="px-3 pb-2 flex gap-1.5">
        <label className="flex-1 flex items-center gap-2 input h-9">
          <Search size={14} className="text-fg3 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher" className="bg-transparent outline-none flex-1 min-w-0 text-[13px]" />
        </label>
        <button onClick={() => store.set({ paletteOpen: true })} className="icon-btn h-9 w-9 border border-line bg-bg3 hidden md:inline-flex" title="Palette de commandes (Ctrl+K)" aria-label="Palette de commandes"><Command size={14} /></button>
      </div>

      <div className="px-2 flex flex-col gap-0.5">
        <Item active={view === "thread" && current === null} onClick={() => openProject(null)} icon={<div className="w-6 h-6 rounded-[7px] grad-bg flex items-center justify-center text-[11px] font-bold">N</div>} label="Novabot" sub="fil global" state={globalState} />
        <Item active={view === "cockpit"} onClick={() => { store.set({ view: "cockpit" }); setMobileTab("cockpit"); }} icon={<div className="w-6 h-6 rounded-[7px] bg-bg3 border border-line flex items-center justify-center text-fg2"><LayoutDashboard size={13} /></div>} label="Cockpit" sub="agents · quotas · santé" />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((g) => {
          const open = !collapsed[g.id] || !!q;
          return (
            <div key={g.id} className="mb-2">
              <button onClick={() => toggle(g.id)} className="w-full flex items-center gap-1.5 px-2 py-1 label-xs hover:text-fg2 transition-colors">
                <ChevronRight size={11} className={cls("transition-transform", open && "rotate-90")} />
                <span className="truncate">{g.name}</span>
                <span className="ml-auto font-normal tabular-nums">{g.projects.length}</span>
              </button>
              {open && (
                <div className="flex flex-col gap-px mt-0.5">
                  {g.projects.map((p) => {
                    const st = projectAgentState(tasks, p.id);
                    const ss = sess.get(p.id);
                    return (
                      <Item key={p.id} active={view === "thread" && current === p.id} onClick={() => openProject(p.id)}
                        icon={<ProjectAvatar id={p.id} name={p.name} size={22} />} label={p.name} state={st}
                        right={ss ? <span className={cls("inline-flex items-center gap-1 text-[10.5px] tabular-nums px-1.5 h-[18px] rounded-md border", ss.working ? "text-info border-info/30 bg-info/10" : "text-fg3 border-line")} title={`${ss.n} session(s) Herdr${ss.working ? `, ${ss.working} au travail` : ""}`}><SquareTerminal size={10} />{ss.n}</span> : null} />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!groups.length && <div className="text-fg3 text-[13px] px-2 py-4">Aucun projet.</div>}
      </div>

      <div className="hairline-t px-3 py-2.5 flex items-center gap-2.5 safe-bottom">
        {user?.avatar ? <img src={user.avatar} alt="" className="w-7 h-7 rounded-full ring-1 ring-line2" /> : <div className="w-7 h-7 rounded-full grad-soft border border-line flex items-center justify-center text-[12px] font-semibold">{user?.name?.[0] ?? "?"}</div>}
        <div className="flex-1 min-w-0">
          <div className="truncate text-[13px] font-medium leading-tight">{user?.name}</div>
          <div className="text-[11px] text-fg3 leading-tight">{user?.role === "guest" ? "invité" : "admin"}</div>
        </div>
        <ThemeButton />
        <button onClick={logout} className="icon-btn" title="Se déconnecter" aria-label="Se déconnecter"><LogOut size={15} /></button>
      </div>
    </nav>
  );
}

function Item(p: { active: boolean; onClick: () => void; label: string; sub?: string; icon?: React.ReactNode; state?: string | null; right?: React.ReactNode }) {
  return (
    <button onClick={p.onClick} className={cls(
      "group relative w-full flex items-center gap-2.5 px-2 min-h-[36px] max-md:min-h-[44px] rounded-[10px] text-left text-[13.5px] transition-colors",
      p.active ? "bg-bg3 text-fg shadow-[inset_0_0_0_1px_var(--line)]" : "text-fg2 hover:bg-bg3/60 hover:text-fg",
    )}>
      {p.active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r grad-bg" />}
      {p.icon}
      <span className="flex-1 min-w-0">
        <span className="block truncate leading-tight">{p.label}</span>
        {p.sub && <span className="block truncate text-[11px] text-fg3 leading-tight">{p.sub}</span>}
      </span>
      {p.right}
      {p.state && <span className={cls("dot", p.state === "running" && "dot-live")} title={DOT_LABEL[p.state]} style={{ background: DOT[p.state], color: DOT[p.state], width: 7, height: 7 }} />}
    </button>
  );
}

function ThemeButton() {
  const [t, setT] = useState<Theme>(getTheme);
  const label = { dark: "Thème sombre", light: "Thème clair", system: "Thème du système" }[t];
  return (
    <button onClick={() => { const n = nextTheme(t); setTheme(n); setT(n); }} className="icon-btn" title={`${label} (cliquer pour changer)`} aria-label={label}>
      {t === "dark" ? <Moon size={15} /> : t === "light" ? <Sun size={15} /> : <Monitor size={15} />}
    </button>
  );
}
