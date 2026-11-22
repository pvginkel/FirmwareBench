// The WebSocket to the bench server, as the holder: hello and welcome, ping and pong, and
// reconnecting by itself with back-off. The edge cuts a socket that is idle for 120 s; the
// server pings every 20 s (design §9).

import {
  CLOSE_ANOTHER_HOLDER,
  CLOSE_PROTOCOL_MISMATCH,
  HOLDER_PATH,
  type HolderMessage,
  type Job,
  type ServerMessage,
} from '../shared/protocol.ts';
import type { ServerState } from './messages.ts';
import type { Clock } from './serial.ts';

export interface SocketHandlers {
  open(): void;
  message(data: string): void;
  close(code: number, reason: string): void;
}

export interface SocketHandle {
  send(data: string): void;
  close(): void;
}

export type OpenSocket = (url: string, handlers: SocketHandlers) => SocketHandle;

export const browserSocket: OpenSocket = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.open();
  ws.onmessage = (e) => handlers.message(String(e.data));
  ws.onclose = (e) => handlers.close(e.code, e.reason);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
};

/** The holder's WebSocket URL on the page's own origin: `wss` when the page is https. */
export function holderUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${HOLDER_PATH}`;
}

export interface LinkEvents {
  /** The server took this page as the holder. `page` is the entry script the server's build names. */
  welcomed(page: string | undefined): void;
  job(jobId: string, job: Job): void;
  changed(): void;
}

export const FIRST_RETRY_MS = 1000;
export const MAX_RETRY_MS = 30_000;
/** Another holder is connected. It may go away, so try again, but rarely. */
export const REFUSED_RETRY_MS = 60_000;
/** This long without a word from the server, or without a welcome, the socket is given up. */
export const SILENT_MS = 60_000;
const CHECK_MS = 5000;

export class ServerLink {
  private readonly url: string;
  private readonly hello: Extract<HolderMessage, { t: 'hello' }>;
  private readonly openSocket: OpenSocket;
  private readonly clock: Clock;
  private readonly events: LinkEvents;
  private stateValue: ServerState = 'offline';
  private detailValue: string | undefined;
  private socket: SocketHandle | null = null;
  /** Which socket is current. A handler of an older one does nothing. */
  private generation = 0;
  private since = 0;
  private lastHeard = 0;
  private retryMs = FIRST_RETRY_MS;
  private refusal: string | undefined;
  private stopped = false;
  private cancelRetry = (): void => undefined;
  private cancelCheck = (): void => undefined;

  constructor(url: string, hello: Extract<HolderMessage, { t: 'hello' }>, openSocket: OpenSocket, clock: Clock, events: LinkEvents) {
    this.url = url;
    this.hello = hello;
    this.openSocket = openSocket;
    this.clock = clock;
    this.events = events;
  }

  get state(): ServerState {
    return this.stateValue;
  }

  get detail(): string | undefined {
    return this.detailValue;
  }

  start(): void {
    this.connect();
    this.check();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry();
    this.cancelCheck();
    this.generation++;
    this.socket?.close();
    this.socket = null;
  }

  /** Sends a message while this page is the holder. False when it is not. */
  send(msg: HolderMessage): boolean {
    if (this.stateValue !== 'holder' || !this.socket) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    this.cancelRetry();
    this.refusal = undefined;
    this.setState('connecting', undefined);
    const generation = ++this.generation;
    const mine = () => generation === this.generation && !this.stopped;
    this.socket = this.openSocket(this.url, {
      open: () => {
        if (!mine()) return;
        this.lastHeard = this.clock.now();
        this.socket?.send(JSON.stringify(this.hello));
      },
      message: (data) => {
        if (mine()) this.onMessage(data);
      },
      close: (code, reason) => {
        if (mine()) this.onClose(code, reason);
      },
    });
  }

  private onMessage(data: string): void {
    this.lastHeard = this.clock.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.retryMs = FIRST_RETRY_MS;
        this.setState('holder', undefined);
        this.events.welcomed(msg.page);
        break;
      case 'ping':
        this.socket?.send(JSON.stringify({ t: 'pong', ts: msg.ts } satisfies HolderMessage));
        break;
      case 'refused':
        this.refusal = msg.reason;
        break;
      case 'job':
        if (this.stateValue === 'holder') this.events.job(msg.jobId, msg.job);
        break;
    }
  }

  private onClose(code: number, reason: string): void {
    this.socket = null;
    const why = this.refusal || reason;
    if (code === CLOSE_PROTOCOL_MISMATCH) {
      // Retrying cannot help: this page is out of date
      this.setState('stopped', `${why || 'the server speaks another protocol version'}. Reload the page.`);
      return;
    }
    if (code === CLOSE_ANOTHER_HOLDER || this.refusal) {
      this.retry(REFUSED_RETRY_MS, 'refused', why || 'another holder is connected');
      return;
    }
    this.retry(this.retryMs, 'offline', why ? `closed: ${why}` : `closed (${code})`);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  /** Gives up a socket that has gone quiet, without waiting for its close. */
  private abandon(why: string): void {
    const socket = this.socket;
    this.generation++;
    this.socket = null;
    socket?.close();
    this.retry(this.retryMs, 'offline', why);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private retry(ms: number, state: ServerState, why: string): void {
    this.setState(state, `${why}; trying again in ${Math.round(ms / 1000)} s`);
    this.cancelRetry = this.clock.after(ms, () => this.connect());
  }

  private check(): void {
    this.cancelCheck = this.clock.after(CHECK_MS, () => {
      const now = this.clock.now();
      if (this.stateValue === 'holder' && now - this.lastHeard > SILENT_MS) {
        this.abandon(`no word from the server for ${Math.round((now - this.lastHeard) / 1000)} s`);
      } else if (this.stateValue === 'connecting' && now - this.since > SILENT_MS) {
        this.abandon('no welcome from the server');
      }
      if (!this.stopped) this.check();
    });
  }

  private setState(state: ServerState, detail: string | undefined): void {
    if (state !== this.stateValue) this.since = this.clock.now();
    this.stateValue = state;
    this.detailValue = detail;
    this.events.changed();
  }
}
