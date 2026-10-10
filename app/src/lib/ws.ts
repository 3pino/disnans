import type { ClientEvent } from './protocol/ClientEvent';
import type { ServerEvent } from './protocol/ServerEvent';

export type SocketStatus = 'connecting' | 'open' | 'closed';

export type SocketOptions = {
  url: () => string;
  onEvent: (ev: ServerEvent) => void;
  onStatus: (s: SocketStatus, attempt: number) => void;
};

const PING_INTERVAL = 25_000;
const IDLE_TIMEOUT = 60_000;
const BACKOFF_BASE = 1_000;
const BACKOFF_MAX = 30_000;

/**
 * 自動再接続（指数バックオフ）付きの WebSocket。
 * 接続していない間の送信はキューに積み、つながったら送る。
 */
export class Socket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private queue: ClientEvent[] = [];
  private stopped = false;

  constructor(private opts: SocketOptions) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.reconnectNow());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.reconnectNow();
      });
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** まだ送り出せていないバイト数（WebSocket の bufferedAmount）。回線が細いと増える。未接続なら 0 */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  /** 送れたら true。未接続ならキューに積んで false */
  send(ev: ClientEvent): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(ev));
      return true;
    }
    this.queue.push(ev);
    return false;
  }

  /** 切断中なら待たずに再接続する */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.opts.onStatus('connecting', this.attempt);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastSeen = Date.now();
      this.opts.onStatus('open', 0);
      const q = this.queue;
      this.queue = [];
      for (const ev of q) ws.send(JSON.stringify(ev));
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > IDLE_TIMEOUT) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'ping' } satisfies ClientEvent));
      }, PING_INTERVAL);
    };
    ws.onmessage = (e) => {
      this.lastSeen = Date.now();
      if (typeof e.data !== 'string') return;
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      this.opts.onEvent(ev);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.opts.onStatus('closed', this.attempt);
      if (!this.stopped) this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose が続けて呼ばれる
    };
  }

  private scheduleRetry(): void {
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.attempt);
    const jitter = delay * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect(), jitter);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }
}
