// The device log: the writer on its own, and `GET /log` through the agent API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SerialLog } from '../../src/server/serial-log.ts';
import { logFileLines, ScriptedHolder, sleep, startTestBench, type TestBench } from './helpers.ts';

describe('SerialLog', () => {
  let dir: string;
  const logs: SerialLog[] = [];

  function open(opts: Partial<ConstructorParameters<typeof SerialLog>[0]> = {}): SerialLog {
    const log = new SerialLog({ dir, ...opts });
    log.open();
    logs.push(log);
    return log;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-log-'));
  });

  afterEach(() => {
    for (const l of logs.splice(0)) l.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fileLines(name = 'serial.log'): string[] {
    return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean);
  }

  it('writes one numbered, timestamped line per device line, and markers with =', () => {
    let t = Date.parse('2026-11-22T17:00:00.123Z');
    const log = open({ now: () => t });
    log.write('I (305) cpu_start: Starting');
    t += 5;
    log.write(' scheduler.\r\nsecond\r\n');
    expect(log.marker('flash started: /work/app/build')).toBe(3);
    expect(fileLines()).toEqual([
      '2026-11-22T17:00:00.123Z 1 | I (305) cpu_start: Starting scheduler.',
      '2026-11-22T17:00:00.128Z 2 | second',
      '2026-11-22T17:00:00.128Z 3 = flash started: /work/app/build',
    ]);
    expect(log.cursor).toBe(3);
  });

  it('strips colour codes and other control characters, but keeps tabs', () => {
    const log = open();
    log.write('\x1b[0;32mI (305) cpu_start: ok\x1b[0m\r\n');
    log.write('a\tb\x07\x00c\r\n');
    log.write('\x1b]0;title\x07after osc\n');
    expect(log.since(0, 10).lines.map((l) => l.text)).toEqual(['I (305) cpu_start: ok', 'a\tbc', 'after osc']);
  });

  it('writes a partial line out after partialFlushMs, and before a marker', async () => {
    const log = open({ partialFlushMs: 30 });
    log.write('no line end yet');
    expect(log.cursor).toBe(0);
    await sleep(60);
    expect(log.since(0, 10).lines.map((l) => l.text)).toEqual(['no line end yet']);
    log.write('half');
    log.marker('reset');
    expect(log.since(1, 10).lines.map((l) => [l.text, l.marker])).toEqual([
      ['half', false],
      ['reset', true],
    ]);
  });

  it('keeps the cursor across a restart', () => {
    const first = open();
    first.write('one\ntwo\n');
    first.marker('bench stopped');
    first.close();
    const second = open();
    expect(second.cursor).toBe(3);
    second.write('three\n');
    expect(fileLines().at(-1)).toMatch(/^\S+ 4 \| three$/);
  });

  it('does not take a cursor from a device line that looks like one', () => {
    const first = open();
    first.write('x\n');
    first.close();
    // A torn last line, whose text looks like a log line, must not be read as the cursor
    fs.appendFileSync(path.join(dir, 'serial.log'), 'garbage 999 | text');
    expect(open().cursor).toBe(1);
  });

  it('rotates by size, keeps `keep` files, and keeps counting', () => {
    const log = open({ maxBytes: 300, keep: 2 });
    for (let i = 1; i <= 40; i++) log.write(`line ${i} ${'x'.repeat(20)}\n`);
    expect(fs.existsSync(path.join(dir, 'serial.log.1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'serial.log.2'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'serial.log.3'))).toBe(false);
    for (const f of ['serial.log', 'serial.log.1', 'serial.log.2']) {
      expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(300);
    }
    // The files hold consecutive cursors, newest in serial.log
    const cursors = ['serial.log.2', 'serial.log.1', 'serial.log'].flatMap((f) => fileLines(f).map((l) => Number(l.split(' ')[1])));
    expect(cursors.at(-1)).toBe(40);
    expect(cursors).toEqual(cursors.map((_, i) => (cursors[0] ?? 0) + i));
    log.close();

    // A rotation that left serial.log empty still gives the cursor back on restart
    fs.writeFileSync(path.join(dir, 'serial.log'), '');
    expect(open({ maxBytes: 300, keep: 2 }).cursor).toBe(Math.max(...fileLines('serial.log.1').map((l) => Number(l.split(' ')[1]))));
  });

  it('answers lines after a cursor, and says when the ring no longer has them', () => {
    const log = open({ ring: 5 });
    for (let i = 1; i <= 10; i++) log.write(`l${i}\n`);
    expect(log.since(7, 100)).toEqual({ lines: expect.any(Array), truncated: false });
    expect(log.since(7, 100).lines.map((l) => l.cursor)).toEqual([8, 9, 10]);
    expect(log.since(2, 100).truncated).toBe(true);
    expect(log.since(2, 100).lines.map((l) => l.cursor)).toEqual([6, 7, 8, 9, 10]);
    expect(log.since(null, 2).lines.map((l) => l.cursor)).toEqual([9, 10]);
    expect(log.since(7, 2).lines.map((l) => l.cursor)).toEqual([8, 9]);
  });

  it('says lines are missing after a restart, when the ring is empty', () => {
    const first = open();
    first.write('a\nb\nc\n');
    first.close();
    const second = open();
    expect(second.since(1, 10)).toEqual({ lines: [], truncated: true });
    expect(second.since(3, 10)).toEqual({ lines: [], truncated: false });
  });

  it('waits for a matching device line, never a marker, and times out', async () => {
    const log = open();
    log.marker('flash started: /work/hello/build');
    const miss = await log.waitFor(0, /hello/, 30, 10);
    expect(miss).toMatchObject({ matched: false, cursor: 1 });

    const wait = log.waitFor(log.cursor, /Hello world/, 1000, 10);
    log.write('boot\r\n');
    log.marker('console: Hello world');
    log.write('Hello world!\r\nafter\r\n');
    const hit = await wait;
    expect(hit.matched).toBe(true);
    if (!hit.matched) return;
    expect(hit.match).toMatchObject({ cursor: 4, text: 'Hello world!' });
    expect(hit.lines.map((l) => l.text)).toEqual(['boot', 'console: Hello world', 'Hello world!']);
    expect(hit.cursor).toBe(4);

    // A line already in the log counts
    const again = await log.waitFor(1, /after/, 10, 10);
    expect(again).toMatchObject({ matched: true, cursor: 5 });
  });

  it('ends a wait when it is aborted', async () => {
    const log = open();
    const abort = new AbortController();
    const wait = log.waitFor(0, /never/, 10_000, 10, abort.signal);
    abort.abort();
    expect(await wait).toMatchObject({ matched: false });
  });
});

describe('GET /log', () => {
  let bench: TestBench;
  let holder: ScriptedHolder;

  beforeEach(async () => {
    bench = await startTestBench();
    holder = await ScriptedHolder.connect(bench);
  });

  afterEach(async () => {
    await bench.close();
  });

  async function logged(text: string) {
    const before = bench.log.cursor;
    holder.log(text);
    const lines = text.split('\n').length - 1;
    for (let i = 0; i < 100 && bench.log.cursor < before + lines; i++) await sleep(5);
  }

  it('answers the lines after the cursor, with the new cursor', async () => {
    const start = bench.log.cursor;
    await logged('one\r\ntwo\r\nthree\r\n');
    const all = await bench.api('GET', `/log?since=${start}`);
    expect(all.status).toBe(200);
    expect(all.body.lines.map((l: { text: string }) => l.text)).toEqual(['one', 'two', 'three']);
    expect(all.body.lines.map((l: { cursor: number }) => l.cursor)).toEqual([start + 1, start + 2, start + 3]);
    expect(all.body).toMatchObject({ cursor: start + 3, truncated: false });
    expect(all.body.lines[0].time).toMatch(/^\d{4}-\d\d-\d\dT/);

    const after = await bench.api('GET', `/log?since=${start + 1}&limit=1`);
    expect(after.body.lines.map((l: { text: string }) => l.text)).toEqual(['two']);
    expect(after.body.cursor).toBe(start + 2);

    const none = await bench.api('GET', `/log?since=${start + 3}`);
    expect(none.body).toMatchObject({ lines: [], cursor: start + 3 });

    // Without a cursor, the last lines; markers are flagged
    const tail = await bench.api('GET', '/log?limit=2');
    expect(tail.body.lines.map((l: { text: string }) => l.text)).toEqual(['two', 'three']);
    const markers = (await bench.api('GET', `/log?since=0`)).body.lines.filter((l: { marker?: boolean }) => l.marker);
    expect(markers.map((l: { text: string }) => l.text)).toContain('port opened');
  });

  it('waits for a line that matches, and answers it', async () => {
    const start = bench.log.cursor;
    const call = bench.api('GET', `/log?since=${start}&wait=${encodeURIComponent('Hello w.rld')}&timeout=2`);
    await sleep(50);
    holder.log('boot\r\nHello world!\r\nmore\r\n');
    const r = await call;
    expect(r.status).toBe(200);
    expect(r.body.match).toMatchObject({ cursor: start + 2, text: 'Hello world!' });
    expect(r.body.lines.map((l: { text: string }) => l.text)).toEqual(['boot', 'Hello world!']);
    expect(r.body.cursor).toBe(start + 2);
  });

  it('answers a line already logged at once', async () => {
    const start = bench.log.cursor;
    await logged('ready\r\n');
    const t0 = Date.now();
    const r = await bench.api('GET', `/log?since=${start}&wait=ready&timeout=5`);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('times out with timed_out, the lines seen and the cursor', async () => {
    const start = bench.log.cursor;
    const call = bench.api('GET', `/log?since=${start}&wait=never&timeout=0.2`);
    await logged('something else\r\n');
    const t0 = Date.now();
    const r = await call;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.status).toBe(504);
    expect(r.body).toMatchObject({ error: 'timed_out', cursor: start + 1 });
    expect(r.body.lines.map((l: { text: string }) => l.text)).toEqual(['something else']);
  });

  it('refuses a cursor that is not a number and a pattern that is not a regular expression', async () => {
    expect((await bench.api('GET', '/log?since=abc')).body.error).toBe('bad_request');
    expect((await bench.api('GET', '/log?since=-1')).status).toBe(400);
    expect((await bench.api('GET', '/log?wait=(')).body.error).toBe('bad_request');
    expect((await bench.api('GET', '/log?wait=x&timeout=soon')).status).toBe(400);
  });

  it('lands in the file as well', async () => {
    await logged('in the file\r\n');
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(/^\S+ \d+ \| in the file$/));
  });

  it('keeps counting after the bench restarts', async () => {
    // A log dir of its own, which outlives the bench's temp root
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-restart-'));
    try {
      await bench.close();
      bench = await startTestBench({ logDir });
      holder = await ScriptedHolder.connect(bench);
      await logged('before\r\n');
      await bench.close();
      const cursor = Number(fs.readFileSync(path.join(logDir, 'serial.log'), 'utf8').trim().split('\n').at(-1)?.split(' ')[1]);
      bench = await startTestBench({ logDir });
      // The "bench started" marker takes the next cursor
      expect(bench.log.cursor).toBe(cursor + 1);
      expect((await bench.api('GET', '/status')).body.log.cursor).toBe(cursor + 1);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});
