// The one holder connection: the handshake, the refusal of a second holder, the heartbeat,
// the port's state, and the jobs, one at a time.
//
// Everything a holder sends is checked before it is used: the page port is open to the LAN,
// and a frame that throws in an event handler would take the whole bench down.

import crypto from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import {
  CLOSE_ANOTHER_HOLDER,
  CLOSE_NO_HELLO,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_STALE,
  PROTOCOL_VERSION,
  type HolderErrorCode,
  type HolderMessage,
  type Job,
  type JobKind,
  type JobPhase,
  type JobResult,
  type PortReport,
  type PortState,
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
  /** The page's entry script as the build names it now, for the welcome. Called at each hello. */
  pageEntry?: () => string | undefined;
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

interface Progress {
  phase: JobPhase;
  image?: number;
  written?: number;
  total?: number;
}

interface RunningJob {
  id: string;
  kind: JobKind;
  since: number;
  images: BuildImage[];
  finish: (r: HubOutcome) => void;
  abandoned: boolean;
  abandonTimer: NodeJS.Timeout | null;
  progress: Progress | null;
}

const PORT_STATES: ReadonlySet<string> = new Set<PortState>(['none', 'open', 'lost', 'closed']);
const HOLDER_ERRORS: ReadonlySet<string> = new Set<HolderErrorCode>([
  'port_not_open',
  'wrong_chip',
  'flash_failed',
  'reset_failed',
  'console_failed',
  'busy',
]);
const FAILED: Record<JobKind, HolderErrorCode> = { flash: 'flash_failed', reset: 'reset_failed', console: 'console_failed' };
const PHASES: ReadonlySet<string> = new Set<JobPhase>(['connecting', 'writing', 'resetting', 'reopening']);

export class HolderHub {
  private readonly log: SerialLog;
  private readonly pingIntervalMs: number;
  private readonly staleMs: number;
  private readonly helloTimeoutMs: number;
  private readonly abandonMs: number;
  private readonly pageEntry: () => string | undefined;
  private readonly now: () => number;
  private holder: Holder | null = null;
  private port: PortReport = { state: 'none' };
  private job: RunningJob | null = null;
  private readonly portWaiters = new Set<() => void>();
  private closed = false;

  constructor(opts: HubOptions) {
    this.log = opts.log;
    this.pingIntervalMs = opts.pingIntervalMs ?? 20000;
    this.staleMs = opts.staleMs ?? 60000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10000;
    this.abandonMs = opts.abandonMs ?? 60000;
    this.pageEntry = opts.pageEntry ?? (() => undefined);
    this.now = opts.now ?? Date.now;
  }

  status() {
    const h = this.holder;
    const j = this.job;
    return {
      holder: h
        ? { connected: true, name: h.name, userAgent: h.userAgent ?? null, from: h.from, since: new Date(h.since).toISOString() }
        : { connected: false },
      port: { open: this.port.state === 'open', ...this.port },
      job: j
        ? { kind: j.kind, since: new Date(j.since).toISOString(), timedOut: j.abandoned, progress: j.progress }
        : null,
    };
  }

  /** The image of the running job, for the holder to fetch. */
  image(jobId: string, index: number): BuildImage | null {
    if (!this.job || !this.job.id || this.job.id !== jobId) return null;
    return this.job.images[index] ?? null;
  }

  accept(ws: WebSocket, from: string): void {
    if (this.closed) {
      ws.terminate();
      return;
    }
    let pending = true;
    const helloTimer = setTimeout(() => {
      if (pending) ws.close(CLOSE_NO_HELLO, 'no hello');
    }, this.helloTimeoutMs);
    ws.on('message', (data, isBinary) => {
      const msg = isBinary ? null : parseMessage(data);
      if (!msg) return;
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
    this.checkFree();
    if (this.port.state === 'lost') await this.waitPort(portWaitMs);
    this.checkFree();
    if (this.port.state !== 'open') {
      throw new ApiError('port_not_open', `the holder's port is ${this.port.state === 'none' ? 'not chosen' : this.port.state}`);
    }
    this.job = { id: '', kind, since: this.now(), images: [], finish: () => {}, abandoned: false, abandonTimer: null, progress: null };
  }

  /**
   * Runs a job in the slot `claim` took. `makeJob` gets the job's id, which the image URLs
   * carry; `images` are what those URLs serve, by index, while the job runs.
   */
  run(makeJob: (jobId: string) => Job, timeoutMs: number, images: BuildImage[] = []): Promise<HubOutcome> {
    const h = this.holder;
    if (!h) {
      this.release();
      return Promise.reject(new ApiError('no_holder', 'the holder disconnected'));
    }
    const slot = this.job;
    if (!slot || slot.id) throw new Error('run() without claim()');
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
        slot.abandonTimer = setTimeout(() => {
          if (this.job !== slot) return;
          this.job = null;
          this.log.marker(`${job.kind} abandoned: the holder never answered`);
        }, this.abandonMs);
        reject(new ApiError('timed_out', `the holder did not finish the ${job.kind} within ${Math.round(timeoutMs / 100) / 10} s`));
      }, timeoutMs);
      slot.finish = (r) => {
        this.free(slot);
        if (done) {
          this.log.marker(`${job.kind} answered after its time-out: ${r.ok ? 'ok' : `${r.code}: ${r.message}`}`);
          return;
        }
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

  /** Drops the holder and ends a running job; the hub takes no holder after this. */
  close(): void {
    this.closed = true;
    const h = this.holder;
    if (h) {
      clearInterval(h.ping);
      this.holder = null;
      h.ws.terminate();
    }
    const job = this.job;
    if (job) job.finish({ ok: false, code: 'no_holder', message: 'the bench is stopping' });
    this.job = null;
    for (const w of this.portWaiters) w();
  }

  private checkFree(): void {
    if (this.closed || !this.holder) throw new ApiError('no_holder', 'no holder is connected: the bench page is not open');
    const job = this.job;
    if (job) throw new ApiError('busy', `a ${job.kind} job is running${job.abandoned ? ' (it timed out, and the holder has not answered yet)' : ''}`);
  }

  private free(slot: RunningJob): void {
    if (slot.abandonTimer) clearTimeout(slot.abandonTimer);
    slot.abandonTimer = null;
    if (this.job === slot) this.job = null;
  }

  private onHello(ws: WebSocket, from: string, msg: Extract<HolderMessage, { t: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.refuse(ws, CLOSE_PROTOCOL_MISMATCH, `protocol ${String(msg.protocol)} is not ${PROTOCOL_VERSION}: reload the page`);
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
      name: msg.holder,
      userAgent: msg.userAgent,
      from,
      since: this.now(),
      lastPong: this.now(),
      ping: setInterval(() => this.heartbeat(h), this.pingIntervalMs),
    };
    this.holder = h;
    const page = this.pageEntry();
    this.send(h, { t: 'welcome', protocol: PROTOCOL_VERSION, ...(page ? { page } : {}) });
    this.log.marker(`holder connected: ${h.name} from ${from}${h.userAgent ? ` (${h.userAgent})` : ''}`);
  }

  private refuse(ws: WebSocket, code: number, reason: string): void {
    const msg: ServerMessage = { t: 'refused', reason };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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
    // Any message shows the holder is alive
    h.lastPong = this.now();
    switch (msg.t) {
      case 'log':
        this.log.write(msg.text);
        break;
      case 'port':
        this.setPort(msg.port);
        break;
      case 'progress':
        if (this.job && this.job.id === msg.jobId) {
          const { t: _t, jobId: _id, ...progress } = msg;
          this.job.progress = progress;
        }
        break;
      case 'result':
        if (this.job && this.job.id === msg.jobId) this.onResult(this.job, msg);
        break;
      case 'pong':
      case 'hello':
        break;
    }
  }

  private onResult(job: RunningJob, msg: Extract<HolderMessage, { t: 'result' }>): void {
    if (msg.ok) {
      // What the holder learnt about the chip holds for the port until it says otherwise
      if (msg.chip) this.port.chip = msg.chip;
      if (msg.mac) this.port.mac = msg.mac;
      job.finish({ ok: true, ...(msg.chip ? { chip: msg.chip } : {}), ...(msg.mac ? { mac: msg.mac } : {}) });
      return;
    }
    const code: HolderErrorCode = HOLDER_ERRORS.has(msg.code) ? msg.code : FAILED[job.kind];
    job.finish({ ok: false, code, message: msg.message || `the holder reported ${msg.code}`, ...(msg.chip ? { chip: msg.chip } : {}) });
  }

  private setPort(next: PortReport): void {
    const prev = this.port.state;
    this.port = next;
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

/** A holder's frame, checked and trimmed to what the protocol says, or null. */
export function parseMessage(data: RawData): HolderMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat(toBuffers(data)).toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v.t) {
    case 'hello':
      return {
        t: 'hello',
        // A hello without a number is a protocol mismatch, which the hub answers as such
        protocol: typeof v.protocol === 'number' ? v.protocol : NaN,
        holder: typeof v.holder === 'string' && v.holder ? v.holder.slice(0, 200) : 'unknown',
        ...(typeof v.userAgent === 'string' && v.userAgent ? { userAgent: v.userAgent.slice(0, 300) } : {}),
      };
    case 'port': {
      const p = v.port;
      if (!isRecord(p) || typeof p.state !== 'string' || !PORT_STATES.has(p.state)) return null;
      const port: PortReport = { state: p.state as PortState };
      if (typeof p.usbVendorId === 'number') port.usbVendorId = p.usbVendorId;
      if (typeof p.usbProductId === 'number') port.usbProductId = p.usbProductId;
      if (typeof p.chip === 'string' && p.chip) port.chip = p.chip;
      if (typeof p.mac === 'string' && p.mac) port.mac = p.mac;
      return { t: 'port', port };
    }
    case 'log':
      return typeof v.text === 'string' ? { t: 'log', text: v.text } : null;
    case 'progress': {
      if (typeof v.jobId !== 'string' || typeof v.phase !== 'string' || !PHASES.has(v.phase)) return null;
      return {
        t: 'progress',
        jobId: v.jobId,
        phase: v.phase as JobPhase,
        ...(typeof v.image === 'number' ? { image: v.image } : {}),
        ...(typeof v.written === 'number' ? { written: v.written } : {}),
        ...(typeof v.total === 'number' ? { total: v.total } : {}),
      };
    }
    case 'result': {
      if (typeof v.jobId !== 'string' || typeof v.ok !== 'boolean') return null;
      const chip = typeof v.chip === 'string' && v.chip ? { chip: v.chip } : {};
      if (v.ok) return { t: 'result', jobId: v.jobId, ok: true, ...chip, ...(typeof v.mac === 'string' && v.mac ? { mac: v.mac } : {}) };
      return {
        t: 'result',
        jobId: v.jobId,
        ok: false,
        // An unknown code is mapped onto the job's own failure by the hub
        code: (typeof v.code === 'string' ? v.code : '') as HolderErrorCode,
        message: typeof v.message === 'string' ? v.message : '',
        ...chip,
      };
    }
    case 'pong':
      return { t: 'pong', ts: typeof v.ts === 'number' ? v.ts : 0 };
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toBuffers(data: RawData): Buffer[] {
  if (Array.isArray(data)) return data;
  return [Buffer.from(data as ArrayBuffer)];
}
