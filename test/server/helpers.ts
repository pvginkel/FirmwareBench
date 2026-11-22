// The bench started in-process on ephemeral ports, with a temp work root and log dir, and a
// scripted holder: a WebSocket client that speaks the holder's side of the protocol.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, type ClientOptions } from 'ws';
import { startBench, type Bench, type BenchOptions } from '../../src/server/app.ts';
import {
  HOLDER_PATH,
  PROTOCOL_VERSION,
  type HolderMessage,
  type Job,
  type JobResult,
  type PortReport,
  type ServerMessage,
} from '../../src/shared/protocol.ts';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** A real one, from the spike's `hello_world` build for the S3-Tiny. */
export const FLASHER_ARGS = path.join(FIXTURES, 'flasher_args.json');

export interface FlasherArgs {
  flash_files: Record<string, string>;
  flash_settings: { flash_mode: string; flash_size: string; flash_freq: string };
  extra_esptool_args: { chip: string };
}

export function readFlasherArgs(): FlasherArgs {
  return JSON.parse(fs.readFileSync(FLASHER_ARGS, 'utf8')) as FlasherArgs;
}

export function md5(data: Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

export interface TestBench extends Bench {
  root: string;
  workRoot: string;
  logDir: string;
  pageDir: string;
  api(method: string, urlPath: string, body?: unknown, init?: { contentType?: string | null; raw?: string }): Promise<ApiAnswer>;
  pageUrl(urlPath: string): string;
  holderUrl(): string;
}

export interface ApiAnswer {
  status: number;
  contentType: string | null;
  // The tests read whatever the call answered
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export const INDEX_HTML = '<!doctype html><title>bench</title><script type="module" src="/assets/index-AbC123de.js"></script>\n';
export const ASSET_JS = 'console.log("bench");\n';

/** Short timings, so that a test that waits on one takes a fraction of a second. */
export async function startTestBench(over: Partial<BenchOptions> = {}): Promise<TestBench> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  const workRoot = path.join(root, 'work');
  const logDir = path.join(root, 'log');
  const pageDir = path.join(root, 'page');
  fs.mkdirSync(workRoot);
  fs.mkdirSync(path.join(pageDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(pageDir, 'assets', 'index-AbC123de.js'), ASSET_JS);
  fs.writeFileSync(path.join(pageDir, 'robots.txt'), 'User-agent: *\n');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'the secret\n');

  const { hub, api, log, ...rest } = over;
  const bench = await startBench({
    pagePort: 0,
    pageHost: '127.0.0.1',
    apiPort: 0,
    pageDir,
    workRoot,
    logDir,
    log,
    hub: { pingIntervalMs: 1000, staleMs: 5000, helloTimeoutMs: 1000, abandonMs: 2000, ...hub },
    api: { flashTimeoutMs: 2000, resetTimeoutMs: 1000, consoleTimeoutMs: 1000, portWaitMs: 300, ...api },
    ...rest,
  });
  const close = bench.close;
  return {
    ...bench,
    root,
    workRoot,
    logDir,
    pageDir,
    async close() {
      await close();
      fs.rmSync(root, { recursive: true, force: true });
    },
    async api(method, urlPath, body, init = {}) {
      const headers: Record<string, string> = {};
      const contentType = init.contentType === undefined ? 'application/json' : init.contentType;
      if (contentType) headers['content-type'] = contentType;
      const payload = init.raw ?? (body === undefined ? undefined : JSON.stringify(body));
      const res = await fetch(`http://127.0.0.1:${bench.apiPort}${urlPath}`, {
        method,
        headers,
        body: payload,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // left as text
      }
      return { status: res.status, contentType: res.headers.get('content-type'), body: parsed };
    },
    pageUrl(urlPath) {
      return `http://127.0.0.1:${bench.pagePort}${urlPath}`;
    },
    holderUrl() {
      return `ws://127.0.0.1:${bench.pagePort}${HOLDER_PATH}`;
    },
  };
}

export interface TestBuild {
  dir: string;
  /** The bytes of each image, by the name flasher_args.json gives it. */
  images: Record<string, Buffer>;
}

/**
 * A build directory with the real flasher_args.json and random images. `chip` changes the
 * build's target, `omit` leaves an image out, and an extra file sits beside the images.
 */
export function makeBuild(dir: string, opts: { chip?: string; omit?: string } = {}): TestBuild {
  const args = readFlasherArgs();
  if (opts.chip) args.extra_esptool_args.chip = opts.chip;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flasher_args.json'), JSON.stringify(args, null, 4));
  const images: Record<string, Buffer> = {};
  for (const name of Object.values(args.flash_files)) {
    const data = crypto.randomBytes(1000 + Math.floor(Math.random() * 5000));
    images[name] = data;
    if (name === opts.omit) continue;
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  // Not named by flasher_args.json, so never written
  fs.writeFileSync(path.join(dir, 'hello_world.elf'), crypto.randomBytes(100));
  return { dir, images };
}

export interface HolderOptions {
  hello?: boolean | Partial<Extract<HolderMessage, { t: 'hello' }>>;
  /** The port report sent after the welcome; null sends none. */
  port?: PortReport | null;
  autoPong?: boolean;
  headers?: Record<string, string>;
  /** The Origin the holder sends; the page's own by default, as a browser sends it. */
  origin?: string;
}

export const OPEN_PORT: PortReport = { state: 'open', usbVendorId: 0x303a, usbProductId: 0x1001, chip: 'ESP32-S3', mac: 'dc:da:0c:11:22:33' };

/** The holder's side of the protocol, driven by the test. */
export class ScriptedHolder {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  autoPong: boolean;
  readonly closed: Promise<{ code: number; reason: string }>;
  private queue: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  private constructor(url: string, opts: ClientOptions, autoPong: boolean) {
    this.autoPong = autoPong;
    this.ws = new WebSocket(url, opts);
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    this.ws.on('error', () => {});
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      this.received.push(msg);
      if (msg.t === 'ping' && this.autoPong) {
        this.send({ t: 'pong', ts: msg.ts });
        return;
      }
      const i = this.waiters.findIndex((w) => w.match(msg));
      const w = i >= 0 ? this.waiters.splice(i, 1)[0] : undefined;
      if (w) w.resolve(msg);
      else this.queue.push(msg);
    });
  }

  /** Connects and opens the socket, without a hello. */
  static async open(bench: TestBench, opts: HolderOptions = {}): Promise<ScriptedHolder> {
    const h = new ScriptedHolder(
      bench.holderUrl(),
      { headers: opts.headers, origin: opts.origin ?? bench.pageUrl('') },
      opts.autoPong ?? true,
    );
    await new Promise<void>((resolve, reject) => {
      h.ws.once('open', () => resolve());
      h.ws.once('error', reject);
    });
    return h;
  }

  /** Connects, says hello, waits for the welcome and reports an open port. */
  static async connect(bench: TestBench, opts: HolderOptions = {}): Promise<ScriptedHolder> {
    const h = await ScriptedHolder.open(bench, opts);
    h.hello(typeof opts.hello === 'object' ? opts.hello : {});
    await h.next('welcome');
    const port = opts.port === undefined ? OPEN_PORT : opts.port;
    if (port) await h.reportPort(port, bench);
    return h;
  }

  send(msg: HolderMessage | Record<string, unknown> | string): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  hello(over: Partial<Extract<HolderMessage, { t: 'hello' }>> = {}): void {
    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, holder: 'scripted', userAgent: 'vitest', ...over });
  }

  /** Reports the port, and waits until the bench has it, when given the bench. */
  async reportPort(port: PortReport, bench?: TestBench): Promise<void> {
    this.send({ t: 'port', port });
    if (bench) await until(() => bench.hub.status().port.state === port.state);
  }

  log(text: string): void {
    this.send({ t: 'log', text });
  }

  result(jobId: string, result: JobResult): void {
    this.send({ t: 'result', jobId, ...result });
  }

  /** The next message of a kind, received already or still to come. */
  next<T extends ServerMessage['t']>(t: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { t: T }>> {
    const match = (m: ServerMessage) => m.t === t;
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`no ${t} within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = {
        match,
        resolve: (m: ServerMessage) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      };
      this.waiters.push(waiter);
    });
  }

  async nextJob(timeoutMs = 2000): Promise<{ jobId: string; job: Job }> {
    const m = await this.next('job', timeoutMs);
    return { jobId: m.jobId, job: m.job };
  }

  /** Whether a job has come in that no test has taken yet. */
  hasJob(): boolean {
    return this.queue.some((m) => m.t === 'job');
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.closed;
  }
}

/** Waits for a condition the bench reaches by itself. */
export async function until(cond: () => boolean, timeoutMs = 2000, what = 'the condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`${what} did not hold within ${timeoutMs} ms`);
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The log file's lines, as the bench wrote them. */
export function logFileLines(bench: TestBench): string[] {
  return fs.readFileSync(bench.log.path, 'utf8').split('\n').filter(Boolean);
}
