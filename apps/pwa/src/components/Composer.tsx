import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Paperclip, Square, X, FileText } from "lucide-react";
import { sendMessage } from "../lib/actions";
import { useStore } from "../lib/store";
import { cls } from "../lib/format";

interface Att { url: string; name: string; mime: string; size: number }

const SUGGEST_PROJECT = ["Où en est le projet ?", "Corrige le dernier bug signalé", "Déploie la branche en cours", "Fais une passation"];
const SUGGEST_GLOBAL = ["Brief de la journée", "Qu'est-ce qui est bloqué ?", "État des quotas", "Rappelle-moi ce soir à 21 h…"];

export function Composer({ disabled, placeholder }: { disabled?: boolean; placeholder?: string }) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [rec, setRec] = useState<"idle" | "rec" | "stt">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const projectId = useStore((s) => s.projectId);
  const empty = useStore((s) => !s.threadId || !(s.messages[s.threadId]?.length));
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const voiceUsed = useRef(false);

  useEffect(() => {
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
  const suggestions = projectId ? SUGGEST_PROJECT : SUGGEST_GLOBAL;

  return (
    <div className="px-3 md:px-8 pb-3 safe-bottom">
      <div className="max-w-[760px] mx-auto">
        {empty && !text && !disabled && (
          <div className="flex gap-1.5 mb-2.5 overflow-x-auto no-scrollbar pb-0.5 fade-in" style={{ scrollbarWidth: "none" }}>
            {suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => { if (s.endsWith("…")) { setText(s.slice(0, -1)); ta.current?.focus(); } else send(s); }}>{s}</button>
            ))}
          </div>
        )}
        {err && <div className="text-bad text-[12.5px] mb-1.5 flex items-center gap-2 px-1">{err}<button onClick={() => setErr(null)} aria-label="Fermer"><X size={12} /></button></div>}
        <div className={cls("glass border rounded-[22px] transition-all", focus ? "border-[color-mix(in_oklab,var(--accent)_45%,transparent)] shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_12%,transparent),var(--shadow-lg)]" : "border-line2")} style={{ boxShadow: focus ? undefined : "var(--shadow-lg)" }}>
          {(atts.length > 0 || uploading > 0) && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {atts.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 text-[12px] bg-bg3 border border-line rounded-lg pl-1 pr-1.5 py-1">
                  {a.mime.startsWith("image/") ? <img src={a.url} alt="" className="w-6 h-6 rounded object-cover" /> : <FileText size={14} className="text-fg3 ml-1" />}
                  <span className="max-w-[160px] truncate">{a.name}</span>
                  <button onClick={() => setAtts((x) => x.filter((_, j) => j !== i))} className="text-fg3 hover:text-fg" aria-label="Retirer"><X size={12} /></button>
                </span>
              ))}
              {uploading > 0 && <span className="text-[12px] text-fg3 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" />envoi…</span>}
            </div>
          )}
          <textarea
            ref={ta} rows={1} value={text} disabled={disabled}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); send(); } }}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); upload(e.clipboardData.files); } }}
            placeholder={rec === "rec" ? "Je t'écoute…" : placeholder ?? "Demande n'importe quoi à Novabot…"}
            className="block w-full bg-transparent outline-none resize-none px-4 pt-3.5 pb-1 text-[15px] leading-relaxed max-h-[240px] placeholder:text-fg3"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <button onClick={() => fileIn.current?.click()} className="icon-btn max-md:w-11 max-md:h-11" title="Joindre un fichier" aria-label="Joindre"><Paperclip size={17} /></button>
            <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
            <button onClick={toggleRec} className={cls("icon-btn max-md:w-11 max-md:h-11", rec === "rec" && "text-bad bg-bad/10")} title={rec === "rec" ? "Arrêter" : "Dicter"} aria-label="Dicter">
              {rec === "stt" ? <Loader2 size={17} className="animate-spin" /> : rec === "rec" ? <Square size={15} fill="currentColor" /> : <Mic size={17} />}
            </button>
            {rec === "rec" && <span className="wave flex items-center h-4 ml-1" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
            <span className="flex-1" />
            <span className="text-[11px] text-fg3 mr-2 max-md:hidden"><span className="kbd">↵</span> envoyer · <span className="kbd">⇧↵</span> ligne</span>
            <button onClick={() => send()} disabled={!canSend}
              className={cls("w-9 h-9 max-md:w-11 max-md:h-11 rounded-full inline-flex items-center justify-center transition-all", canSend ? "grad-bg shadow-[0_6px_20px_-6px_rgba(99,102,241,.8)] hover:scale-105" : "bg-bg4 text-fg3")}
              title="Envoyer (Entrée)" aria-label="Envoyer">
              {sending ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
