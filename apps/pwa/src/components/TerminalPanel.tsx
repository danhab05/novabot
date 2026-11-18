import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useStore, store } from "../lib/store";
import { api, post, ApiError } from "../lib/api";
import { isActive } from "../lib/format";

interface Term { text: string; pane?: string; agent?: string; state?: string }

export default function TerminalPanel() {
  const taskId = useStore((s) => s.terminalTaskId);
  const tasks = useStore((s) => s.tasks);
  const projectId = useStore((s) => s.projectId);
  const candidates = Object.values(tasks).filter((t) => t.herdrPane && (projectId ? t.projectId === projectId : true)).sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)) || b.updatedAt - a.updatedAt);
  const current = taskId && tasks[taskId] ? taskId : candidates[0]?.id ?? null;
  const [term, setTerm] = useState<Term | null>(null);
  const [na, setNa] = useState(false);
  const [input, setInput] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!current) return;
    let stop = false;
    const tick = async () => {
      try {
        const t = await api<Term>(`/api/tasks/${current}/terminal?lines=300`);
        if (!stop) { setTerm(t); setNa(false); }
      } catch (e) { if (e instanceof ApiError && e.status === 404) setNa(true); }
    };
    tick();
    const iv = setInterval(() => { if (!document.hidden) tick(); }, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [current]);

  useEffect(() => { const el = pre.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [term?.text]);

  const sendInput = async () => {
    if (!current || !input.trim()) return;
    try { await post(`/api/tasks/${current}/terminal/input`, { text: input }); setInput(""); } catch {}
  };

  if (!candidates.length && !current) return <div className="p-6 text-fg3 text-[13px] text-center">Aucun agent Herdr lancé pour ce projet.</div>;
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line">
        <select value={current ?? ""} onChange={(e) => store.set({ terminalTaskId: e.target.value })} className="flex-1 min-w-0 bg-bg3 border border-line rounded-md px-2 py-1 text-[12.5px]">
          {candidates.map((t) => <option key={t.id} value={t.id}>{t.herdrAgent ?? t.herdrPane} — {t.title}</option>)}
        </select>
        {term?.state && <span className="text-[11.5px] text-fg3">{term.state}</span>}
      </div>
      {na ? <div className="p-6 text-fg3 text-[13px] text-center">Vue terminal pas encore disponible côté serveur.</div> : (
        <pre ref={pre} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
          className="flex-1 overflow-auto m-0 p-2 font-mono text-[11.5px] leading-[1.35] whitespace-pre text-fg bg-bg">{term?.text ?? "…"}</pre>
      )}
      <div className="flex gap-1.5 p-2 border-t border-line">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendInput()} placeholder="Envoyer à l'agent…" className="flex-1 min-w-0 bg-bg3 border border-line rounded-md px-2 py-1.5 font-mono text-[12.5px] outline-none" />
        <button onClick={sendInput} disabled={!input.trim()} className="px-2.5 rounded-md bg-accent text-accent-fg" aria-label="Envoyer"><Send size={14} /></button>
      </div>
    </div>
  );
}
