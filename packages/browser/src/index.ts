// Module « browser » : vue live du Chrome partagé (CDP 127.0.0.1:9222) dans la PWA + reprise en main.
// CDP n'est jamais exposé : tout passe par le daemon (WS /api/browser/ws, admin seulement).
import type { Module, Ctx } from "@novabot/daemon/core";
import type { BrowserClientMsg } from "@novabot/shared";
import { CdpConn } from "./cdp.ts";
import { BrowserHub, type Tab, type Viewer } from "./hub.ts";

export { BrowserHub } from "./hub.ts";
export { imageToCss, jpegSize, keyEventParams } from "./coords.ts";

const owner = () => process.env.NOVABOT_OWNER_NAME || "Owner";
const CDP = process.env.NOVABOT_CDP_URL ?? "http://127.0.0.1:9222";

export async function listTargets(): Promise<Tab[]> {
  const r = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(4000) });
  const list = (await r.json()) as any[];
  return list
    .filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !String(t.url).startsWith("devtools://"))
    .map((t) => ({ targetId: t.id, title: t.title || t.url, url: t.url, owner: null, wsUrl: t.webSocketDebuggerUrl }));
}

let hub: BrowserHub | null = null;

const mod: Module = {
  name: "browser",
  init(ctx: Ctx) {
    hub = new BrowserHub({
      listTargets,
      connect: (tab) => CdpConn.connect(tab.wsUrl!),
      log: (...a) => ctx.log("browser", ...a),
      onTakeover: (s) => ctx.bus.emit({
        type: "notify", level: "info", projectId: null, url: s.targetId ? `/browser?target=${s.targetId}` : undefined,
        title: s.on ? `${owner()} a pris la main sur le navigateur` : `${owner()} a rendu la main sur le navigateur`,
        body: s.on ? "Les agents attendent avant d'agir dans Chrome." : "Les agents peuvent reprendre.",
      }),
    });
    ctx.services.browser = hub;

    ctx.tools.register({
      name: "browser_status",
      description: "À consulter avant d'agir dans le Chrome partagé : indique si le propriétaire a pris la main (captcha, 2FA, login). Si takeover=true, n'agis pas dans le navigateur : attends qu'il rende la main.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const t = hub!.takeover;
        return { ...t, instruction: t.on ? `${owner()} a la main : attends qu'il la rende (rappelle browser_status dans 30 s) avant toute action navigateur.` : "Navigateur libre." };
      },
    });
    ctx.tools.register({
      name: "browser_handoff",
      description: "Demande au propriétaire de prendre la main dans le Chrome partagé (captcha, 2FA, login expiré, clic impossible). Laisse l'onglet ouvert sur la page concernée, puis attends que browser_status repasse à takeover=false après sa reprise.",
      inputSchema: {
        type: "object", required: ["reason"],
        properties: { reason: { type: "string", description: "ex. « captcha sur example.com »" }, url: { type: "string", description: "URL de l'onglet concerné" }, targetId: { type: "string" } },
      },
      async run(i: { reason: string; url?: string; targetId?: string }, tc) {
        let targetId = i.targetId ?? null;
        if (!targetId && i.url) { try { targetId = (await listTargets()).find((t) => t.url.startsWith(i.url!))?.targetId ?? null; } catch {} }
        await ctx.services.notify.send({
          title: "Navigateur : j'ai besoin de toi",
          body: `${i.reason}. Ouvre le panneau Navigateur, valide, puis rends la main.`,
          level: "blocked", projectId: tc.projectId, threadId: tc.threadId,
          url: targetId ? `/browser?target=${targetId}` : "/browser",
        });
        return { ok: true, targetId, note: `${owner()} est prévenu. Consulte browser_status avant de reprendre.` };
      },
    });
  },
  routes(app, ctx) {
    app.get("/api/browser/tabs", async (c) => {
      if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
      try { return c.json(await hub!.tabs()); } catch (e: any) { return c.json({ error: "chrome_unreachable", detail: String(e?.message ?? e) }, 502); }
    });
    app.get(
      "/api/browser/ws",
      async (c, next) => { if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403); await next(); },
      ctx.services.upgradeWebSocket(() => {
        let viewer: Viewer | null = null;
        return {
          onOpen(_e: unknown, ws: any) {
            viewer = {
              id: crypto.randomUUID(), targetId: null,
              send: (m) => { try { ws.send(JSON.stringify(m)); } catch {} },
              buffered: () => { try { return ws.raw?.getBufferedAmount?.() ?? 0; } catch { return 0; } },
            };
            hub!.addViewer(viewer);
          },
          onMessage(e: { data: unknown }) {
            if (!viewer) return;
            let m: BrowserClientMsg;
            try { m = JSON.parse(String(e.data)); } catch { return viewer.send({ t: "error", message: "message invalide" }); }
            hub!.handle(viewer, m);
          },
          onClose() { if (viewer) hub!.removeViewer(viewer); viewer = null; },
        };
      }),
    );
  },
  async stop() { await hub?.shutdown(); },
};
export default mod;
