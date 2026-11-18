import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ArrowUp, Loader2, Mic, Paperclip, Square, X, FileText } from "lucide-react";
import { sendMessage } from "../lib/actions";
import { cls } from "../lib/format";

interface Att { url: string; name: string; mime: string; size: number }

/** Actions exposées au fil (suggestions de l'état vide). */
export interface ComposerApi { send: (text: string) => void; prefill: (text: string) => void }

export function Composer({ disabled, placeholder, apiRef }: { disabled?: boolean; placeholder?: string; apiRef?: Ref<ComposerApi> }) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [rec, setRec] = useState<"idle" | "rec" | "stt">("idle");
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const voiceUsed = useRef(false);

  // auto-grow avant peinture (pas de saut visible)
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  const send = async (override?: string) => {
    const content = (override ?? text).trim();
    if ((!content && !atts.length) || sending) return;
    setSending(true); setErr(null);
    try {
      await sendMessage(content, { ...(atts.length ? { attachments: atts } : {}), ...(voiceUsed.current ? { voice: true } : {}) });
      setText(""); setAtts([]); voiceUsed.current = false;
    } catch (e: any) { setErr("Envoi impossible : " + (e?.message ?? "erreur")); }
    finally { setSending(false); ta.current?.focus(); }
  };

  useImperativeHandle(apiRef, () => ({
    send: (t: string) => { void send(t); },
    prefill: (t: string) => { setText(t); requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length); } }); },
  }));

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const fd = new FormData(); fd.append("file", f, f.name);
        const res = await fetch("/api/uploads", { method: "POST", body: fd, credentials: "same-origin" });
        if (res.status === 404) { setErr("Pièces jointes pas encore disponibles côté serveur."); continue; }
        if (!res.ok) throw new Error(res.statusText);
        const j = await res.json();
        setAtts((a) => [...a, { url: j.url, name: j.name ?? f.name, mime: j.mime ?? f.type, size: j.size ?? f.size }]);
      } catch (e: any) { setErr("Envoi du fichier impossible : " + (e?.message ?? "")); }
      finally { setUploading((n) => n - 1); }
    }
  };

  const toggleRec = async () => {
    if (rec === "rec") { recorder.current?.stop(); return; }
    if (rec !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) ?? "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec("stt");
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
          const res = await fetch("/api/voice/stt", { method: "POST", headers: { "content-type": blob.type }, body: blob, credentials: "same-origin" });
          if (res.status === 404) { setErr("Transcription pas encore disponible côté serveur."); return; }
          if (!res.ok) throw new Error(res.statusText);
          const j = await res.json();
          if (j.text) { setText((t) => (t ? t + " " : "") + j.text); voiceUsed.current = true; }
        } catch (e: any) { setErr("Transcription impossible : " + (e?.message ?? "")); }
        finally { setRec("idle"); }
      };
      recorder.current = mr;
      mr.start();
      setRec("rec");
    } catch { setErr("Micro indisponible (autorisation refusée ?)"); }
  };

  const canSend = !sending && (!!text.trim() || atts.length > 0);

  return (
    <div className="px-3 md:px-6 pb-3 md:pb-5">
      <div className="max-w-[var(--chat-w)] mx-auto">
        {err && <div className="text-bad text-[12.5px] mb-2 flex items-center gap-2 px-3 fade-in">{err}<button onClick={() => setErr(null)} aria-label="Fermer"><X size={12} /></button></div>}
        <div className="composer">
          {(atts.length > 0 || uploading > 0) && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {atts.map((a, i) => (
                <span key={i} className="pop-in inline-flex items-center gap-1.5 text-[12px] bg-bg3 border border-line rounded-xl pl-1 pr-1.5 py-1">
                  {a.mime.startsWith("image/") ? <img src={a.url} alt="" className="w-7 h-7 rounded-lg object-cover" /> : <FileText size={14} className="text-fg3 ml-1" />}
                  <span className="max-w-[160px] truncate">{a.name}</span>
                  <button onClick={() => setAtts((x) => x.filter((_, j) => j !== i))} className="text-fg3 hover:text-fg p-0.5" aria-label="Retirer"><X size={12} /></button>
                </span>
              ))}
              {uploading > 0 && <span className="text-[12px] text-fg3 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" />envoi…</span>}
            </div>
          )}
          <textarea
            ref={ta} rows={1} value={text} disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); send(); } }}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); upload(e.clipboardData.files); } }}
            placeholder={rec === "rec" ? "Je t'écoute…" : placeholder ?? "Demande n'importe quoi à Novabot…"}
            enterKeyHint="send"
            className="block w-full bg-transparent outline-none resize-none px-4 md:px-5 pt-3.5 pb-1 text-[16px] md:text-[15px] leading-[1.55] max-h-[240px] placeholder:text-fg3"
          />
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <button onClick={() => fileIn.current?.click()} className="icon-btn w-10 h-10 rounded-full" title="Joindre un fichier" aria-label="Joindre"><Paperclip size={18} /></button>
            <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
            <button onClick={toggleRec} className={cls("icon-btn w-10 h-10 rounded-full", rec === "rec" && "text-bad bg-bad/10")} title={rec === "rec" ? "Arrêter" : "Dicter"} aria-label="Dicter">
              {rec === "stt" ? <Loader2 size={18} className="animate-spin" /> : rec === "rec" ? <Square size={15} fill="currentColor" /> : <Mic size={18} />}
            </button>
            {rec === "rec" && <span className="wave flex items-center h-4 ml-1" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
            <span className="flex-1" />
            <span className="text-[11px] text-fg3 mr-2 max-md:hidden"><span className="kbd">↵</span> envoyer · <span className="kbd">⇧↵</span> ligne</span>
            <button onClick={() => send()} disabled={!canSend}
              className={cls("send-btn w-10 h-10 rounded-full inline-flex items-center justify-center", canSend || sending ? "ready" : "idle")}
              style={{ opacity: 1 }}
              title="Envoyer (Entrée)" aria-label="Envoyer">
              {sending ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp key={String(canSend)} size={19} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
