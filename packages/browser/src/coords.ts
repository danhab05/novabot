// Conversion coordonnées image (pixels du JPEG reçu par la PWA) -> CSS px du viewport (Input.dispatchMouseEvent).
export interface FrameMeta { deviceWidth: number; deviceHeight: number; pageScaleFactor?: number; offsetTop?: number }

export function imageToCss(x: number, y: number, imgW: number, imgH: number, m: FrameMeta): { x: number; y: number } {
  const psf = m.pageScaleFactor || 1;
  const cx = ((x * m.deviceWidth) / imgW) / psf;
  const cy = ((y * m.deviceHeight) / imgH - (m.offsetTop || 0)) / psf;
  return { x: clamp(cx, 0, m.deviceWidth), y: clamp(cy, 0, m.deviceHeight) };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Math.round(v * 100) / 100));

/** Lit largeur/hauteur d'un JPEG (base64) via le marqueur SOF. */
export function jpegSize(b64: string): { width: number; height: number } | null {
  const buf = Buffer.from(b64.slice(0, 4096 * 4), "base64"); // l'en-tête suffit (SOF avant les données)
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

const VK: Record<string, number> = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32,
};

/** Paramètres Input.dispatchKeyEvent pour un message `key` de la PWA. */
export function keyEventParams(kind: "down" | "up" | "char", key: string, code?: string, text?: string) {
  if (kind === "char") return { type: "char", text: text ?? key, key };
  const vk = VK[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const p: Record<string, unknown> = { type: kind === "down" ? "keyDown" : "keyUp", key, code: code ?? defaultCode(key), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (kind === "down") {
    const t = text ?? (key === "Enter" ? "\r" : key.length === 1 ? key : undefined);
    if (t !== undefined) { p.text = t; p.unmodifiedText = t; }
    else p.type = "rawKeyDown";
  }
  return p;
}

function defaultCode(key: string) {
  if (key.length === 1) return /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /\d/.test(key) ? "Digit" + key : key === " " ? "Space" : "";
  return key;
}
