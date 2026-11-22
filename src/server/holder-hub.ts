// The one holder connection: the handshake, the refusal of a second holder, the heartbeat,
// the port's state, and the jobs, one at a time.

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CLOSE_ANOTHER_HOLDER,
  CLOSE_NO_HELLO,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_STALE,
  PROTOCOL_VERSION,
  type HolderMessage,
  type Job,
  type JobKind,
  type JobResult,
  type PortReport,
  type ServerMessage,
} from '../shared/protocol.ts';
import type { BuildImage } from './build-dir.ts';
import { ApiError } from './errors.ts';
import type { SerialLog } from './serial-log.ts';

export interface HubOptions {
  log: SerialLog;
  /** How often the server pings the holder. Under the edge's idle timeout of 120 s. */
  pingIntervalMs?: number;
  /** A holder that has not answered a ping for this long is dropped. */
  staleMs?: number;
  helloTimeoutMs?: number;
  /** How long a job that timed out keeps the slot, waiting for the holder's late result. */
  abandonMs?: number;
  now?: () => number;
}

interface Holder {
  ws: WebSocket;
  name: string;
  userAgent?: string;
  from: string;
  since: number;
  lastPong: number;
  ping: NodeJS.Timeout;
}

/** A job's result, or the holder gone in the middle of it. */
export type HubOutcome = JobResult | { ok: false; code: 'no_holder'; message: string };

interface RunningJob {
  id: string;
  kind: JobKind;
  since: number;
  images: BuildImage[];
  finish: (r: HubOutcome) => void;
  abandoned: boolean;
}

export class HolderHub {
  private readonly log: SerialLog;
  private readonly pingIntervalMs: number;
  private readonly staleMs: number;
  private readonly helloTimeoutMs: number;
  private readonly abandonMs: number;
  private readonly now: () => number;
  private holder: Holder | null = null;
  private port: PortReport = { state: 'none' };
  private job: RunningJob | null = null;
  private readonly portWaiters = new Set<() => void>();

  constructor(opts: HubOptions) {
    this.log = opts.log;
    this.pingIntervalMs = opts.pingIntervalMs ?? 20000;
    this.staleMs = opts.staleMs ?? 60000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10000;
    this.abandonMs = opts.abandonMs ?? 60000;
    this.now = opts.now ?? Date.now;
  }

  status() {
    const h = this.holder;
    return {
      holder: h ? { connected: true, name: h.name, userAgent: h.userAgent ?? null, since: new Date(h.since).toISOString() } : { connected: false },
      port: { open: this.port.state === 'open', ...this.port },
      job: this.job ? { kind: this.job.kind, since: new Date(this.job.since).toISOString() } : null,
    };
  }

  /** The image of the running job, for the holder to fetch. */
  image(jobId: string, index: number): BuildImage | null {
    if (!this.job || this.job.id !== jobId) return null;
    return this.job.images[index] ?? null;
  }

  accept(ws: WebSocket, from: string): void {
    let pending = true;
    const helloTimer = setTimeout(() => {
      if (pending) ws.close(CLOSE_NO_HELLO, 'no hello');
    }, this.helloTimeoutMs);
    ws.on('message', (data) => {
      let msg: HolderMessage;
      try {
        msg = JSON.parse(String(data)) as HolderMessage;
      } catch {
        return;
      }
      if (pending) {
        if (msg.t !== 'hello') return;
        pending = false;
        clearTimeout(helloTimer);
        this.onHello(ws, from, msg);
        return;
      }
      if (this.holder?.ws === ws) this.onMessage(this.holder, msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.holder?.ws === ws) this.drop('holder disconnected');
    });
    ws.on('error', () => {});
  }

  /**
   * Waits for the holder's port to be open, and claims the job slot. A port that is lost
   * gets `portWaitMs` to come back: a firmware that reboots drops it for a moment.
   */
  async claim(kind: JobKind, portWaitMs: number): Promise<void> {
    if (!this.holder) throw new ApiError('no_holder', 'no holder is connected: the bench page is not open');
    if (this.job) throw new ApiError('busy', `a ${this.job.kind} job is running`);
    if (this.port.state === 'lost') await this.waitPort(portWaitMs);
    if (!this.holder) throw new ApiError('no_holder', 'no holder is connected: the bench page is not open');
    if (this.port.state !== 'open') {
      throw new ApiError('port_not_open', `the holder's port is ${this.port.state === 'none' ? 'not chosen' : this.port.state}`);
    }
    if (this.job) throw new ApiError('busy', `a ${this.job.kind} job is running`);
    this.job = { id: '', kind, since: this.now(), images: [], finish: () => {}, abandoned: false };
  }

  /**
   * Runs a job in the slot `claim` took. `makeJob` gets the job's id, which the image URLs
   * carry; `images` are what those URLs serve, by index, while the job runs.
   */
  run(makeJob: (jobId: string) => Job, timeoutMs: number, images: BuildImage[] = []): Promise<HubOutcome> {
    const slot = this.job;
    const h = this.holder;
    if (!slot || slot.id) throw new Error('run() without claim()');
    if (!h) {
      this.job = null;
      return Promise.reject(new ApiError('no_holder', 'the holder disconnected'));
    }
    slot.id = crypto.randomBytes(16).toString('hex');
    slot.images = images;
    const jobId = slot.id;
    const job = makeJob(jobId);
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        slot.abandoned = true;
        // Keep the slot until the holder answers, so the next job does not land on a busy holder
        setTimeout(() => this.free(slot), this.abandonMs);
        reject(new ApiError('timed_out', `the holder did not finish the ${job.kind} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      slot.finish = (r) => {
        this.free(slot);
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      this.send(h, { t: 'job', jobId, job });
    });
  }

  /** Gives the slot back after a claim that did not lead to a job. */
  release(): void {
    if (this.job && !this.job.id) this.job = null;
  }

  close(): void {
    if (this.holder) {
      clearInterval(this.holder.ping);
      this.holder.ws.terminate();
      this.holder = null;
    }
  }

  private free(slot: RunningJob): void {
    if (this.job === slot) this.job = null;
  }

  private onHello(ws: WebSocket, from: string, msg: Extract<HolderMessage, { t: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.refuse(ws, CLOSE_PROTOCOL_MISMATCH, `protocol ${msg.protocol} is not ${PROTOCOL_VERSION}: reload the page`);
      return;
    }
    const current = this.holder;
    if (current && this.now() - current.lastPong <= this.staleMs && current.ws.readyState === current.ws.OPEN) {
      this.refuse(ws, CLOSE_ANOTHER_HOLDER, 'another holder is connected');
      return;
    }
    if (current) {
      current.ws.close(CLOSE_STALE, 'replaced');
      this.drop('holder replaced');
    }
    const h: Holder = {
      ws,
      name: String(msg.holder ?? 'unknown'),
      userAgent: msg.userAgent,
      from,
      since: this.now(),
      lastPong: this.now(),
      ping: setInterval(() => this.heartbeat(h), this.pingIntervalMs),
    };
    this.holder = h;
    this.send(h, { t: 'welcome', protocol: PROTOCOL_VERSION });
    this.log.marker(`holder connected: ${h.name}${h.userAgent ? ` (${h.userAgent})` : ''}`);
  }

  private refuse(ws: WebSocket, code: number, reason: string): void {
    const msg: ServerMessage = { t: 'refused', reason };
    ws.send(JSON.stringify(msg));
    ws.close(code, reason);
  }

  private heartbeat(h: Holder): void {
    if (this.now() - h.lastPong > this.staleMs) {
      h.ws.close(CLOSE_STALE, 'no pong');
      h.ws.terminate();
      if (this.holder === h) this.drop('holder stopped answering');
      return;
    }
    this.send(h, { t: 'ping', ts: this.now() });
  }

  private onMessage(h: Holder, msg: HolderMessage): void {
    switch (msg.t) {
      case 'pong':
        h.lastPong = this.now();
        break;
      case 'log':
        if (typeof msg.text === 'string') this.log.write(msg.text);
        break;
      case 'port':
        this.setPort(msg.port);
        break;
      case 'result':
        if (this.job && this.job.id === msg.jobId) {
          const { t: _t, jobId: _id, ...result } = msg;
          this.job.finish(result as JobResult);
        }
        break;
      case 'progress':
      case 'hello':
        break;
    }
    // Any message shows the holder is alive
    h.lastPong = this.now();
  }

  private setPort(next: PortReport): void {
    const prev = this.port.state;
    this.port = { ...next };
    if (next.state !== prev) {
      if (next.state === 'lost') this.log.marker('port lost');
      else if (next.state === 'open') this.log.marker(prev === 'lost' ? 'port reopened' : 'port opened');
      else if (next.state === 'closed') this.log.marker('port closed');
      else this.log.marker('no port chosen');
    }
    if (next.state === 'open') for (const w of this.portWaiters) w();
  }

  private waitPort(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.portWaiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.portWaiters.add(done);
    });
  }

  private drop(why: string): void {
    const h = this.holder;
    if (!h) return;
    clearInterval(h.ping);
    this.holder = null;
    this.port = { state: 'none' };
    this.log.marker(why);
    const job = this.job;
    if (job) {
      job.finish({ ok: false, code: 'no_holder', message: 'the holder disconnected during the job; the device is in an unknown state' });
      this.job = null;
    }
    for (const w of this.portWaiters) w();
  }

  private send(h: Holder, msg: ServerMessage): void {
    if (h.ws.readyState === h.ws.OPEN) h.ws.send(JSON.stringify(msg));
  }
}
