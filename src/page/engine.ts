// The holder: the port keeper, the server link and the jobs, wired together. It runs in the
// dedicated worker, or on the page when the worker has no Web Serial. Everything it touches
// outside itself comes in through EngineDeps, so the tests can run it without a browser.

import {
  PROTOCOL_VERSION,
  idfTarget,
  type FlashImage,
  type HolderErrorCode,
  type Job,
  type JobKind,
  type JobPhase,
  type JobResult,
} from '../shared/protocol.ts';
import type { ConnectEsptool, ConnectMode, EspSession, FlashFile, Terminal } from './esptool.ts';
import { md5hex } from './md5.ts';
import type { EngineMessage, EngineStatus, JobView, LastJob, PageMessage } from './messages.ts';
import { PortKeeper } from './port-keeper.ts';
import { errorMessage, portRts, pulseRts, sleep, type Clock, type SerialLike } from './serial.ts';
import { ServerLink, holderUrl, type OpenSocket } from './server-link.ts';

export interface EngineDeps {
  serial: SerialLike;
  openSocket: OpenSocket;
  connectEsptool: ConnectEsptool;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  clock: Clock;
  /** The page's origin, which the WebSocket and the image URLs are on. */
  location: { protocol: string; host: string };
  /** Where the engine runs: `worker`, or `page` and why. */
  context: string;
  userAgent?: string;
  toPage(msg: EngineMessage): void;
}

/** A job that arrives while the port is lost waits this long for it. */
export const JOB_PORT_WAIT_MS = 10_000;
/** How long the port gets to come back when the reset into download mode dropped it. */
export const CONNECT_RETURN_MS = 20_000;
/** How long the port gets to come back when the reset into the firmware dropped it. */
export const RESET_RETURN_MS = 30_000;
/** After a reset, how long the engine watches for the port dropping before it reports. */
export const AFTER_RESET_MS = 300;
const SETTLE_MS = 300;
/** Device output kept while the server is away, to send when it is back. */
const BACKLOG_CHARS = 64 * 1024;

/** `main('default_reset')` again without the reset, when its reset dropped the port. */
const CONNECT_LADDER: ConnectMode[] = ['default_reset', 'no_reset', 'default_reset'];

const FAILURE: Record<JobKind, HolderErrorCode> = {
  flash: 'flash_failed',
  reset: 'reset_failed',
  console: 'console_failed',
};

class JobError extends Error {
  readonly code: HolderErrorCode;
  readonly chip?: string;

  constructor(code: HolderErrorCode, message: string, chip?: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.chip = chip;
  }
}

export class Engine {
  private readonly deps: EngineDeps;
  private readonly keeper: PortKeeper;
  private readonly link: ServerLink;
  private readonly decoder = new TextDecoder();
  private backlog = '';
  private job: JobView | null = null;
  private lastJob: LastJob | undefined;
  private serverPage: string | undefined;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.keeper = new PortKeeper(deps.serial, deps.clock, {
      changed: () => {
        this.link.send({ t: 'port', port: this.keeper.report() });
        this.publish();
      },
      bytes: (data) => this.deviceBytes(data),
      note: (text) => this.note(text),
    });
    const hello = { t: 'hello', protocol: PROTOCOL_VERSION, holder: `bench page (${deps.context})`, userAgent: deps.userAgent } as const;
    this.link = new ServerLink(holderUrl(deps.location), hello, deps.openSocket, deps.clock, {
      welcomed: (page) => this.welcomed(page),
      job: (jobId, job) => void this.runJob(jobId, job),
      changed: () => this.publish(),
    });
  }

  async start(): Promise<void> {
    this.publish();
    this.link.start();
    await this.keeper.start();
  }

  async stop(): Promise<void> {
    this.link.stop();
    await this.keeper.stop();
  }

  async fromPage(msg: PageMessage): Promise<void> {
    if (msg.t === 'granted') await this.keeper.choose(msg.info);
  }

  status(): EngineStatus {
    return {
      context: this.deps.context,
      server: this.link.state,
      serverDetail: this.link.detail,
      port: this.keeper.report(),
      job: this.job,
      lastJob: this.lastJob,
      ...(this.serverPage ? { serverPage: this.serverPage } : {}),
    };
  }

  /** Runs one job and sends its result. The server sends one at a time; another one is busy. */
  async runJob(jobId: string, job: Job): Promise<void> {
    if (this.job) {
      this.link.send({ t: 'result', jobId, ok: false, code: 'busy', message: `a ${this.job.kind} job is running` });
      return;
    }
    this.job = { id: jobId, kind: job.kind };
    this.keeper.beginJob();
    this.publish();
    let result: JobResult;
    try {
      try {
        await this.keeper.ensureOpen(JOB_PORT_WAIT_MS);
      } catch (e) {
        throw new JobError('port_not_open', errorMessage(e));
      }
      switch (job.kind) {
        case 'flash':
          result = await this.flash(job);
          break;
        case 'reset':
          result = await this.reset();
          break;
        case 'console':
          result = await this.console(job.line);
          break;
      }
    } catch (e) {
      result =
        e instanceof JobError
          ? { ok: false, code: e.code, message: e.message, ...(e.chip ? { chip: e.chip } : {}) }
          : { ok: false, code: FAILURE[job.kind], message: errorMessage(e) };
    }
    await this.keeper.endJob();
    this.job = null;
    this.lastJob = { kind: job.kind, ok: result.ok, message: result.ok ? undefined : result.message, at: this.deps.clock.now() };
    this.note(result.ok ? `${job.kind} done` : `${job.kind} failed (${result.code}): ${result.message}`);
    this.link.send({ t: 'result', jobId, ...result });
    this.publish();
  }

  private async flash(job: Extract<Job, { kind: 'flash' }>): Promise<JobResult> {
    // Every image is fetched and checked before the port is touched
    const files = await this.fetchImages(job.images);
    this.progress('connecting');
    await this.keeper.stopMonitor();
    const session = await this.connect();
    this.keeper.setChip(session.chip, session.mac);
    let result: JobResult = { ok: true, chip: session.chip, mac: session.mac };
    try {
      if (idfTarget(session.chip) !== job.chip) {
        const message = `the build is for ${job.chip}, and the chip is ${session.chip}: nothing was written`;
        result = { ok: false, code: 'wrong_chip', message, chip: session.chip };
      } else {
        const names = job.images.map((im) => im.name);
        const count = job.images.length;
        this.progress('writing', { image: 0, imageName: names[0], imageCount: count });
        await session.writeFlash(files, job.flash, (image, written, total) =>
          this.progress('writing', { image, imageName: names[image], imageCount: count, written, total }),
        );
      }
    } catch (e) {
      result = { ok: false, code: 'flash_failed', message: errorMessage(e), chip: session.chip };
    }
    // Whatever happened, back into the firmware, with the port handed to the monitor
    try {
      await this.resetIntoFirmware(session);
    } catch (e) {
      await session.disconnect().catch(() => undefined);
      if (result.ok) result = { ok: false, code: 'reset_failed', message: errorMessage(e), chip: session.chip };
      else this.note(`the reset after that failed too: ${errorMessage(e)}`);
    }
    return result;
  }

  private async fetchImages(images: FlashImage[]): Promise<FlashFile[]> {
    const files: FlashFile[] = [];
    for (const image of images) {
      let data: Uint8Array;
      try {
        const res = await this.deps.fetch(image.url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        throw new JobError('flash_failed', `could not fetch ${image.name}: ${errorMessage(e)}; nothing was written`);
      }
      if (data.length !== image.size) {
        throw new JobError('flash_failed', `${image.name} came as ${data.length} bytes, not ${image.size}; nothing was written`);
      }
      const md5 = md5hex(data);
      if (md5 !== image.md5.toLowerCase()) {
        throw new JobError('flash_failed', `${image.name} has MD5 ${md5}, not ${image.md5}; nothing was written`);
      }
      files.push({ address: image.offset, data });
    }
    return files;
  }

  /** Connects esptool-js. When its reset into download mode drops the port, waits for it and goes on without a reset. */
  private async connect(): Promise<EspSession> {
    const terminal = this.terminal();
    for (let i = 0; ; i++) {
      const mode = CONNECT_LADDER[i] ?? 'default_reset';
      const port = this.keeper.port;
      if (!port) throw new JobError('port_not_open', 'no port has been chosen');
      const mark = this.keeper.mark();
      try {
        return await this.deps.connectEsptool(port, mode, terminal);
      } catch (e) {
        const dropped = this.keeper.lostSince(mark);
        this.note(`esptool ${mode} failed${dropped ? ', and the port dropped' : ''}: ${errorMessage(e)}`);
        if (!dropped || i >= CONNECT_LADDER.length - 1) {
          throw new JobError('flash_failed', `could not connect to the chip: ${errorMessage(e)}`);
        }
        const back = await this.keeper.waitBack(CONNECT_RETURN_MS);
        if (!back) throw new JobError('flash_failed', 'the port did not come back after the reset into download mode');
        this.keeper.use(back);
        await sleep(this.deps.clock, SETTLE_MS);
      }
    }
  }

  /**
   * Resets into the firmware while esptool-js still reads the port, then hands the port to
   * the monitor without closing it. The start of the first boot is in esptool-js's buffer
   * and goes to the log first; the rest is still in the port's stream, where the monitor
   * reads on. Closing and reopening instead would drop what the OS has buffered.
   */
  private async resetIntoFirmware(session: EspSession): Promise<void> {
    this.progress('resetting');
    await session.hardReset(this.deps.clock);
    this.progress('reopening');
    const early = await session.release();
    if (early.length) this.deviceBytes(early);
    const port = this.keeper.port;
    if (port?.readable) this.keeper.startMonitor(port);
    await this.afterReset();
  }

  private async reset(): Promise<JobResult> {
    const port = this.keeper.port;
    if (!port) throw new JobError('port_not_open', 'no port has been chosen');
    this.progress('resetting');
    // The monitor reads on through the reset, so the whole boot reaches the log
    try {
      await pulseRts(portRts(port), this.deps.clock);
    } catch (e) {
      throw new JobError('reset_failed', `could not pulse RTS: ${errorMessage(e)}`);
    }
    this.progress('reopening');
    await this.afterReset();
    const { chip, mac } = this.keeper.report();
    return { ok: true, ...(chip ? { chip } : {}), ...(mac ? { mac } : {}) };
  }

  /** On this board a reset keeps the port. Where it drops it, waits for it and reopens. */
  private async afterReset(): Promise<void> {
    await sleep(this.deps.clock, AFTER_RESET_MS);
    if (this.keeper.state !== 'lost') return;
    const back = await this.keeper.waitBack(RESET_RETURN_MS);
    if (!back) throw new JobError('reset_failed', `the port did not come back within ${RESET_RETURN_MS / 1000} s of the reset`);
    this.keeper.use(back);
    await sleep(this.deps.clock, SETTLE_MS);
    try {
      await this.keeper.openMonitor('after the reset');
    } catch (e) {
      throw new JobError('reset_failed', `the port came back but did not open: ${errorMessage(e)}`);
    }
  }

  private async console(line: string): Promise<JobResult> {
    try {
      await this.keeper.write(new TextEncoder().encode(`${line}\r\n`));
    } catch (e) {
      throw new JobError('console_failed', errorMessage(e));
    }
    return { ok: true };
  }

  private progress(phase: JobPhase, extra: Omit<JobView, 'id' | 'kind' | 'phase'> = {}): void {
    const job = this.job;
    if (!job) return;
    this.job = { id: job.id, kind: job.kind, phase, ...extra };
    this.link.send({ t: 'progress', jobId: job.id, phase, image: extra.image, written: extra.written, total: extra.total });
    this.publish();
  }

  /** esptool-js's own lines go to the page; the progress bar stands for its "Writing at". */
  private terminal(): Terminal {
    let partial = '';
    return {
      clean: () => undefined,
      write: (s) => {
        partial += s;
      },
      writeLine: (s) => {
        const line = (partial + s).trim();
        partial = '';
        if (line && !line.startsWith('Writing at')) this.note(`esptool: ${line}`);
      },
    };
  }

  private welcomed(page: string | undefined): void {
    if (page !== this.serverPage) {
      this.serverPage = page;
      this.publish();
    }
    this.link.send({ t: 'port', port: this.keeper.report() });
    if (this.backlog) {
      this.link.send({ t: 'log', text: this.backlog });
      this.backlog = '';
    }
    // A port that would not open, perhaps because another tab had it, gets another try
    if (!this.job && (this.keeper.state === 'closed' || this.keeper.state === 'none')) {
      void this.keeper.openMonitor('welcome').catch(() => undefined);
    }
  }

  private deviceBytes(data: Uint8Array): void {
    const text = this.decoder.decode(data, { stream: true });
    if (!text) return;
    this.deps.toPage({ t: 'log', text });
    if (!this.link.send({ t: 'log', text })) this.backlog = (this.backlog + text).slice(-BACKLOG_CHARS);
  }

  private note(text: string): void {
    this.deps.toPage({ t: 'note', text });
  }

  private publish(): void {
    this.deps.toPage({ t: 'status', status: this.status() });
  }
}
