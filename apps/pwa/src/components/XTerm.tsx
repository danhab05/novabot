// Terminal xterm.js qui reflète l'écran d'un panneau Herdr (chunk chargé à la demande).
// Live : polling de l'écran visible toutes les 700 ms (pause si l'onglet est caché), re-rendu seulement si l'écran change.
// Historique : lecture unique des 1000 dernières lignes, défilable.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../fonts-mono.css";
import { api } from "../lib/api";
import { parseTermInput, type TermOp } from "../lib/sessions";

export interface ScreenInfo { status: string; title: string; error?: string }

const THEME = {
  background: "#090b12", foreground: "#d8dcea", cursor: "rgba(0,0,0,0)", cursorAccent: "rgba(0,0,0,0)",
  selectionBackground: "rgba(139,123,255,0.35)",
  black: "#1b1e2b", red: "#f87171", green: "#34d399", yellow: "#fbbf24", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d8dcea",
  brightBlack: "#5b6178", brightRed: "#fca5a5", brightGreen: "#6ee7b7", brightYellow: "#fde68a", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const visibleWidth = (line: string) => [...line.replace(ANSI_RE, "")].length;

export default function XTerm({ paneId, mode, onInfo, onInput, nudge }: {
  paneId: string; mode: "live" | "history"; onInfo?: (i: ScreenInfo) => void; onInput?: (op: TermOp) => void; nudge?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const last = useRef<string>("");
  const pollNow = useRef<() => void>(() => {});
  const onInputRef = useRef(onInput); onInputRef.current = onInput;
  const onInfoRef = useRef(onInfo); onInfoRef.current = onInfo;

  useEffect(() => {
    const el = host.current!;
    const t = new Terminal({
      fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.15,
      theme: THEME, cursorBlink: false, cursorStyle: "bar", cursorInactiveStyle: "none",
      scrollback: mode === "history" ? 5000 : 0, allowTransparency: false, convertEol: false, disableStdin: mode === "history",
      cols: 120, rows: 30,
    });
    t.open(el);
    term.current = t;
    last.current = "";
    const sub = t.onData((d) => { for (const op of parseTermInput(d)) onInputRef.current?.(op); setTimeout(() => pollNow.current(), 120); });

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let fails = 0;

    const render = (ansi: string) => {
      const text = ansi.replace(/\r?\n/g, "\r\n").replace(/(\r\n)+$/, "");
      const lines = text.split("\r\n");
      const cols = Math.max(60, Math.min(400, Math.max(...lines.map(visibleWidth)) + 1));
      const rows = mode === "live" ? Math.max(8, lines.length) : Math.max(10, Math.floor((el.clientHeight - 20) / 15));
      // police ajustée pour faire tenir la largeur du panneau Herdr dans le conteneur
      const avail = Math.max(200, el.clientWidth - 24);
      const fs = Math.max(7.5, Math.min(13.5, avail / (cols * 0.6)));
      if (Math.abs((t.options.fontSize ?? 0) - fs) > 0.2) t.options.fontSize = fs;
      if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows);
      t.reset();
      t.write(text);
      if (mode === "history") t.scrollToBottom();
    };

    const tick = async () => {
      if (stopped) return;
      if (document.hidden && mode === "live") { timer = setTimeout(tick, 1500); return; }
      try {
        const r = await api<{ ansi: string; status: string; title: string }>(
          `/api/sessions/${encodeURIComponent(paneId)}/screen?source=${mode === "live" ? "visible" : "recent"}&lines=${mode === "live" ? 200 : 1000}`,
        );
        fails = 0;
        onInfoRef.current?.({ status: r.status, title: r.title });
        if (r.ansi !== last.current) { last.current = r.ansi; render(r.ansi); }
      } catch (e: any) {
        fails++;
        onInfoRef.current?.({ status: "unknown", title: "", error: fails > 2 ? "Session introuvable : elle a sans doute été fermée dans Herdr." : (e?.message ?? "erreur de lecture") });
        if (fails >= 6) return; // session disparue : on arrête d'interroger
      }
      // recul progressif en cas d'erreur (0,7 s → 5 s)
      if (!stopped && mode === "live") timer = setTimeout(tick, fails ? Math.min(5000, 700 * 2 ** fails) : 700);
    };
    pollNow.current = () => { if (timer) clearTimeout(timer); tick(); };
    tick();

    const ro = new ResizeObserver(() => { if (last.current) render(last.current); });
    ro.observe(el);
    const vis = () => { if (!document.hidden) pollNow.current(); };
    document.addEventListener("visibilitychange", vis);
    return () => {
      stopped = true; if (timer) clearTimeout(timer);
      ro.disconnect(); document.removeEventListener("visibilitychange", vis);
      sub.dispose(); t.dispose(); term.current = null;
    };
  }, [paneId, mode]);

  // demande de rafraîchissement externe (après une saisie depuis la barre mobile)
  useEffect(() => { if (nudge) setTimeout(() => pollNow.current(), 150); }, [nudge]);

  return <div ref={host} className="term-wrap h-full w-full overflow-auto" style={{ background: THEME.background }} onClick={() => term.current?.focus()} />;
}
