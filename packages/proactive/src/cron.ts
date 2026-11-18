// Parseur cron 5 champs + calcul de la prochaine exécution en heure murale d'un fuseau (Europe/Paris par défaut).
// DST : une heure murale inexistante (passage à l'heure d'été) est sautée ; une heure ambiguë
// (passage à l'heure d'hiver) ne déclenche qu'une fois (première occurrence).

export const TZ = process.env.NOVABOT_TZ || "Europe/Paris"; // fuseau des crons (défaut Europe/Paris)

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function parseField(f: string, min: number, max: number, names?: string[]): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  const val = (s: string) => {
    const n = names?.indexOf(s.toLowerCase()) ?? -1;
    const v = n >= 0 ? n + (min === 1 ? 1 : 0) : Number(s);
    if (!Number.isInteger(v)) throw new Error(`valeur cron invalide: ${s}`);
    return v;
  };
  for (const part of f.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`pas cron invalide: ${part}`);
    let lo: number, hi: number;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { const [a, b] = range.split("-"); lo = val(a); hi = val(b); }
    else { lo = val(range); hi = stepS === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`plage cron invalide: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(max === 7 && v === 7 ? 0 : v);
  }
  return { set, star: f === "*" || f.startsWith("*/") };
}

export function parseCron(expr: string): CronSpec {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error(`expression cron à 5 champs attendue: "${expr}"`);
  const minute = parseField(f[0], 0, 59), hour = parseField(f[1], 0, 23), dom = parseField(f[2], 1, 31),
    month = parseField(f[3], 1, 12, MONTHS), dow = parseField(f[4], 0, 7, DAYS);
  return { minute: minute.set, hour: hour.set, dom: dom.set, month: month.set, dow: dow.set, domStar: dom.star, dowStar: dow.star };
}

// ---- fuseau ----
const dtf = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = dtf.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); dtf.set(tz, f); }
  return f;
}
export function wallParts(ms: number, tz = TZ) {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}
function offsetMs(ms: number, tz: string) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}
/** Heure murale -> epoch ms. null si l'heure n'existe pas (saut DST). Heure ambiguë -> première occurrence. */
export function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz = TZ): number | null {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = new Set<number>();
  for (const probe of [naive - 3 * 3600_000, naive, naive + 3 * 3600_000]) candidates.add(naive - offsetMs(probe, tz));
  const ok = [...candidates].filter((t) => { const w = wallParts(t, tz); return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi; }).sort((a, b) => a - b);
  return ok.length ? ok[0] : null;
}

/** Prochaine exécution strictement après `from` (epoch ms). */
export function nextRun(expr: string | CronSpec, from: number, tz = TZ): number | null {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  const start = wallParts(from, tz);
  const hours = [...s.hour].sort((a, b) => a - b), minutes = [...s.minute].sort((a, b) => a - b);
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  for (let i = 0; i < 366 * 5; i++, day += 86400_000) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    if (!s.month.has(mo)) continue;
    const domOk = s.dom.has(d), dowOk = s.dow.has(wd);
    const dayOk = s.domStar && s.dowStar ? true : s.domStar ? dowOk : s.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of hours) for (const mi of minutes) {
      const t = wallToUtc(y, mo, d, h, mi, tz);
      if (t !== null && t > from) return t;
    }
  }
  return null;
}

/** "2026-11-18 21:00" (heure de Paris) -> epoch ms. Accepte aussi un ISO avec fuseau explicite. */
export function parseAt(s: string, tz = TZ): number {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (m) {
    const t = wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
    if (t === null) throw new Error(`heure inexistante (changement d'heure): ${s}`);
    return t;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s.trim())) throw new Error(`date invalide (format attendu "AAAA-MM-JJ HH:MM", heure de Paris): ${s}`);
  return t;
}

export function formatParis(ms: number, tz = TZ) {
  const w = wallParts(ms, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}`;
}
