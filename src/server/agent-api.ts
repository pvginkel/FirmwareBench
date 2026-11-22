// The agent API, on 127.0.0.1 only, so the edge never reaches it. Bodies are read as JSON
// whatever content type the client sends, so `curl -d '{...}'` works as it is.

import type http from 'node:http';
import { BadBuildDir, readBuild } from './build-dir.ts';
import { ApiError } from './errors.ts';
import type { Job, JobKind } from '../shared/protocol.ts';
import type { BuildImage } from './build-dir.ts';
import type { HolderHub } from './holder-hub.ts';
import type { LogLine, SerialLog } from './serial-log.ts';

export interface AgentApiConfig {
  workRoot: string;
  flashTimeoutMs: number;
  resetTimeoutMs: number;
  consoleTimeoutMs: number;
  /** How long a lost port gets to come back before a job is refused. */
  portWaitMs: number;
}

const MAX_BODY = 64 * 1024;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 600;

export function agentApi(hub: HolderHub, log: SerialLog, cfg: AgentApiConfig): http.RequestListener {
  const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<unknown>> = {
    'POST /flash': async (req) => flash(await readJson(req)),
    'GET /status': async () => ({ ...hub.status(), log: { file: log.path, cursor: log.cursor } }),
    'GET /log': async (_req, res, url) => readLog(url, res),
    'POST /reset': async () => reset(),
    'POST /console': async (req) => consoleLine(await readJson(req)),
  };

  async function flash(body: Record<string, unknown>) {
    let build;
    try {
      build = await readBuild(body.build_dir, cfg.workRoot);
    } catch (e) {
      if (e instanceof BadBuildDir) throw new ApiError('bad_build_dir', e.message);
      throw e;
    }
    const timeoutMs = seconds(body.timeout, cfg.flashTimeoutMs);
    await hub.claim('flash', cfg.portWaitMs);
    const t0 = Date.now();
    const { cursor, outcome } = await runJob(
      'flash',
      `flash started: ${build.dir} (${build.chip}, ${build.images.map((i) => `0x${i.offset.toString(16)} ${i.name}`).join(', ')})`,
      (jobId) => ({
        kind: 'flash',
        chip: build.chip,
        flash: build.flash,
        images: build.images.map((im, i) => ({
          offset: im.offset,
          name: im.name,
          url: imageUrl(jobId, i),
          size: im.size,
          md5: im.md5,
        })),
      }),
      timeoutMs,
      build.images,
    );
    const secondsTaken = Math.round((Date.now() - t0) / 100) / 10;
    log.marker(`flash done in ${secondsTaken} s: ${outcome.chip ?? '?'} ${outcome.mac ?? ''}`.trimEnd());
    return { chip: outcome.chip ?? null, mac: outcome.mac ?? null, seconds: secondsTaken, cursor };
  }

  async function reset() {
    await hub.claim('reset', cfg.portWaitMs);
    const { cursor } = await runJob('reset', 'reset', () => ({ kind: 'reset' }), cfg.resetTimeoutMs);
    return { cursor };
  }

  async function consoleLine(body: Record<string, unknown>) {
    const line = body.line;
    if (typeof line !== 'string') throw new ApiError('bad_request', 'line is required');
    if (/[\r\n]/.test(line)) throw new ApiError('bad_request', 'line must be one line; the bench adds the line end');
    await hub.claim('console', cfg.portWaitMs);
    const { cursor } = await runJob('console', `console: ${line}`, () => ({ kind: 'console', line }), cfg.consoleTimeoutMs);
    return { cursor };
  }

  /**
   * Runs a job in the slot a claim took: writes its start marker, whose cursor the call
   * answers, and turns a failed outcome into the API error, with a marker. The slot is given
   * back on any failure before the job reaches the holder.
   */
  async function runJob(kind: JobKind, startMarker: string, makeJob: (jobId: string) => Job, timeoutMs: number, images: BuildImage[] = []) {
    let cursor: number | null = null;
    let outcome;
    try {
      cursor = log.marker(startMarker);
      outcome = await hub.run(makeJob, timeoutMs, images);
    } catch (e) {
      hub.release();
      if (e instanceof ApiError) {
        log.marker(`${kind} ${e.code === 'timed_out' ? 'timed out' : 'failed'}: ${e.message}`);
        if (cursor !== null) e.extra.cursor = cursor;
      }
      throw e;
    }
    if (!outcome.ok) {
      log.marker(`${kind} failed: ${outcome.code}: ${outcome.message}`);
      throw new ApiError(outcome.code, outcome.message, { cursor, ...('chip' in outcome && outcome.chip ? { chip: outcome.chip } : {}) });
    }
    return { cursor, outcome };
  }

  async function readLog(url: URL, res: http.ServerResponse) {
    const since = optionalInt(url.searchParams.get('since'), 'since');
    const limit = Math.max(1, Math.min(optionalInt(url.searchParams.get('limit'), 'limit') ?? DEFAULT_LIMIT, MAX_LIMIT));
    const wait = url.searchParams.get('wait');
    if (wait === null) {
      const { lines, truncated } = log.since(since, limit);
      const last = lines.at(-1);
      return { lines: lines.map(lineJson), cursor: last ? last.cursor : (since ?? log.cursor), truncated };
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(wait);
    } catch (e) {
      throw new ApiError('bad_request', `wait is not a regular expression: ${(e as Error).message}`);
    }
    const timeoutS = Math.min(optionalNumber(url.searchParams.get('timeout'), 'timeout') ?? DEFAULT_WAIT_S, MAX_WAIT_S);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const out = await log.waitFor(since ?? log.cursor, pattern, timeoutS * 1000, limit, abort.signal);
    if (!out.matched) {
      throw new ApiError('timed_out', `no line matched ${wait} within ${timeoutS} s`, { lines: out.lines.map(lineJson), cursor: out.cursor });
    }
    return { lines: out.lines.map(lineJson), match: lineJson(out.match), cursor: out.cursor };
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bench');
    const route = routes[`${req.method} ${url.pathname}`];
    const handle = route
      ? route(req, res, url)
      : Promise.reject(new ApiError('not_found', `no such call: ${req.method} ${url.pathname}`));
    handle.then(
      (body) => send(res, 200, body),
      (e: unknown) => {
        if (e instanceof ApiError) send(res, e.status, e.body());
        else send(res, 500, { error: 'internal', message: String((e as Error)?.message ?? e) });
      },
    );
  };
}

/** Where the holder fetches a running job's image, on the page port. */
export function imageUrl(jobId: string, index: number): string {
  return `/jobs/${jobId}/images/${index}`;
}

function lineJson(l: LogLine) {
  return { cursor: l.cursor, time: new Date(l.ts).toISOString(), text: l.text, ...(l.marker ? { marker: true } : {}) };
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // A body that is too large is read to its end and dropped, so the answer still goes out
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new ApiError('bad_request', `the body is larger than ${MAX_BODY} bytes`));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v: unknown = JSON.parse(text);
        if (v && typeof v === 'object' && !Array.isArray(v)) resolve(v as Record<string, unknown>);
        else reject(new ApiError('bad_request', 'the body must be a JSON object'));
      } catch {
        reject(new ApiError('bad_request', 'the body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function optionalInt(v: string | null, name: string): number | null {
  if (v === null || v === '') return null;
  if (!/^\d+$/.test(v)) throw new ApiError('bad_request', `${name} must be a whole number`);
  return Number(v);
}

function optionalNumber(v: string | null, name: string): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError('bad_request', `${name} must be a number of seconds`);
  return n;
}

function seconds(v: unknown, fallbackMs: number): number {
  if (v === undefined || v === null) return fallbackMs;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ApiError('bad_request', 'timeout must be a number of seconds');
  return v * 1000;
}
