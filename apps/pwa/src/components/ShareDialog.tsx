// « Partager le projet » : l'admin invite des gens par leur compte Discord. Un invité se connecte
// avec Discord et ne voit que les projets partagés avec lui (PWA + salon Discord du projet).
import { useEffect, useRef, useState } from "react";
import { Search, UserPlus, X, Users } from "lucide-react";
import type { Project, User } from "@novabot/shared";
import { api, post, del } from "../lib/api";
import { cls } from "../lib/format";

interface Found { id: string; name: string; username: string; avatar: string | null }

export function ShareDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [members, setMembers] = useState<User[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = () => api<User[]>(`/api/projects/${project.id}/members`).then(setMembers).catch((e) => setErr(e.message));
  useEffect(() => { load(); input.current?.focus(); }, [project.id]);
  useEffect(() => {
    const t = q.trim();
    if (!t || /^\d{15,22}$/.test(t)) { setFound([]); return; }
    const h = setTimeout(() => api<Found[]>(`/api/discord/members?q=${encodeURIComponent(t)}`).then(setFound).catch((e) => setErr(e.message)), 250);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);

  const invite = async (discordId: string) => {
    setBusy(discordId); setErr(null);
    try { await post(`/api/projects/${project.id}/members`, { discordId }); setQ(""); setFound([]); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const remove = async (u: User) => {
    setBusy(u.id); setErr(null);
    try { await del(`/api/projects/${project.id}/members/${u.id}`); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const isId = /^\d{15,22}$/.test(q.trim());
  const memberIds = new Set((members ?? []).map((m) => m.discordId));

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4 fade-in" onMouseDown={onClose} style={{ background: "rgba(3,4,8,.55)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-[480px] bg-bg2 border border-line2 rounded-2xl overflow-hidden pop-in" style={{ boxShadow: "var(--shadow-lg)" }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Partager le projet">
        <div className="flex items-center gap-2 px-4 h-14 hairline-b">
          <Users size={16} className="text-fg3" />
          <div className="flex-1 min-w-0 font-semibold truncate">Partager « {project.name} »</div>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-[12.5px] text-fg3">Les invités se connectent avec Discord. Ils ne voient que ce projet, ici et dans son salon Discord.</div>
          <div className="flex items-center gap-2 h-10 px-3 rounded-xl border border-line bg-bg3">
            <Search size={14} className="text-fg3 shrink-0" />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pseudo Discord ou identifiant…" className="flex-1 min-w-0 bg-transparent outline-none text-[14px] placeholder:text-fg3"
              onKeyDown={(e) => { if (e.key === "Enter" && isId) invite(q.trim()); }} />
            {isId && <button className="btn h-7 px-2 text-[12px]" disabled={!!busy} onClick={() => invite(q.trim())}><UserPlus size={13} />Inviter</button>}
          </div>
          {found.length > 0 && (
            <div className="space-y-1">
              {found.map((f) => (
                <div key={f.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-bg3">
                  <Avatar src={f.avatar} name={f.name} />
                  <div className="flex-1 min-w-0"><div className="text-[13.5px] truncate">{f.name}</div><div className="text-[11.5px] text-fg3 truncate">@{f.username}</div></div>
                  {memberIds.has(f.id) ? <span className="text-[12px] text-fg3">déjà invité</span>
                    : <button className="btn h-7 px-2 text-[12px]" disabled={busy === f.id} onClick={() => invite(f.id)}><UserPlus size={13} />Inviter</button>}
                </div>
              ))}
            </div>
          )}
          {err && <div className="text-[12.5px]" style={{ color: "var(--danger, #f87171)" }}>{err}</div>}
          <div>
            <div className="label-xs pb-1.5">Accès</div>
            <div className="flex items-center gap-2.5 px-2 py-1.5 text-[13px] text-fg2"><span className="w-7 h-7 rounded-full grad-bg shrink-0" /><span className="flex-1">Toi (admin)</span></div>
            {members === null ? <div className="px-2 py-1.5 text-[13px] text-fg3">Chargement…</div>
              : members.length === 0 ? <div className="px-2 py-1.5 text-[13px] text-fg3">Aucun invité pour l'instant.</div>
              : members.map((m) => (
                <div key={m.id} className={cls("flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-bg3", busy === m.id && "opacity-50")}>
                  <Avatar src={m.avatar} name={m.name} />
                  <div className="flex-1 min-w-0 text-[13.5px] truncate">{m.name}</div>
                  <button className="btn btn-ghost h-7 px-2 text-[12px]" disabled={busy === m.id} onClick={() => remove(m)}>Retirer</button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  return src ? <img src={src} alt="" className="w-7 h-7 rounded-full shrink-0" />
    : <span className="w-7 h-7 rounded-full bg-bg4 shrink-0 inline-flex items-center justify-center text-[12px] font-semibold">{name.slice(0, 1).toUpperCase()}</span>;
}
