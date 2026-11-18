// Cache local (localStorage, try/catch partout) pour un premier affichage instantané.
const PREFIX = "nb:";
export function cacheGet<T>(key: string): T | null {
  try { const v = localStorage.getItem(PREFIX + key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
export function cacheSet(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* quota / navigation privée */ }
}
export function cacheDel(key: string) { try { localStorage.removeItem(PREFIX + key); } catch {} }
