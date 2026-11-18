import { memo, useRef, useState } from "react";
import { Copy, Check, FileText, Pause, Volume2, Info, AlertTriangle, Mic } from "lucide-react";
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
        {(meta.authorName && meta.authorName !== meName) || (meta.source && meta.source !== "pwa") ? (
          <div className="text-[11px] text-fg3 mb-1 px-1 flex items-center gap-2">
            {meta.authorName && meta.authorName !== meName && <span className="font-medium text-fg2">{meta.authorName}</span>}
            {meta.source && meta.source !== "pwa" && <span className="chip h-[18px] px-1.5 text-[10.5px]">{meta.source}</span>}
          </div>
        ) : null}
        <div className="bubble-me px-4 py-2.5 max-w-[85%] md:max-w-[78%] text-[15px] leading-[1.6]">
          {meta.voice && <div className="text-[11.5px] text-fg3 mb-1 flex items-center gap-1"><Mic size={11} />message vocal</div>}
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        {Atts}
        <div className="h-6 mt-0.5 px-1 flex items-center gap-1 text-[11px] text-fg3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity max-md:opacity-100">
          <span className="tabular-nums">{hhmm(m.createdAt)}</span>
          {m.content && <CopyButton text={m.content} />}
        </div>
      </div>
    );
  }

  // assistant : sans bulle, pleine largeur lisible ; actions sous le message
  return (
    <div className="group flex gap-3 md:gap-4 msg-in">
      <div className={cls("orb mt-0.5", streamingText && "orb-think")} />
      <div className="flex-1 min-w-0">
        <div className={cls("md prose-chat pt-[2px]", streamingText && "caret")} dangerouslySetInnerHTML={{ __html: html }} />
        {Atts}
        <div className={cls("h-7 mt-1 -ml-1.5 flex items-center gap-0.5 text-[11px] text-fg3 transition-opacity", streamingText ? "invisible" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100")}>
          {m.content && <CopyButton text={m.content} />}
          {m.content && <TtsButton text={m.content} />}
          <span className="ml-1.5 tabular-nums">{hhmm(m.createdAt)}</span>
          {meta.provider && <span className="ml-1.5 truncate">{meta.provider}{meta.model ? ` · ${meta.model}` : ""}</span>}
        </div>
      </div>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); })} className="icon-btn w-7 h-7" title="Copier" aria-label="Copier">
      {ok ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
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
    <button onClick={play} className="icon-btn w-7 h-7" title="Écouter" aria-label="Écouter">
      {state === "playing" ? <Pause size={13} /> : <Volume2 size={13} className={state === "loading" ? "animate-pulse" : ""} />}
    </button>
  );
}
