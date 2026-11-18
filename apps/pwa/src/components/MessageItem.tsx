import { memo, useRef, useState } from "react";
import { Copy, Check, FileText, Pause, Volume2, Info, AlertTriangle } from "lucide-react";
import type { Message } from "@novabot/shared";
import { renderMarkdown } from "../lib/markdown";
import { hhmm, cls } from "../lib/format";
import { useStore } from "../lib/store";

interface Attachment { url: string; name?: string; mime?: string; size?: number }
type Msg = Message | { id: string; role: "assistant"; content: string; createdAt: number; meta: null; authorId: null };

export const MessageItem = memo(function MessageItem({ m, streamingText }: { m: Msg; streamingText?: boolean }) {
  const meta = (m.meta ?? {}) as Record<string, any>;
  const meName = useStore((s) => s.user?.name ?? null);
  const atts: Attachment[] = Array.isArray(meta.attachments) ? meta.attachments : [];
  const html = renderMarkdown(m.content || "");

  if (m.role === "system" || m.role === "tool") {
    return (
      <div className={cls("msg-in flex items-start gap-2 text-[12.5px] px-3 py-2 rounded-xl border mx-auto max-w-[92%]", meta.error ? "text-bad border-bad/25 bg-bad/5" : "text-fg2 border-line bg-bg2/60")}>
        {meta.error ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <Info size={14} className="mt-0.5 shrink-0 text-fg3" />}
        <div className="md min-w-0" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }

  const mine = m.role === "user";
  const Atts = atts.length > 0 && (
    <div className={cls("flex flex-wrap gap-2 mt-2", mine && "justify-end")}>
      {atts.map((a, i) => a.mime?.startsWith("image/")
        ? <a key={i} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name ?? ""} loading="lazy" className="max-h-52 rounded-xl border border-line" /></a>
        : <a key={i} href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] border border-line rounded-xl px-2.5 py-1.5 bg-bg3 hover:bg-bg4"><FileText size={14} />{a.name ?? "fichier"}</a>)}
    </div>
  );

  if (mine) {
    return (
      <div className="group flex flex-col items-end msg-in">
        <div className="text-[11px] text-fg3 mb-1 px-1 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity max-md:opacity-100">
          {meta.authorName && meta.authorName !== meName && <span className="font-medium text-fg2">{meta.authorName}</span>}
          {meta.source && meta.source !== "pwa" && <span className="chip h-[18px] px-1.5 text-[10.5px]">{meta.source}</span>}
          <span>{hhmm(m.createdAt)}</span>
        </div>
        <div className="rounded-[20px] rounded-br-md px-4 py-2.5 max-w-[88%] md:max-w-[75%] bg-bg3 border border-line2 text-[14.5px]">
          {meta.voice && <div className="text-[11.5px] text-fg3 mb-1">🎙️ message vocal</div>}
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        {Atts}
      </div>
    );
  }

  // assistant : sans bulle, pleine largeur lisible
  return (
    <div className="group flex gap-3 msg-in">
      <div className={cls("orb mt-0.5", streamingText && "orb-think")} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-fg3 mb-1 flex items-center gap-2 h-5">
          <span className="font-semibold text-fg">Novabot</span>
          {meta.provider && <span className="chip h-[18px] px-1.5 text-[10.5px]">{meta.provider}{meta.model ? ` · ${meta.model}` : ""}</span>}
          <span>{hhmm(m.createdAt)}</span>
          {!streamingText && m.content && (
            <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity max-md:opacity-100">
              <CopyButton text={m.content} />
              <TtsButton text={m.content} />
            </span>
          )}
        </div>
        <div className={cls("md text-[14.5px] leading-[1.65]", streamingText && "caret")} dangerouslySetInnerHTML={{ __html: html }} />
        {Atts}
      </div>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); })} className="icon-btn w-6 h-6" title="Copier" aria-label="Copier">
      {ok ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
    </button>
  );
}

function TtsButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "na">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  if (state === "na") return null;
  const play = async () => {
    if (state === "playing") { audio.current?.pause(); setState("idle"); return; }
    setState("loading");
    try {
      const res = await fetch("/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 4000) }) });
      if (res.status === 404) { setState("na"); return; }
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => { setState("idle"); URL.revokeObjectURL(url); };
      await a.play();
      setState("playing");
    } catch { setState("idle"); }
  };
  return (
    <button onClick={play} className="icon-btn w-6 h-6" title="Écouter" aria-label="Écouter">
      {state === "playing" ? <Pause size={12} /> : <Volume2 size={12} className={state === "loading" ? "animate-pulse" : ""} />}
    </button>
  );
}
