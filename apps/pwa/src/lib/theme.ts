// Thème : sombre par défaut ; « système » suit l'OS ; « clair » forcé. Mémorisé localement.
export type Theme = "dark" | "system" | "light";
const KEY = "nb:theme";
export function getTheme(): Theme {
  try { const t = localStorage.getItem(KEY); if (t === "dark" || t === "light" || t === "system") return t; } catch {}
  return "dark";
}
export function applyTheme(t: Theme = getTheme()) {
  document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
  document.querySelector('meta[name="theme-color"]:not([media])')?.setAttribute("content", dark ? "#07080d" : "#f6f7fb");
}
export function setTheme(t: Theme) { try { localStorage.setItem(KEY, t); } catch {} applyTheme(t); }
export const nextTheme = (t: Theme): Theme => (t === "dark" ? "light" : t === "light" ? "system" : "dark");
