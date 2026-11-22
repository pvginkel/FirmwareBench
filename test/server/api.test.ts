// The agent API's calls besides the flash, how it reads bodies, its errors, and where it listens.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logFileLines, makeBuild, ScriptedHolder, startTestBench, type TestBench } from './helpers.ts';

let bench: TestBench;

beforeEach(async () => {
  bench = await startTestBench();
});

afterEach(async () => {
  await bench.close();
});

describe('POST /reset', () => {
  it('sends a reset job and answers the cursor of its marker', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const call = bench.api('POST', '/reset');
    const { jobId, job } = await holder.nextJob();
    expect(job).toEqual({ kind: 'reset' });
    holder.result(jobId, { ok: true });
    const r = await call;
    expect(r.status).toBe(200);
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(new RegExp(`^\\S+ ${r.body.cursor} = reset$`)));
  });

  it('that fails answers reset_failed', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const call = bench.api('POST', '/reset');
    const { jobId } = await holder.nextJob();
    holder.result(jobId, { ok: false, code: 'reset_failed', message: 'the port did not come back' });
    const r = await call;
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'reset_failed', message: 'the port did not come back' });
  });

  it('that the holder never answers times out after the reset timeout', async () => {
    await bench.close();
    bench = await startTestBench({ api: { resetTimeoutMs: 100 } });
    const holder = await ScriptedHolder.connect(bench);
    const call = bench.api('POST', '/reset');
    await holder.nextJob();
    const r = await call;
    expect(r.status).toBe(504);
    expect(r.body.error).toBe('timed_out');
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(/ = reset timed out: /));
  });
});

describe('POST /console', () => {
  it('sends the line as it is; the holder adds the line end', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const call = bench.api('POST', '/console', { line: 'nvs get wifi' });
    const { jobId, job } = await holder.nextJob();
    expect(job).toEqual({ kind: 'console', line: 'nvs get wifi' });
    holder.result(jobId, { ok: true });
    const r = await call;
    expect(r.status).toBe(200);
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(new RegExp(`^\\S+ ${r.body.cursor} = console: nvs get wifi$`)));
  });

  it('refuses a line with CR or LF, and one that is missing', async () => {
    const holder = await ScriptedHolder.connect(bench);
    for (const body of [{ line: 'a\nb' }, { line: 'a\r' }, { line: 5 }, {}]) {
      const r = await bench.api('POST', '/console', body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('bad_request');
    }
    expect(holder.hasJob()).toBe(false);
  });
});

describe('bodies', () => {
  it('are read as JSON whatever content type curl -d sends, or none', async () => {
    const holder = await ScriptedHolder.connect(bench);
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', null]) {
      const call = bench.api('POST', '/console', undefined, { contentType, raw: '{"line":"help"}' });
      const { jobId, job } = await holder.nextJob();
      expect(job).toEqual({ kind: 'console', line: 'help' });
      holder.result(jobId, { ok: true });
      expect((await call).status).toBe(200);
    }
  });

  it('that are not a JSON object are refused', async () => {
    await ScriptedHolder.connect(bench);
    for (const raw of ['line=help', '[1,2]', '"text"', '{"line":']) {
      const r = await bench.api('POST', '/console', undefined, { raw });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('bad_request');
    }
  });

  it('that are too large are refused with an answer', async () => {
    const r = await bench.api('POST', '/console', undefined, { raw: JSON.stringify({ line: 'x'.repeat(70 * 1024) }) });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/larger than/) });
  });

  it('may leave out a flash timeout, but not give a bad one', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    for (const timeout of [-1, 0, '10', 'x']) {
      const r = await bench.api('POST', '/flash', { build_dir: build.dir, timeout });
      expect([timeout, r.status, r.body.error]).toEqual([timeout, 400, 'bad_request']);
    }
    expect(holder.hasJob()).toBe(false);
  });
});

describe('errors', () => {
  it('are a non-2xx status with a JSON body that carries the code and a message', async () => {
    const cases: [string, string, number, string][] = [
      ['GET', '/nothing', 404, 'not_found'],
      ['GET', '/flash', 404, 'not_found'],
      ['POST', '/status', 404, 'not_found'],
      ['POST', '/reset', 503, 'no_holder'],
      ['POST', '/console', 400, 'bad_request'],
      ['GET', '/log?limit=x', 400, 'bad_request'],
    ];
    for (const [method, url, status, code] of cases) {
      const r = await bench.api(method, url, method === 'POST' && url === '/console' ? { line: 'a\nb' } : undefined);
      expect([method, url, r.status]).toEqual([method, url, status]);
      expect(r.contentType).toBe('application/json');
      expect(r.body).toMatchObject({ error: code, message: expect.any(String) });
    }
  });
});

describe('GET /status', () => {
  it('says when no holder is connected', async () => {
    const r = await bench.api('GET', '/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ holder: { connected: false }, port: { open: false, state: 'none' }, job: null });
  });

  it('shows the running job', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const call = bench.api('POST', '/console', { line: 'x' });
    const { jobId } = await holder.nextJob();
    expect((await bench.api('GET', '/status')).body.job).toMatchObject({ kind: 'console', timedOut: false });
    holder.result(jobId, { ok: true });
    await call;
    expect((await bench.api('GET', '/status')).body.job).toBeNull();
  });
});

describe('the listeners', () => {
  it('bind the agent API to 127.0.0.1 only', async () => {
    expect(bench.apiHost).toBe('127.0.0.1');
    const other = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (!other) return;
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect(bench.apiPort, other);
      s.once('connect', () => {
        s.destroy();
        resolve(false);
      });
      s.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('end a blocked call when the bench stops', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const call = bench.api('POST', '/reset').catch((e: unknown) => e);
    await holder.nextJob();
    const wait = bench.api('GET', '/log?wait=never&timeout=60').catch((e: unknown) => e);
    const t0 = Date.now();
    await bench.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    // A job gets its answer; a wait on the log has its connection closed
    expect(await call).toMatchObject({ status: 503, body: { error: 'no_holder', message: 'the bench is stopping' } });
    expect(await wait).toBeInstanceOf(Error);
    bench = await startTestBench();
  });
});
