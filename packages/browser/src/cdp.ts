// Client CDP minimal (WebSocket natif de Bun, sans dépendance).
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, fn: (params: any) => void): void;
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export class CdpConn implements CdpLike {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private handlers = new Map<string, Set<(p: any) => void>>();
  private closeFns: (() => void)[] = [];
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message ?? "CDP error")) : p.res(m.result);
      } else if (m.method) {
        for (const fn of this.handlers.get(m.method) ?? []) { try { fn(m.params); } catch (e) { console.error("[browser] handler", e); } }
      }
    };
    ws.onclose = () => this.finish();
    ws.onerror = () => this.finish();
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpConn> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("CDP connect timeout")); }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(new CdpConn(ws)); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("CDP connect error")); };
    });
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.rej(new Error("CDP closed"));
    this.pending.clear();
    for (const f of this.closeFns) { try { f(); } catch {} }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP closed"));
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP timeout ${method}`)); } }, 15000);
    });
  }
  on(event: string, fn: (p: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }
  onClose(fn: () => void) { this.closeFns.push(fn); }
  close() { try { this.ws.close(); } catch {} this.finish(); }
}
