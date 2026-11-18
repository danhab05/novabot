// Hub du navigateur live : une session de screencast CDP par onglet, partagée entre spectateurs.
import type { BrowserClientMsg, BrowserServerMsg } from "@novabot/shared";
import type { CdpLike } from "./cdp.ts";
import { imageToCss, jpegSize, keyEventParams, type FrameMeta } from "./coords.ts";

export interface Tab { targetId: string; title: string; url: string; owner?: string | null; wsUrl?: string }
export interface Viewer { id: string; send(m: BrowserServerMsg): void; buffered(): number; targetId: string | null }
export interface HubDeps {
  listTargets(): Promise<Tab[]>;
  connect(tab: Tab): Promise<CdpLike>;
  now?: () => number;
  onTakeover?(s: TakeoverState): void;
  log?: (...a: unknown[]) => void;
}
export interface TakeoverState { on: boolean; by: string | null; targetId: string | null; since: number | null }

const MIN_FRAME_MS = 100; // ~10 fps max
const MAX_BUFFERED = 2 * 1024 * 1024; // backpressure : on saute la frame si le client a > 2 Mo en attente

interface Session {
  tab: Tab; conn: CdpLike | null; viewers: Set<Viewer>;
  meta: FrameMeta | null; img: { width: number; height: number } | null; lastFrame: string | null;
  lastAck: number; opts: { maxWidth: number; maxHeight: number; quality: number }; reconnecting: boolean; stopped: boolean;
}

export class BrowserHub {
  private sessions = new Map<string, Session>();
  private allViewers = new Set<Viewer>();
  takeover: TakeoverState = { on: false, by: null, targetId: null, since: null };
  constructor(private deps: HubDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private log(...a: unknown[]) { this.deps.log?.(...a); }

  addViewer(v: Viewer) { this.allViewers.add(v); v.send({ t: "takeover", on: this.takeover.on, by: this.takeover.by }); }
  async removeViewer(v: Viewer) { this.allViewers.delete(v); await this.unwatch(v); }
  sessionCount() { return this.sessions.size; }
  viewersOf(targetId: string) { return this.sessions.get(targetId)?.viewers.size ?? 0; }

  async tabs(): Promise<Tab[]> {
    const t = await this.deps.listTargets();
    return t.map(({ targetId, title, url, owner }) => ({ targetId, title, url, owner: owner ?? null }));
  }

  async handle(v: Viewer, m: BrowserClientMsg): Promise<void> {
    try {
      switch (m.t) {
        case "list": return v.send({ t: "tabs", tabs: await this.tabs() });
        case "watch": return await this.watch(v, m.targetId, m.maxWidth, m.quality);
        case "unwatch": return await this.unwatch(v);
        case "takeover": return this.setTakeover(m.on, m.on ? (process.env.NOVABOT_OWNER_NAME || "Owner") : null, m.on ? v.targetId : null);
        default: return await this.input(v, m);
      }
    } catch (e: any) {
      v.send({ t: "error", message: String(e?.message ?? e) });
    }
  }

  setTakeover(on: boolean, by: string | null, targetId: string | null) {
    this.takeover = { on, by: on ? by : null, targetId: on ? targetId : null, since: on ? this.now() : null };
    for (const x of this.allViewers) x.send({ t: "takeover", on, by: this.takeover.by });
    this.deps.onTakeover?.(this.takeover);
  }

  async watch(v: Viewer, targetId: string, maxWidth?: number, quality?: number) {
    if (v.targetId === targetId) return;
    await this.unwatch(v);
    let s = this.sessions.get(targetId);
    if (!s) {
      const tab = (await this.deps.listTargets()).find((t) => t.targetId === targetId);
      if (!tab) throw new Error("onglet introuvable");
      const mw = clampInt(maxWidth ?? 1280, 320, 1920);
      s = { tab, conn: null, viewers: new Set(), meta: null, img: null, lastFrame: null, lastAck: 0, opts: { maxWidth: mw, maxHeight: Math.round(mw * 2), quality: clampInt(quality ?? 60, 20, 90) }, reconnecting: false, stopped: false };
      this.sessions.set(targetId, s);
      s.viewers.add(v); v.targetId = targetId;
      try { await this.start(s); }
      catch (e) { this.sessions.delete(targetId); v.targetId = null; throw e; }
      return;
    }
    s.viewers.add(v); v.targetId = targetId;
    // la page ne renvoie une frame que si elle change : le nouveau spectateur reçoit la dernière tout de suite
    if (s.lastFrame && s.img) v.send({ t: "frame", data: s.lastFrame, width: s.img.width, height: s.img.height });
  }

  async unwatch(v: Viewer) {
    const tid = v.targetId; v.targetId = null;
    if (!tid) return;
    const s = this.sessions.get(tid);
    if (!s) return;
    s.viewers.delete(v);
    if (s.viewers.size === 0) await this.stop(s);
  }

  private async start(s: Session) {
    const conn = await this.deps.connect(s.tab);
    s.conn = conn;
    conn.on("Page.screencastFrame", (p) => this.onFrame(s, conn, p));
    conn.onClose(() => { if (!s.stopped) this.reconnect(s); });
    await conn.send("Page.enable");
    await conn.send("Page.startScreencast", { format: "jpeg", quality: s.opts.quality, maxWidth: s.opts.maxWidth, maxHeight: s.opts.maxHeight, everyNthFrame: 1 });
  }

  private async stop(s: Session) {
    s.stopped = true;
    this.sessions.delete(s.tab.targetId);
    const c = s.conn; s.conn = null;
    if (c && !c.closed) { try { await c.send("Page.stopScreencast"); } catch {} c.close(); }
  }

  private onFrame(s: Session, conn: CdpLike, p: { data: string; metadata: FrameMeta; sessionId: number }) {
    s.meta = p.metadata;
    const size = jpegSize(p.data) ?? s.img ?? { width: Math.round(p.metadata.deviceWidth), height: Math.round(p.metadata.deviceHeight) };
    s.img = size;
    s.lastFrame = p.data;
    for (const v of s.viewers) {
      if (v.buffered() > MAX_BUFFERED) continue; // client lent : on saute
      v.send({ t: "frame", data: p.data, width: size.width, height: size.height });
    }
    // ack différé = limitation de débit (Chrome n'envoie la frame suivante qu'après l'ack)
    const wait = Math.max(0, MIN_FRAME_MS - (this.now() - s.lastAck));
    const ack = () => { s.lastAck = this.now(); if (!conn.closed) conn.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {}); };
    wait > 0 ? setTimeout(ack, wait) : ack();
  }

  private async reconnect(s: Session) {
    if (s.reconnecting || s.stopped) return;
    s.reconnecting = true; s.conn = null;
    this.log("[browser] CDP fermé, reconnexion…", s.tab.targetId);
    for (let i = 0; i < 10 && !s.stopped && s.viewers.size; i++) {
      await Bun.sleep(i === 0 ? 500 : 2000);
      try {
        const tab = (await this.deps.listTargets()).find((t) => t.targetId === s.tab.targetId);
        if (!tab) break;
        s.tab = tab;
        await this.start(s);
        s.reconnecting = false;
        return;
      } catch { /* Chrome en cours de relance */ }
    }
    s.reconnecting = false;
    if (s.stopped) return;
    const viewers = [...s.viewers];
    await this.stop(s);
    let tabs: Tab[] = [];
    try { tabs = await this.tabs(); } catch {}
    for (const v of viewers) { v.targetId = null; v.send({ t: "error", message: "Onglet fermé ou Chrome relancé : choisis un onglet." }); v.send({ t: "tabs", tabs }); }
  }

  private async input(v: Viewer, m: BrowserClientMsg) {
    const s = v.targetId ? this.sessions.get(v.targetId) : undefined;
    if (!s?.conn) throw new Error("aucun onglet suivi");
    const c = s.conn;
    switch (m.t) {
      case "mouse": {
        if (!s.meta || !s.img) throw new Error("pas encore de frame");
        const { x, y } = imageToCss(m.x, m.y, s.img.width, s.img.height, s.meta);
        if (m.kind === "wheel") return void (await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: m.deltaY ?? 0 }));
        const type = m.kind === "down" ? "mousePressed" : m.kind === "up" ? "mouseReleased" : "mouseMoved";
        const button = m.kind === "move" ? "none" : (m.button ?? "left");
        return void (await c.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: m.kind === "move" ? 0 : (m.clickCount ?? 1) }));
      }
      case "key": return void (await c.send("Input.dispatchKeyEvent", keyEventParams(m.kind, m.key, m.code, m.text)));
      case "type": return void (await c.send("Input.insertText", { text: m.text }));
      case "navigate": {
        const url = /^[a-z][a-z0-9+.-]*:/i.test(m.url) ? m.url : "https://" + m.url;
        if (!/^https?:/i.test(url)) throw new Error("seules les URL http(s) sont autorisées");
        return void (await c.send("Page.navigate", { url }));
      }
    }
  }

  async shutdown() { for (const s of [...this.sessions.values()]) await this.stop(s); }
}

const clampInt = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Math.round(v)));
