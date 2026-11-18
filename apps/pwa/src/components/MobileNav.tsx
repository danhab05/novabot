import { Globe, LayoutDashboard, ListChecks, MessageSquare, FolderKanban } from "lucide-react";
import { useStore, type MobileTab } from "../lib/store";
import { setMobileTab, setPanel } from "../lib/actions";
import { cls, isActive } from "../lib/format";

export function MobileNav() {
  const tab = useStore((s) => s.mobileTab);
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const nActive = useStore((s) => Object.values(s.tasks).filter((t) => isActive(t.status) && (s.projectId ? t.projectId === s.projectId : true)).length);
  const waiting = useStore((s) => Object.values(s.tasks).some((t) => t.status === "waiting" || t.status === "blocked"));
  const items: { id: MobileTab; label: string; icon: React.ReactNode; badge?: number | boolean }[] = [
    { id: "projects", label: "Projets", icon: <FolderKanban size={20} /> },
    { id: "thread", label: "Fil", icon: <MessageSquare size={20} /> },
    { id: "tasks", label: "Tâches", icon: <ListChecks size={20} />, badge: nActive || undefined },
    ...(isAdmin ? [{ id: "browser" as MobileTab, label: "Navigateur", icon: <Globe size={20} /> }] : []),
    { id: "cockpit", label: "Cockpit", icon: <LayoutDashboard size={20} />, badge: waiting },
  ];
  return (
    <nav className="md:hidden shrink-0 glass hairline-t flex safe-bottom px-1">
      {items.map((it) => {
        const on = tab === it.id;
        return (
          <button key={it.id} onClick={() => { setMobileTab(it.id); if (it.id === "tasks") setPanel("tasks"); if (it.id === "browser") setPanel("browser"); }}
            className={cls("flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[56px] text-[10.5px] font-medium relative transition-colors", on ? "text-fg" : "text-fg3")}>
            <span className={cls("w-12 h-7 rounded-full flex items-center justify-center transition-all", on && "grad-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]")}>{it.icon}</span>
            {it.label}
            {it.badge ? <span className="absolute top-1.5 left-1/2 ml-3 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-center font-semibold" style={{ background: typeof it.badge === "number" ? "var(--info)" : "var(--warn)", color: "#000" }}>{typeof it.badge === "number" ? it.badge : "!"}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
