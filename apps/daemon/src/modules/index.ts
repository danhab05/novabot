// Liste des modules chargés au démarrage. Chaque package exporte `default: Module`
// (voir apps/daemon/src/core/context.ts). Un module absent ou en échec n'empêche pas le démarrage.
export const MODULES: Record<string, () => Promise<any>> = {
  importer: () => import("./importer.ts"),
  memory: () => import("@novabot/brain/memory"),
  brain: () => import("@novabot/brain"),
  herdr: () => import("@novabot/herdr"),
  sessions: () => import("@novabot/herdr/sessions"),
  discord: () => import("@novabot/discord"),
  browser: () => import("@novabot/browser"),
  proactive: () => import("@novabot/proactive"),
  catalog: () => import("@novabot/catalog"),
};
