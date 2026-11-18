import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Keyboard, RefreshCw, ArrowRight } from "lucide-react";
import type { BrowserClientMsg, BrowserServerMsg } from "@novabot/shared";
import { mapPoint } from "../lib/coords";
import { cls } from "../lib/format";

type Tab = { targetId: string; title: string; url: string; owner?: string | null };
const decode = (s: string) => s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[e.toLowerCase()] ?? m);
const SPECIAL = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export default function BrowserPanel() {
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "na">("connecting");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ src: string; w: number; h: number } | null>(null);
  const [takeover, setTakeover] = useState<{ on: boolean; by: string | null }>({ on: false, by: null });
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const ws = useRef<WebSocket | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const kb = useRef<HTMLInputElement>(null);
  const lastMove = useRef(0);
  const retry = useRef(0);
  const targetRef = useRef<string | null>(null);
  targetRef.current = target;

  const send = useCallback((m: BrowserClientMsg) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m)); }, []);

  const watch = useCallback((id: string) => {
    setTarget(id); setFrame(null);
    const w = Math.min(1600, Math.round((img.current?.parentElement?.clientWidth ?? 800) * (window.devicePixelRatio || 1)));
    send({ t: "watch", targetId: id, maxWidth: w, quality: 70 });
  }, [send]);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/api/browser/ws`);
      ws.current = sock;
      setStatus("connecting");
      let opened = false;
      sock.onopen = () => {
        opened = true; retry.current = 0; setStatus("open"); setError(null);
        sock.send(JSON.stringify({ t: "list" } satisfies BrowserClientMsg));
        if (targetRef.current) watch(targetRef.current);
      };
      sock.onmessage = (ev) => {
        let m: BrowserServerMsg; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "tabs") {
          setTabs(m.tabs);
          if (!targetRef.current && m.tabs.length) watch(m.tabs[0].targetId);
          const cur = m.tabs.find((t) => t.targetId === targetRef.current);
          if (cur) setUrl((u) => (document.activeElement?.id === "nb-url" ? u : cur.url));
        } else if (m.t === "frame") setFrame({ src: "data:image/jpeg;base64," + m.data, w: m.width, h: m.height });
        else if (m.t === "takeover") setTakeover({ on: m.on, by: m.by });
        else if (m.t === "error") setError(m.message);
      };
      sock.onclose = () => {
        if (closed) return;
        if (!opened && retry.current >= 2) { setStatus("na"); return; }
        setStatus("closed");
        retry.current++;
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry.current));
      };
    };
    connect();
    const onVis = () => { if (!document.hidden && ws.current?.readyState !== WebSocket.OPEN && !closed) connect(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { closed = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); try { ws.current?.send(JSON.stringify({ t: "unwatch" })); } catch {} ws.current?.close(); };
  }, [watch]);

  const point = (e: { clientX: number; clientY: number }) => {
    if (!img.current || !frame) return null;
    return mapPoint(e.clientX, e.clientY, img.current.getBoundingClientRect(), frame.w, frame.h);
  };

  const onPointer = (kind: "down" | "up" | "move") => (e: React.PointerEvent) => {
    if (!takeover.on) return;
    if (kind === "move") { if (!e.buttons) return; const t = performance.now(); if (t - lastMove.current < 40) return; lastMove.current = t; }
    const p = point(e); if (!p) return;
    if (kind === "down") { e.currentTarget.setPointerCapture?.(e.pointerId); kb.current?.focus({ preventScroll: true }); }
    send({ t: "mouse", kind, x: p.x, y: p.y, button: e.button === 2 ? "right" : "left", clickCount: 1 });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!takeover.on) return;
    const p = point(e); if (!p) return;
    send({ t: "mouse", kind: "wheel", x: p.x, y: p.y, deltaY: e.deltaY });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!takeover.on) return;
    if (SPECIAL.has(e.key) || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      send({ t: "key", kind: "down", key: e.key, code: e.code });
      send({ t: "key", kind: "up", key: e.key, code: e.code });
    }
  };
  const onInput = (e: React.FormEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value;
    if (v && takeover.on) send({ t: "type", text: v });
    e.currentTarget.value = "";
  };

  if (status === "na") return <div className="p-6 text-fg3 text-[13px] text-center">Navigateur live pas encore disponible côté serveur.</div>;

  const current = tabs.find((t) => t.targetId === target);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-line">
        <select value={target ?? ""} onChange={(e) => watch(e.target.value)} className="flex-1 min-w-0 bg-bg3 border border-line rounded-md px-2 py-1 text-[12.5px]">
          {!tabs.length && <option value="">Aucun onglet</option>}
          {tabs.map((t) => <option key={t.targetId} value={t.targetId}>{t.owner ? `[${t.owner}] ` : ""}{decode(t.title || t.url)}</option>)}
        </select>
        <button onClick={() => send({ t: "list" })} className="p-1.5 text-fg3 hover:text-fg" title="Rafraîchir les onglets" aria-label="Rafraîchir"><RefreshCw size={14} /></button>
        <button onClick={() => send({ t: "takeover", on: !takeover.on })}
          className={cls("inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12.5px] font-medium border", takeover.on ? "bg-warn/15 border-warn/50 text-warn" : "border-line text-fg2 hover:text-fg")}>
          <Hand size={14} />{takeover.on ? "Je rends la main" : "Je prends la main"}
        </button>
      </div>
      {takeover.on && (
        <form className="flex gap-1 px-2 py-1.5 border-b border-line" onSubmit={(e) => { e.preventDefault(); if (url.trim()) send({ t: "navigate", url: /^https?:\/\//.test(url) ? url : "https://" + url }); }}>
          <input id="nb-url" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1 min-w-0 bg-bg3 border border-line rounded-md px-2 py-1 text-[12.5px] font-mono" placeholder="URL" />
          <button className="px-2 text-fg2" aria-label="Aller"><ArrowRight size={15} /></button>
          <button type="button" onClick={() => kb.current?.focus()} className="px-2 text-fg2 md:hidden" aria-label="Clavier"><Keyboard size={15} /></button>
        </form>
      )}
      <div className="relative flex-1 min-h-0 bg-black/40" onContextMenu={(e) => takeover.on && e.preventDefault()}>
        {frame ? (
          <img ref={img} src={frame.src} alt={current?.title ?? "navigateur"} draggable={false}
            className={cls("absolute inset-0 w-full h-full object-contain select-none touch-none", takeover.on ? "cursor-crosshair" : "cursor-default")}
            onPointerDown={onPointer("down")} onPointerUp={onPointer("up")} onPointerMove={onPointer("move")} onWheel={onWheel} />
        ) : (
          <div ref={img as any} className="absolute inset-0 flex items-center justify-center text-fg3 text-[13px]">
            {status === "open" ? (tabs.length ? "En attente de l'image…" : "Aucun onglet ouvert") : "Connexion au navigateur…"}
          </div>
        )}
        {!takeover.on && frame && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[12px] bg-bg2/90 border border-line rounded-full px-3 py-1 text-fg2 pointer-events-none">
            Vue en direct · « Je prends la main » pour interagir
          </div>
        )}
        {takeover.by && takeover.on && <div className="absolute top-2 left-2 text-[11.5px] bg-warn/20 text-warn rounded px-2 py-0.5">Agent en pause · {takeover.by}</div>}
        <input ref={kb} onKeyDown={onKeyDown} onInput={onInput} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          className="absolute opacity-0 w-px h-px -left-[9999px]" aria-hidden="true" tabIndex={-1} />
      </div>
      {(error || status === "closed") && <div className="px-2 py-1 text-[12px] text-bad border-t border-line">{error ?? "Connexion perdue, reconnexion…"}</div>}
    </div>
  );
}
