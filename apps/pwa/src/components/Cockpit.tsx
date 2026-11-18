import { useCallback, useEffect, useState } from "react";
import { Activity, Bell, SquareTerminal, Bot, Brain, CalendarClock, Check, Gauge, Lightbulb, Menu, Package, Pin, PinOff, Plug, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import type { Cron, HealthCheck, Idea, MemoryJournalEntry, Quota, SkillProposal, Task, CatalogItem } from "@novabot/shared";
import { apiOptional, post, patch, del } from "../lib/api";
import { useStore, store } from "../lib/store";
import { openSessions } from "../lib/sessions";
import { SessionRow } from "./SessionsPanel";
import { loadAllTasks, setMobileTab, openProject } from "../lib/actions";
import { ago, isActive, cls } from "../lib/format";
import { TaskCard } from "./TaskCard";

/** Charge une route optionnelle : null = route absente (section « non disponible »). */
function useOptional<T>(path: string, pollMs = 0): { data: T | null | undefined; reload: () => void } {
  const [data, setData] = useState<T | null | undefined>(undefined);
  const reload = useCallback(() => { apiOptional<T>(path).then(setData).catch(() => setData(null)); }, [path]);
  useEffect(() => {
    reload();
    if (!pollMs) return;
    const iv = setInterval(() => { if (!document.hidden) reload(); }, pollMs);
    return () => clearInterval(iv);
  }, [reload, pollMs]);
  return { data, reload };
}

function Section({ title, icon, children, right, wide }: { title: string; icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode; wide?: boolean }) {
  return (
    <section className={cls("card p-4 min-w-0 fade-in", wide && "lg:col-span-2")}>
      <h2 className="flex items-center gap-2.5 font-semibold text-[13.5px] tracking-tight mb-3">
        <span className="w-7 h-7 rounded-lg bg-bg3 border border-line flex items-center justify-center text-fg2">{icon}</span>{title}
        <span className="ml-auto font-normal">{right}</span>
      </h2>
      {children}
    </section>
  );
}
const NA = () => <div className="text-fg3 text-[13px]">Non disponible pour l'instant.</div>;
const Loading = () => <div className="flex flex-col gap-2"><div className="skeleton h-4 w-3/4" /><div className="skeleton h-4 w-1/2" /></div>;
const Empty = ({ t }: { t: string }) => <div className="text-fg3 text-[13px]">{t}</div>;

export default function Cockpit() {
  const isAdmin = useStore((s) => s.user?.role === "admin");
  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="h-14 shrink-0 glass hairline-b flex items-center gap-3 px-3 md:px-5 safe-top">
        <button className="md:hidden icon-btn -ml-1" onClick={() => setMobileTab("projects")} aria-label="Projets"><Menu size={18} /></button>
        <div className="w-8 h-8 rounded-[10px] grad-bg flex items-center justify-center"><Gauge size={16} /></div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold tracking-tight leading-tight">Cockpit</div>
          <div className="text-[11.5px] text-fg3 leading-tight">agents · sessions · quotas · santé · mémoire</div>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-3 md:p-6">
        <div className="grid gap-4 lg:grid-cols-2 max-w-6xl mx-auto">
          <Kpis />
          <AgentsSection />
          {isAdmin && <SessionsSection />}
          <QuotasSection />
          <HealthSection />
          {isAdmin && <PushSection />}
          <IdeasSection />
          {isAdmin && <SkillsSection />}
          <MemorySection />
          {isAdmin && <CronsSection />}
          {isAdmin && <CatalogSection />}
          {isAdmin && <IntegrationsSection />}
        </div>
      </div>
    </div>
  );
}

function AgentsSection() {
  const { data: orch } = useOptional<{ running: number; queued: number; resources: { memAvailMb: number; swapPct: number; load1: number } }>("/api/orchestrator", 5000);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  useEffect(() => { loadAllTasks().catch(() => {}); }, []);
  const active = Object.values(tasks).filter((t) => isActive(t.status)).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const recent = Object.values(tasks).filter((t) => !isActive(t.status)).sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt)).slice(0, 6);
  const name = (t: Task) => projects.find((p) => p.id === t.projectId)?.name ?? "Global";
  return (
    <Section wide title="Agents et file" icon={<Bot size={15} />} right={orch ? <span className="text-[12px] text-fg3">{orch.running} en cours · {orch.queued} en file</span> : null}>
      {orch && (
        <div className="flex flex-wrap gap-3 text-[12px] text-fg2 mb-2">
          <span>RAM dispo <b className="text-fg">{(orch.resources.memAvailMb / 1024).toFixed(1)} Go</b></span>
          <span>Swap <b className={orch.resources.swapPct > 75 ? "text-bad" : "text-fg"}>{Math.round(orch.resources.swapPct)} %</b></span>
          <span>Charge <b className={orch.resources.load1 > 6 ? "text-warn" : "text-fg"}>{orch.resources.load1.toFixed(1)}</b></span>
        </div>
      )}
      {orch === null && <div className="text-fg3 text-[12px] mb-2">Orchestrateur non chargé.</div>}
      <div className="flex flex-col gap-2">
        {active.map((t) => (
          <div key={t.id}>
            <button onClick={() => openProject(t.projectId)} className="text-[11.5px] text-fg3 hover:text-fg2 mb-0.5"># {name(t)}</button>
            <TaskCard task={t} compact />
          </div>
        ))}
        {!active.length && <Empty t="Aucun agent au travail." />}
      </div>
      {recent.length > 0 && (
        <details className="mt-3">
          <summary className="text-[12.5px] text-fg2 cursor-pointer">Récemment terminées</summary>
          <div className="flex flex-col gap-2 mt-2">{recent.map((t) => <TaskCard key={t.id} task={t} compact />)}</div>
        </details>
      )}
    </Section>
  );
}

function Gauge_({ q }: { q: Quota }) {
  const pct = Math.max(0, Math.min(100, q.usedPct));
  const color = pct >= 85 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
  const r = 30, c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center text-center p-2 rounded-xl bg-bg3/50 border border-line">
      <div className="relative w-[76px] h-[76px]">
        <svg viewBox="0 0 76 76" className="w-full h-full -rotate-90">
          <circle cx="38" cy="38" r={r} fill="none" stroke="var(--bg4)" strokeWidth="7" />
          <circle cx="38" cy="38" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} style={{ transition: "stroke-dashoffset .6s ease", filter: `drop-shadow(0 0 6px color-mix(in oklab, ${color} 50%, transparent))` }} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[16px] font-semibold tabular-nums">{Math.round(pct)}<span className="text-[10px] text-fg3 ml-0.5">%</span></div>
      </div>
      <div className="text-[12.5px] font-medium mt-1.5">{q.provider === "claude" ? "Claude" : "Codex"} · {q.window === "5h" ? "5 h" : "7 j"}</div>
      <div className="text-[11px] text-fg3">{q.resetsAt ? `reset ${ago(q.resetsAt)}` : "\u00a0"}</div>
    </div>
  );
}

function QuotasSection() {
  const { data } = useOptional<Quota[]>("/api/quotas", 60_000);
  return (
    <Section title="Quotas d'abonnement" icon={<Gauge size={15} />}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !data.length ? <Empty t="Pas encore de mesure." /> : (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4 gap-2">{data.sort((a, b) => a.provider.localeCompare(b.provider) || a.window.localeCompare(b.window)).map((q) => <Gauge_ key={q.provider + q.window} q={q} />)}</div>
      )}
    </Section>
  );
}

function HealthSection() {
  const { data } = useOptional<HealthCheck[]>("/api/health", 60_000);
  const col = { ok: "var(--ok)", warn: "var(--warn)", down: "var(--bad)" } as const;
  const sorted = (data ?? []).slice().sort((a, b) => ({ down: 0, warn: 1, ok: 2 }[a.status] - { down: 0, warn: 1, ok: 2 }[b.status]) || a.target.localeCompare(b.target));
  const down = sorted.filter((c) => c.status !== "ok").length;
  return (
    <Section title="Santé des services" icon={<Activity size={15} />} right={data ? <span className={cls("text-[12px]", down ? "text-bad" : "text-ok")}>{down ? `${down} problème(s)` : "tout va bien"}</span> : null}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !data.length ? <Empty t="Aucun check configuré." /> : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-80 overflow-y-auto pr-0.5">
          {sorted.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-[12px] px-2.5 py-2 rounded-lg border" title={c.detail ?? c.target}
              style={{ borderColor: c.status === "ok" ? "var(--line)" : `color-mix(in oklab, ${col[c.status]} 35%, transparent)`, background: c.status === "ok" ? "transparent" : `color-mix(in oklab, ${col[c.status]} 7%, transparent)` }}>
              <span className={cls("dot", c.status === "down" && "dot-live")} style={{ background: col[c.status], color: col[c.status], width: 7, height: 7 }} />
              <span className="truncate flex-1">{c.target.replace(/^https?:\/\//, "")}</span>
              <span className="text-[10.5px] text-fg3 uppercase tracking-wide shrink-0">{c.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function urlB64ToUint8(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function PushSection() {
  const [state, setState] = useState<"unknown" | "unsupported" | "na" | "off" | "on" | "denied" | "busy">("unknown");
  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);
  const enable = async () => {
    setState("busy");
    try {
      const v = await apiOptional<{ publicKey: string }>("/api/push/vapid");
      if (!v?.publicKey) return setState("na");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setState("denied");
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(v.publicKey) });
      await post("/api/push/subscribe", sub.toJSON());
      setState("on");
    } catch { setState("off"); }
  };
  const label = { unknown: "…", unsupported: "Ce navigateur ne gère pas les notifications push (sur iPhone : ajoute Novabot à l'écran d'accueil).", na: "Push pas encore configuré côté serveur.", off: "", on: "Notifications activées sur cet appareil.", denied: "Notifications refusées dans les réglages du navigateur.", busy: "Activation…" }[state];
  return (
    <Section title="Notifications" icon={<Bell size={15} />}>
      <div className="flex items-center gap-3 text-[13px]">
        <span className="text-fg2 flex-1">{label || "Reçois une notif quand une tâche se termine ou bloque."}</span>
        {(state === "off") && <button onClick={enable} className="px-3 py-1.5 rounded-md bg-accent text-accent-fg font-medium shrink-0">Activer</button>}
      </div>
    </Section>
  );
}

function IdeasSection() {
  const { data, reload } = useOptional<Idea[]>("/api/ideas", 120_000);
  const set = async (id: string, status: Idea["status"]) => { await patch(`/api/ideas/${id}`, { status }); reload(); };
  const list = (data ?? []).filter((i) => i.status === "new");
  return (
    <Section title="Idées" icon={<Lightbulb size={15} />} right={data ? <span className="text-[12px] text-fg3">{list.length}</span> : null}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !list.length ? <Empty t="Pas de nouvelle idée." /> : (
        <ul className="flex flex-col gap-2 max-h-80 overflow-y-auto">
          {list.map((i) => (
            <li key={i.id} className="border border-line rounded-lg p-2">
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[13px]">{i.title}</div>
                  <div className="text-fg2 text-[12.5px] whitespace-pre-wrap">{i.body}</div>
                  {i.projectId && <div className="text-fg3 text-[11.5px] mt-0.5"># {i.projectId}</div>}
                </div>
                <div className="flex flex-col gap-1">
                  <button onClick={() => set(i.id, "accepted")} className="p-1 text-ok hover:bg-bg3 rounded" title="Garder" aria-label="Garder"><Check size={15} /></button>
                  <button onClick={() => set(i.id, "dismissed")} className="p-1 text-fg3 hover:text-bad hover:bg-bg3 rounded" title="Écarter" aria-label="Écarter"><X size={15} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SkillsSection() {
  const { data, reload } = useOptional<SkillProposal[]>("/api/skills/proposals", 120_000);
  const act = async (id: string, a: "accept" | "reject") => { await post(`/api/skills/proposals/${id}/${a}`); reload(); };
  const list = (data ?? []).filter((p) => p.status === "pending");
  return (
    <Section title="Skills proposés" icon={<Wrench size={15} />} right={data ? <span className="text-[12px] text-fg3">{list.length}</span> : null}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !list.length ? <Empty t="Aucune proposition en attente." /> : (
        <ul className="flex flex-col gap-2">
          {list.map((p) => (
            <li key={p.id} className="border border-line rounded-lg p-2">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[13px] font-mono flex-1 truncate">{p.name}</span>
                <button onClick={() => act(p.id, "accept")} className="px-2 py-1 rounded-md bg-ok/15 text-ok text-[12.5px] font-medium">Accepter</button>
                <button onClick={() => act(p.id, "reject")} className="px-2 py-1 rounded-md border border-line text-fg2 text-[12.5px]">Refuser</button>
              </div>
              <details className="mt-1"><summary className="text-[12px] text-fg3 cursor-pointer">Voir le contenu</summary>
                <pre className="mt-1 text-[11.5px] font-mono whitespace-pre-wrap bg-bg3 border border-line rounded p-2 max-h-60 overflow-auto">{p.content}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function MemorySection() {
  const { data, reload } = useOptional<(MemoryJournalEntry & { content?: string; pinned?: boolean; deleted?: boolean })[]>("/api/memory/journal?limit=60", 60_000);
  const [edit, setEdit] = useState<{ memoryId: string; text: string } | null>(null);
  const save = async () => { if (!edit) return; await patch(`/api/memories/${edit.memoryId}`, { content: edit.text }); setEdit(null); reload(); };
  const pin = async (id: string, pinned: boolean) => { await patch(`/api/memories/${id}`, { pinned }); reload(); };
  const remove = async (id: string) => { if (!confirm("Oublier ce souvenir ?")) return; await del(`/api/memories/${id}`); reload(); };
  const ACTION = { create: "retenu", update: "modifié", delete: "oublié", pin: "épinglé", unpin: "désépinglé" } as const;
  return (
    <Section wide title="Journal de la mémoire" icon={<Brain size={15} />} right={<button onClick={reload} className="text-fg3 hover:text-fg" aria-label="Rafraîchir"><RefreshCw size={13} /></button>}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !data.length ? <Empty t="Rien de retenu pour l'instant." /> : (
        <ul className="flex flex-col divide-y divide-line max-h-96 overflow-y-auto">
          {data.map((e) => {
            const text = e.content ?? e.after ?? e.before ?? "";
            const editing = edit?.memoryId === e.memoryId;
            return (
              <li key={e.id} className="py-1.5 flex gap-2 items-start text-[13px]">
                <span className={cls("text-[11px] px-1.5 py-0.5 rounded shrink-0 mt-0.5", e.action === "delete" ? "bg-bad/15 text-bad" : e.action === "create" ? "bg-ok/15 text-ok" : "bg-bg3 text-fg2")}>{ACTION[e.action]}</span>
                <div className="flex-1 min-w-0">
                  {editing ? (
                    <div className="flex gap-1">
                      <input autoFocus value={edit?.text ?? ""} onChange={(ev) => setEdit({ memoryId: e.memoryId, text: ev.target.value })} onKeyDown={(ev) => ev.key === "Enter" && save()} className="flex-1 min-w-0 bg-bg3 border border-line rounded px-2 py-1" />
                      <button onClick={save} className="px-2 text-ok" aria-label="Enregistrer"><Check size={14} /></button>
                      <button onClick={() => setEdit(null)} className="px-1 text-fg3" aria-label="Annuler"><X size={14} /></button>
                    </div>
                  ) : (
                    <button className={cls("text-left w-full", e.deleted || e.action === "delete" ? "line-through text-fg3" : "")} disabled={e.deleted || e.action === "delete"} onClick={() => setEdit({ memoryId: e.memoryId, text })} title="Modifier">{text}</button>
                  )}
                  <div className="text-[11px] text-fg3">{e.actor} · {ago(e.createdAt)}</div>
                </div>
                {!e.deleted && e.action !== "delete" && (
                  <div className="flex gap-0.5 shrink-0">
                    <button onClick={() => pin(e.memoryId, !e.pinned)} className="p-1 text-fg3 hover:text-fg" title={e.pinned ? "Désépingler" : "Épingler"} aria-label="Épingler">{e.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                    <button onClick={() => remove(e.memoryId)} className="p-1 text-fg3 hover:text-bad" title="Oublier" aria-label="Oublier"><Trash2 size={13} /></button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function CronsSection() {
  const { data, reload } = useOptional<Cron[]>("/api/crons", 60_000);
  const [filter, setFilter] = useState("");
  const toggle = async (c: Cron) => { await patch(`/api/crons/${c.id}`, { enabled: !c.enabled }); reload(); };
  const list = (data ?? []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return (
    <Section wide title="Crons" icon={<CalendarClock size={15} />} right={data ? <span className="text-[12px] text-fg3">{data.filter((c) => c.enabled).length} actifs / {data.length}</span> : null}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !data.length ? <Empty t="Aucun cron." /> : (
        <>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer (ex. [hermes])" className="w-full bg-bg3 border border-line rounded-md px-2 py-1 text-[12.5px] mb-2" />
          <ul className="flex flex-col gap-1 max-h-80 overflow-y-auto">
            {list.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-[12.5px]">
                <button onClick={() => toggle(c)} role="switch" aria-checked={c.enabled} className={cls("w-8 h-4.5 rounded-full relative shrink-0 transition-colors", c.enabled ? "bg-ok" : "bg-bg3 border border-line")} style={{ height: 18 }} title={c.enabled ? "Désactiver" : "Activer"}>
                  <span className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all" style={{ left: c.enabled ? 16 : 2, width: 14, height: 14 }} />
                </button>
                <span className="truncate flex-1" title={c.prompt}>{c.name}</span>
                <span className="font-mono text-fg3 shrink-0">{c.schedule ?? (c.onceAt ? new Date(c.onceAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "")}</span>
                {c.nextRun && c.enabled && <span className="text-fg3 shrink-0 hidden sm:inline">{ago(c.nextRun)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function CatalogSection() {
  const { data, reload } = useOptional<CatalogItem[]>("/api/catalog", 0);
  const [type, setType] = useState<"all" | "mcp" | "skill" | "agent">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, action: "install" | "uninstall" | "publish", body?: unknown) => {
    setBusy(id);
    try { await post(`/api/catalog/${encodeURIComponent(id)}/${action}`, body); reload(); }
    catch (e: any) { alert(e?.message ?? "Erreur"); }
    finally { setBusy(null); }
  };
  const install = (it: CatalogItem) => {
    const secrets: Record<string, string> = {};
    for (const s of it.manifest.secrets ?? []) { const v = prompt(`${it.manifest.name} — ${s.label}`); if (v === null) return; secrets[s.key] = v; }
    run(it.id, "install", { secrets });
  };
  const list = (data ?? []).filter((i) => type === "all" || i.manifest.type === type);
  return (
    <Section wide title="Catalogue" icon={<Package size={15} />} right={data ? <a href="/pub/catalogue" target="_blank" rel="noreferrer" className="text-[12px] text-accent">page publique</a> : null}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : (
        <>
          <div className="flex gap-1 mb-2 text-[12.5px]">
            {(["all", "mcp", "skill", "agent"] as const).map((t) => (
              <button key={t} onClick={() => setType(t)} className={cls("px-2 py-1 rounded-md border", type === t ? "border-accent/50 bg-accent/10" : "border-line text-fg2")}>
                {{ all: "Tout", mcp: "Connecteurs", skill: "Skills", agent: "Agents" }[t]}
              </button>
            ))}
          </div>
          {!list.length ? <Empty t="Catalogue vide." /> : (
            <ul className="grid sm:grid-cols-2 gap-2 max-h-[28rem] overflow-y-auto">
              {list.map((it) => (
                <li key={it.id} className="border border-line rounded-lg p-2 flex flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10.5px] uppercase tracking-wide text-fg3 border border-line rounded px-1">{it.manifest.type}</span>
                    <span className="font-medium text-[13px] truncate flex-1">{it.manifest.name}</span>
                    <span className="text-[11px] text-fg3">{it.source}</span>
                  </div>
                  <div className="text-[12px] text-fg2 line-clamp-2 flex-1 my-1">{it.manifest.description}</div>
                  <div className="flex gap-1.5">
                    {it.installed
                      ? <button disabled={busy === it.id} onClick={() => run(it.id, "uninstall")} className="px-2 py-0.5 rounded-md border border-line text-[12px] text-fg2">Désinstaller</button>
                      : <button disabled={busy === it.id} onClick={() => install(it)} className="px-2 py-0.5 rounded-md bg-accent text-accent-fg text-[12px] font-medium">Installer</button>}
                    {it.manifest.type !== "mcp" && !it.published && <button disabled={busy === it.id} onClick={() => confirm(`Publier « ${it.manifest.name} » sur la page publique ?`) && run(it.id, "publish")} className="px-2 py-0.5 rounded-md border border-line text-[12px] text-fg2">Publier</button>}
                    {it.published && <span className="text-[11.5px] text-ok self-center">publié</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function IntegrationsSection() {
  const { data } = useOptional<Record<string, { connected: boolean; detail?: string; connectUrl?: string }> | { id: string; name?: string; connected: boolean; detail?: string; connectUrl?: string }[]>("/api/integrations", 0);
  const items = data == null ? [] : Array.isArray(data) ? data : Object.entries(data).map(([id, v]) => ({ id, ...v }));
  return (
    <Section title="Intégrations" icon={<Plug size={15} />}>
      {data === undefined ? <Loading /> : data === null ? <NA /> : !items.length ? <Empty t="Aucune intégration." /> : (
        <ul className="flex flex-col gap-1.5">
          {items.map((i: any) => (
            <li key={i.id} className="flex items-center gap-2 text-[13px]">
              <span className="dot" style={{ background: i.connected ? "var(--ok)" : "var(--fg3)" }} />
              <span className="flex-1 truncate">{i.name ?? i.id}{i.detail && <span className="text-fg3"> · {i.detail}</span>}</span>
              {!i.connected && i.connectUrl && <a href={i.connectUrl} className="text-[12px] px-2 py-0.5 rounded-md bg-accent text-accent-fg font-medium">Connecter</a>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}


// ---------- indicateurs clés ----------
function Kpis() {
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const { data: health } = useOptional<HealthCheck[]>("/api/health", 60_000);
  const all = Object.values(tasks);
  const running = all.filter((t) => t.status === "running" || t.status === "verifying").length;
  const waiting = all.filter((t) => t.status === "waiting" || t.status === "blocked").length;
  const queued = all.filter((t) => t.status === "queued").length;
  const working = (sessions ?? []).filter((s) => s.status === "working").length;
  const down = (health ?? []).filter((h) => h.status !== "ok").length;
  const items = [
    { label: "Agents au travail", value: running, sub: `${queued} en file`, color: "var(--info)", live: running > 0 },
    { label: "En attente de toi", value: waiting, sub: waiting ? "à traiter" : "rien en attente", color: "var(--warn)" },
    { label: "Sessions Herdr", value: sessions?.length ?? "–", sub: `${working} active${working > 1 ? "s" : ""}`, color: "var(--accent)", live: working > 0 },
    { label: "Santé", value: health ? (down ? down : "OK") : "–", sub: health ? (down ? "problème(s)" : `${health.length} checks`) : "", color: down ? "var(--bad)" : "var(--ok)" },
  ];
  return (
    <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map((k) => (
        <div key={k.label} className="card p-4 relative overflow-hidden fade-in">
          <div className="absolute -right-6 -top-6 w-20 h-20 rounded-full blur-2xl opacity-30" style={{ background: k.color }} />
          <div className="label-xs flex items-center gap-1.5">{k.live && <span className="dot dot-live" style={{ width: 6, height: 6, background: k.color, color: k.color }} />}{k.label}</div>
          <div className="text-[28px] font-semibold tracking-tight tabular-nums mt-1 leading-none">{k.value}</div>
          <div className="text-[12px] text-fg3 mt-1.5">{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- sessions Herdr ----------
const RANK: Record<string, number> = { working: 0, blocked: 1, idle: 2, done: 3 };
function SessionsSection() {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const [kind, setKind] = useState<"all" | "claude" | "codex">("all");
  const name = (pid: string | null) => (pid ? projects.find((p) => p.id === pid)?.name ?? pid : null);
  const list = (sessions ?? []).filter((s) => kind === "all" || s.kind === kind)
    .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (a.projectId ? 0 : 1) - (b.projectId ? 0 : 1));
  const open = async (s: (typeof list)[number]) => {
    if (s.kind !== "claude" && s.kind !== "codex") return;
    if (s.projectId) await openProject(s.projectId);
    else store.set({ view: "thread" });
    openSessions(s.kind, s.paneId);
  };
  return (
    <Section wide title="Sessions Herdr" icon={<SquareTerminal size={15} />} right={
      <div className="flex gap-1">
        {(["all", "claude", "codex"] as const).map((k) => <button key={k} onClick={() => setKind(k)} className={cls("chip h-6", kind === k && "chip-on")}>{{ all: "Toutes", claude: "Claude Code", codex: "Codex" }[k]}</button>)}
      </div>
    }>
      {sessions === null ? <Loading /> : !list.length ? <Empty t="Aucune session ouverte." /> : (
        <div className="grid sm:grid-cols-2 gap-2 max-h-96 overflow-y-auto pr-0.5">
          {list.map((s) => <SessionRow key={s.paneId} s={s} onOpen={() => open(s)} showProject={name(s.projectId)} />)}
        </div>
      )}
    </Section>
  );
}
