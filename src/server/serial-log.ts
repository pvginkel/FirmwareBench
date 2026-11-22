// The device log: one line per device line, timestamped and numbered, in a file the agent
// reads with grep and tail, and in a ring the agent API serves from.
//
//   2026-11-22T17:00:00.123Z 41 | I (305) cpu_start: Starting scheduler.
//   2026-11-22T17:00:01.004Z 42 = flash started: /work/app/build
//
// `|` marks a line the device printed, `=` a marker the bench wrote. The number is the
// log cursor. It only grows, survives rotation and restarts, and `GET /log?since=` takes it.

import fs from 'node:fs';
import path from 'node:path';

export interface LogLine {
  cursor: number;
  ts: number;
  text: string;
  marker: boolean;
}

export interface SerialLogOptions {
  dir: string;
  file?: string;
  /** Rotate when the file would grow past this. */
  maxBytes?: number;
  /** Rotated files kept besides the current one. */
  keep?: number;
  /** Lines kept in memory for the agent API. */
  ring?: number;
  /** A partial line is written out after this long without a line end. */
  partialFlushMs?: number;
  now?: () => number;
}

export type WaitOutcome =
  | { matched: true; match: LogLine; lines: LogLine[]; cursor: number }
  | { matched: false; lines: LogLine[]; cursor: number };

// CSI and OSC sequences, then what is left of the C0 controls except tab
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function cleanLine(raw: string): string {
  return raw.replace(ANSI, '').replace(CONTROL, '');
}

const LINE_FORMAT = /^\d{4}-\d\d-\d\dT[\d:.]+Z (\d+) [|=] /;

export class SerialLog {
  readonly path: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly ringSize: number;
  private readonly partialFlushMs: number;
  private readonly now: () => number;
  private fd: number | null = null;
  private size = 0;
  private seq = 0;
  private ring: LogLine[] = [];
  private partial = '';
  private partialTs = 0;
  private partialTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(line: LogLine) => void>();

  constructor(opts: SerialLogOptions) {
    this.dir = opts.dir;
    this.path = path.join(opts.dir, opts.file ?? 'serial.log');
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
    this.keep = opts.keep ?? 3;
    this.ringSize = opts.ring ?? 10000;
    this.partialFlushMs = opts.partialFlushMs ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Opens the file, and takes up the cursor where the last run left it. */
  open(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.seq = Math.max(lastCursorIn(this.path), lastCursorIn(`${this.path}.1`));
    this.fd = fs.openSync(this.path, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  close(): void {
    this.flushPartial();
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  /** The cursor of the last line written; 0 before the first. */
  get cursor(): number {
    return this.seq;
  }

  /** Device output, in whatever pieces it arrived. */
  write(text: string): void {
    const ts = this.now();
    let rest = this.partial + text;
    if (!this.partial) this.partialTs = ts;
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      this.append(rest.slice(0, i), false, this.partialTs);
      rest = rest.slice(i + 1);
      this.partialTs = ts;
    }
    this.partial = rest;
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = rest ? setTimeout(() => this.flushPartial(), this.partialFlushMs) : null;
    this.partialTimer?.unref();
  }

  /** Writes a marker line, after any partial device line, and answers its cursor. */
  marker(text: string): number {
    this.flushPartial();
    return this.append(text, true, this.now()).cursor;
  }

  /** Lines after `cursor`, at most `limit`, oldest first. Without a cursor, the last `limit`. */
  since(cursor: number | null, limit: number): { lines: LogLine[]; truncated: boolean } {
    if (cursor === null) return { lines: this.ring.slice(-limit), truncated: false };
    // Lines between the cursor and the oldest one in memory are only in the file, if anywhere
    const oldest = this.ring[0]?.cursor ?? this.seq + 1;
    const truncated = oldest > cursor + 1;
    const lines = this.ring.filter((l) => l.cursor > cursor);
    return { lines: lines.slice(0, limit), truncated };
  }

  /**
   * Waits for a device line after `cursor` that matches `pattern`, and answers the lines up to
   * and including it (the last `limit` of them, markers included). A line already in the log
   * counts. Markers never match: they echo console lines and build paths, which would.
   */
  waitFor(cursor: number, pattern: RegExp, timeoutMs: number, limit: number, signal?: AbortSignal): Promise<WaitOutcome> {
    const matches = (l: LogLine) => !l.marker && pattern.test(l.text);
    const seen = this.ring.filter((l) => l.cursor > cursor);
    const hit = seen.find(matches);
    if (hit) {
      const upTo = seen.filter((l) => l.cursor <= hit.cursor);
      return Promise.resolve({ matched: true, match: hit, lines: upTo.slice(-limit), cursor: hit.cursor });
    }
    if (signal?.aborted) return Promise.resolve({ matched: false, lines: seen.slice(-limit), cursor: this.seq });
    return new Promise((resolve) => {
      const lines = seen.slice(-limit);
      const finish = (outcome: WaitOutcome) => {
        clearTimeout(timer);
        this.listeners.delete(onLine);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onLine = (line: LogLine) => {
        lines.push(line);
        while (lines.length > limit) lines.shift();
        if (matches(line)) finish({ matched: true, match: line, lines: [...lines], cursor: line.cursor });
      };
      const onAbort = () => finish({ matched: false, lines: [...lines], cursor: this.seq });
      const timer = setTimeout(onAbort, timeoutMs);
      this.listeners.add(onLine);
      signal?.addEventListener('abort', onAbort);
    });
  }

  private flushPartial(): void {
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
    if (this.partial) {
      const text = this.partial;
      this.partial = '';
      this.append(text, false, this.partialTs);
    }
  }

  private append(raw: string, marker: boolean, ts: number): LogLine {
    const text = marker ? raw : cleanLine(raw);
    const line: LogLine = { cursor: ++this.seq, ts, text, marker };
    const out = `${new Date(ts).toISOString()} ${line.cursor} ${marker ? '=' : '|'} ${text}\n`;
    const bytes = Buffer.byteLength(out);
    if (this.fd !== null) {
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.writeSync(this.fd, out);
      this.size += bytes;
    }
    this.ring.push(line);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const l of this.listeners) l(line);
    return line;
  }

  private rotate(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    fs.rmSync(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${this.path}.${i}`)) fs.renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    fs.renameSync(this.path, `${this.path}.1`);
    this.fd = fs.openSync(this.path, 'a');
    this.size = 0;
  }
}

/** The cursor of the last line in a log file, or 0. Reads only the file's tail. */
function lastCursorIn(file: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      const m = LINE_FORMAT.exec(l);
      if (m) return Number(m[1]);
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}
