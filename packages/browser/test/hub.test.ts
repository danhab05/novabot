import { test, expect } from "bun:test";
process.env.NOVABOT_OWNER_NAME = "Alice";
import { BrowserHub, type Viewer } from "../src/hub.ts";
import { imageToCss, jpegSize, keyEventParams } from "../src/coords.ts";
import type { CdpLike } from "../src/cdp.ts";

class FakeCdp implements CdpLike {
  sent: { method: string; params: any }[] = [];
  handlers = new Map<string, (p: any) => void>();
  closeFns: (() => void)[] = [];
  closed = false;
  async send(method: string, params: any = {}) { this.sent.push({ method, params }); return {}; }
  on(e: string, fn: (p: any) => void) { this.handlers.set(e, fn); }
  onClose(fn: () => void) { this.closeFns.push(fn); }
  close() { this.closed = true; }
  emit(e: string, p: any) { this.handlers.get(e)?.(p); }
}

// JPEG minimal : SOI + SOF0 (hauteur 400, largeur 640)
const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const JPEG = sof.toString("base64");

function viewer(buffered = 0) {
  const msgs: any[] = [];
  const v: Viewer & { msgs: any[] } = { id: crypto.randomUUID(), targetId: null, send: (m) => msgs.push(m), buffered: () => buffered, msgs };
  return v;
}

function setup() {
  const conns: FakeCdp[] = [];
  const hub = new BrowserHub({
    listTargets: async () => [{ targetId: "T1", title: "Example", url: "https://example.com" }, { targetId: "T2", title: "Autre", url: "https://autre.fr" }],
    connect: async () => { const c = new FakeCdp(); conns.push(c); return c; },
  });
  return { hub, conns };
}

test("jpegSize lit les dimensions SOF", () => {
  expect(jpegSize(JPEG)).toEqual({ width: 640, height: 400 });
});

test("conversion image -> CSS px", () => {
  const m = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0 };
  expect(imageToCss(320, 200, 640, 400, m)).toEqual({ x: 640, y: 400 });
  expect(imageToCss(640, 400, 640, 400, { ...m, pageScaleFactor: 2 })).toEqual({ x: 640, y: 400 });
  expect(imageToCss(0, 10, 640, 400, { ...m, offsetTop: 50 })).toEqual({ x: 0, y: 0 }); // borné
});

test("touches spéciales", () => {
  expect(keyEventParams("down", "Enter")).toMatchObject({ type: "keyDown", windowsVirtualKeyCode: 13, text: "\r" });
  expect(keyEventParams("down", "Backspace")).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 8 });
  expect(keyEventParams("down", "a")).toMatchObject({ type: "keyDown", text: "a", code: "KeyA" });
  expect(keyEventParams("up", "ArrowLeft")).toMatchObject({ type: "keyUp", windowsVirtualKeyCode: 37 });
});

test("une seule session de screencast partagée par onglet, arrêtée sans spectateur", async () => {
  const { hub, conns } = setup();
  const a = viewer(), b = viewer();
  hub.addViewer(a); hub.addViewer(b);
  await hub.handle(a, { t: "watch", targetId: "T1", maxWidth: 800 });
  await hub.handle(b, { t: "watch", targetId: "T1" });
  expect(conns.length).toBe(1);
  expect(conns[0].sent.filter((s) => s.method === "Page.startScreencast").length).toBe(1);
  expect(conns[0].sent.find((s) => s.method === "Page.startScreencast")!.params.maxWidth).toBe(800);
  conns[0].emit("Page.screencastFrame", { data: JPEG, sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0 } });
  expect(a.msgs.filter((m) => m.t === "frame").length).toBe(1);
  expect(b.msgs.filter((m) => m.t === "frame")[0]).toMatchObject({ width: 640, height: 400 });
  const c = viewer(); hub.addViewer(c);
  await hub.handle(c, { t: "watch", targetId: "T1" });
  expect(c.msgs.filter((m) => m.t === "frame").length).toBe(1); // dernière frame envoyée à l'arrivée
  await hub.removeViewer(c);
  await hub.handle(a, { t: "unwatch" });
  expect(hub.sessionCount()).toBe(1);
  await hub.removeViewer(b);
  expect(hub.sessionCount()).toBe(0);
  expect(conns[0].sent.some((s) => s.method === "Page.stopScreencast")).toBe(true);
  expect(conns[0].closed).toBe(true);
});

test("backpressure : client lent ignoré, ack quand même envoyé", async () => {
  const { hub, conns } = setup();
  const slow = viewer(5 * 1024 * 1024);
  hub.addViewer(slow);
  await hub.handle(slow, { t: "watch", targetId: "T1" });
  conns[0].emit("Page.screencastFrame", { data: JPEG, sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
  expect(slow.msgs.filter((m) => m.t === "frame").length).toBe(0);
  await Bun.sleep(120);
  expect(conns[0].sent.some((s) => s.method === "Page.screencastFrameAck" && s.params.sessionId === 7)).toBe(true);
});

test("clic converti en coordonnées CSS", async () => {
  const { hub, conns } = setup();
  const v = viewer(); hub.addViewer(v);
  await hub.handle(v, { t: "watch", targetId: "T1" });
  conns[0].emit("Page.screencastFrame", { data: JPEG, sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0 } });
  await hub.handle(v, { t: "mouse", kind: "down", x: 100, y: 50, button: "left", clickCount: 1 });
  const ev = conns[0].sent.find((s) => s.method === "Input.dispatchMouseEvent")!;
  expect(ev.params).toMatchObject({ type: "mousePressed", x: 200, y: 100, button: "left" });
  await hub.handle(v, { t: "navigate", url: "javascript:alert(1)" });
  expect(v.msgs.at(-1)).toMatchObject({ t: "error" });
});

test("takeover diffusé à tous les spectateurs", async () => {
  const { hub } = setup();
  const a = viewer(), b = viewer();
  hub.addViewer(a); hub.addViewer(b);
  await hub.handle(a, { t: "watch", targetId: "T2" });
  await hub.handle(a, { t: "takeover", on: true });
  expect(hub.takeover).toMatchObject({ on: true, by: "Alice", targetId: "T2" });
  expect(b.msgs.at(-1)).toEqual({ t: "takeover", on: true, by: "Alice" });
});
