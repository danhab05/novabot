import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const NOVA_DIR = process.env.NOVABOT_DATA ?? join(HOME, ".novabot");

/** Parse un flux SSE (text/event-stream) en évènements {event, data}. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === "\r" ? 4 : 2));
      let event = "message"; const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
    if (done) break;
  }
}

/** Décode la charge utile d'un JWT (sans vérifier la signature). */
export function jwtPayload(token: string): any {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return null; }
}

/** Extrait le premier objet JSON d'un texte (le modèle peut entourer de ```json). */
export function extractJson<T = any>(text: string): T | null {
  const t = text.replace(/```(?:json)?/g, "");
  const start = t.search(/[{[]/);
  if (start < 0) return null;
  for (let end = t.length; end > start; end--) {
    const ch = t[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(t.slice(start, end)); } catch { /* continue */ }
  }
  return null;
}

export function clip(s: string, n: number) { return s.length > n ? s.slice(0, n) + `\n…[tronqué, ${s.length - n} caractères]` : s; }
