import { useEffect } from "react";
import { X, CheckCircle2, AlertTriangle, Info, HelpCircle } from "lucide-react";
import { useStore, dismissToast } from "../lib/store";
import { openDeepLink } from "../lib/actions";

const COLOR = { info: "var(--info)", done: "var(--ok)", blocked: "var(--warn)", alert: "var(--bad)" } as const;
const ICON = { info: Info, done: CheckCircle2, blocked: HelpCircle, alert: AlertTriangle } as const;

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  useEffect(() => {
    const timers = toasts.filter((t) => t.level === "info" || t.level === "done").map((t) => setTimeout(() => dismissToast(t.id), 6000));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);
  if (!toasts.length) return null;
  return (
    <div className="fixed z-50 top-3 right-3 left-3 md:left-auto md:w-[380px] flex flex-col gap-2 pointer-events-none safe-top">
      {toasts.map((t) => {
        const Icon = ICON[t.level];
        return (
          <div key={t.id} className="pointer-events-auto glass border border-line2 rounded-2xl p-3.5 flex gap-3 pop-in" style={{ boxShadow: "var(--shadow-lg)" }}>
            <Icon size={18} style={{ color: COLOR[t.level] }} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => { if (t.url) { dismissToast(t.id); if (t.url.startsWith("/")) openDeepLink(t.url); else window.open(t.url, "_blank", "noopener"); } }}>
              <div className="font-medium truncate text-[13.5px]">{t.title}</div>
              <div className="text-fg2 text-[12.5px] line-clamp-3 whitespace-pre-wrap mt-0.5">{t.body}</div>
            </div>
            <button className="icon-btn w-7 h-7 -mr-1 -mt-1" onClick={() => dismissToast(t.id)} aria-label="Fermer"><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
