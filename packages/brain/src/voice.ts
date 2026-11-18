// Voix : STT faster-whisper (worker Python persistant, chargé à la demande, arrêté après inactivité)
// et TTS Edge TTS (voix fr-FR-RemyMultilingualNeural). Venv : ~/.novabot/venv.
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { NOVA_DIR } from "./util.ts";

const VENV = process.env.NOVABOT_VENV ?? join(NOVA_DIR, "venv");
const WORKER = new URL("./voice_worker.py", import.meta.url).pathname;
const VOICE = process.env.NOVABOT_TTS_VOICE ?? "fr-FR-RemyMultilingualNeural";
const IDLE_MS = 10 * 60_000;

export interface VoiceService { stt(buf: Uint8Array, mime: string): Promise<string>; tts(text: string): Promise<Uint8Array>; available(): { stt: boolean; tts: boolean } }

const extFor = (mime: string) => (mime.match(/(ogg|opus|webm|mp4|m4a|mpeg|mp3|wav|aac|flac)/)?.[1] ?? "bin").replace("mpeg", "mp3");

export function createVoice(): VoiceService {
  let proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let ready: Promise<void> | null = null;
  const pending = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  let idle: Timer | null = null;
  const tmp = join(NOVA_DIR, "tmp"); mkdirSync(tmp, { recursive: true, mode: 0o700 });

  const start = () => {
    if (ready) return ready;
    proc = Bun.spawn([join(VENV, "bin", "python"), WORKER], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const p = proc;
    ready = new Promise<void>((resolve, reject) => {
      (async () => {
        const reader = p.stdout.getReader(); const dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (value) buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let d: any; try { d = JSON.parse(line); } catch { continue; }
            if (d.ready) { resolve(); continue; }
            const w = pending.get(d.id); if (!w) continue; pending.delete(d.id);
            d.error ? w.reject(new Error(d.error)) : w.resolve(d.text ?? "");
          }
          if (done) break;
        }
        reject(new Error("worker STT terminé"));
        for (const w of pending.values()) w.reject(new Error("worker STT terminé"));
        pending.clear(); proc = null; ready = null;
      })();
    });
    return ready;
  };
  const touch = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { proc?.kill(); proc = null; ready = null; }, IDLE_MS); };

  return {
    available: () => ({ stt: existsSync(join(VENV, "bin", "python")), tts: existsSync(join(VENV, "bin", "edge-tts")) }),
    async stt(buf, mime) {
      await start(); touch();
      const rid = crypto.randomUUID();
      const f = join(tmp, `stt-${rid}.${extFor(mime)}`);
      writeFileSync(f, buf);
      try {
        return await new Promise<string>((resolve, reject) => {
          pending.set(rid, { resolve, reject });
          proc!.stdin.write(JSON.stringify({ id: rid, path: f, language: "fr" }) + "\n");
          proc!.stdin.flush();
          setTimeout(() => { if (pending.delete(rid)) reject(new Error("STT : délai dépassé")); }, 300_000);
        });
      } finally { try { unlinkSync(f); } catch { /* */ } }
    },
    async tts(text) {
      const f = join(tmp, `tts-${crypto.randomUUID()}.mp3`);
      const p = Bun.spawn([join(VENV, "bin", "edge-tts"), "--voice", VOICE, "--text", text.slice(0, 5000), "--write-media", f], { stdout: "ignore", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) throw new Error(`edge-tts a échoué : ${(await new Response(p.stderr).text()).slice(0, 200)}`);
      try { return new Uint8Array(readFileSync(f)); } finally { try { unlinkSync(f); } catch { /* */ } }
    },
  };
}
