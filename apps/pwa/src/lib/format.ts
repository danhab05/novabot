import type { TaskStatus } from "@novabot/shared";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "En file", running: "En cours", verifying: "Vérification", waiting: "Attend ta réponse", blocked: "Bloquée",
  done: "Terminée", failed: "Échec", cancelled: "Annulée",
};
export const STATUS_COLOR: Record<TaskStatus, string> = {
  queued: "var(--fg3)", running: "var(--info)", verifying: "var(--accent)", waiting: "var(--warn)", blocked: "var(--bad)",
  done: "var(--ok)", failed: "var(--bad)", cancelled: "var(--fg3)",
};
export const ACTIVE: TaskStatus[] = ["queued", "running", "verifying", "waiting", "blocked"];
export const isActive = (s: TaskStatus) => ACTIVE.includes(s);

const rtf = typeof Intl !== "undefined" && (Intl as any).RelativeTimeFormat ? new Intl.RelativeTimeFormat("fr", { numeric: "auto" }) : null;
export function ago(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = (ts - Date.now()) / 1000;
  const a = Math.abs(d);
  if (!rtf) return new Date(ts).toLocaleString("fr-FR");
  if (a < 45) return "à l'instant";
  if (a < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(d / 3600), "hour");
  if (a < 86400 * 7) return rtf.format(Math.round(d / 86400), "day");
  return new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
export const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
export const cls = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
