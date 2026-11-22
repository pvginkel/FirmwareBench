// The holder's connection: the handshake, refusals, the heartbeat, the port's state, and
// frames the protocol does not allow.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOSE_ANOTHER_HOLDER,
  CLOSE_NO_HELLO,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_STALE,
  PROTOCOL_VERSION,
} from '../../src/shared/protocol.ts';
import type { BenchOptions } from '../../src/server/app.ts';
import { logFileLines, makeBuild, OPEN_PORT, ScriptedHolder, sleep, startTestBench, type TestBench } from './helpers.ts';

let bench: TestBench | null = null;

async function start(over: Partial<BenchOptions> = {}): Promise<TestBench> {
  bench = await startTestBench(over);
  return bench;
}

afterEach(async () => {
  await bench?.close();
  bench = null;
});

describe('the handshake', () => {
  it('welcomes a holder that says hello, and reports it in the status', async () => {
    const b = await start();
    await ScriptedHolder.connect(b, { hello: { holder: 'bench page', userAgent: 'Chrome 158' } });
    const s = await b.api('GET', '/status');
    expect(s.status).toBe(200);
    expect(s.body.holder).toMatchObject({ connected: true, name: 'bench page', userAgent: 'Chrome 158', from: '127.0.0.1' });
    expect(s.body.port).toMatchObject({ open: true, state: 'open', chip: 'ESP32-S3', mac: OPEN_PORT.mac });
    expect(s.body.job).toBeNull();
    expect(s.body.log).toEqual({ file: b.log.path, cursor: b.log.cursor });
    expect(logFileLines(b)).toContainEqual(expect.stringMatching(/ = holder connected: bench page from 127\.0\.0\.1 \(Chrome 158\)$/));
    expect(logFileLines(b)).toContainEqual(expect.stringMatching(/ = port opened$/));
  });

  it('takes the holder\'s address from X-Forwarded-For, as the edge sets it', async () => {
    const b = await start();
    await ScriptedHolder.connect(b, { headers: { 'x-forwarded-for': '192.168.1.50, 10.0.0.1' } });
    expect((await b.api('GET', '/status')).body.holder.from).toBe('192.168.1.50');
  });

  it('refuses a second holder with 4001, and keeps the first', async () => {
    const b = await start();
    const first = await ScriptedHolder.connect(b, { hello: { holder: 'first' } });
    const second = await ScriptedHolder.open(b);
    second.hello({ holder: 'second' });
    const refused = await second.next('refused');
    expect(refused.reason).toMatch(/another holder/);
    expect((await second.closed).code).toBe(CLOSE_ANOTHER_HOLDER);
    expect(b.hub.status().holder).toMatchObject({ connected: true, name: 'first' });

    // The first still takes jobs
    const call = b.api('POST', '/console', { line: 'help' });
    const { jobId } = await first.nextJob();
    first.result(jobId, { ok: true });
    expect((await call).status).toBe(200);
  });

  it('refuses a holder that speaks another protocol with 4002', async () => {
    const b = await start();
    const h = await ScriptedHolder.open(b);
    h.hello({ protocol: PROTOCOL_VERSION + 1 });
    expect((await h.next('refused')).reason).toMatch(/reload the page/);
    expect((await h.closed).code).toBe(CLOSE_PROTOCOL_MISMATCH);
    expect(b.hub.status().holder.connected).toBe(false);
  });

  it('treats a hello without a protocol number as a mismatch', async () => {
    const b = await start();
    const h = await ScriptedHolder.open(b);
    h.send({ t: 'hello', holder: 'old page' });
    expect((await h.closed).code).toBe(CLOSE_PROTOCOL_MISMATCH);
  });

  it('closes a socket that never says hello with 4003, and ignores what it sends before', async () => {
    const b = await start({ hub: { helloTimeoutMs: 150 } });
    const h = await ScriptedHolder.open(b);
    h.send({ t: 'port', port: OPEN_PORT });
    h.send({ t: 'log', text: 'not yet\n' });
    const t0 = Date.now();
    expect((await h.closed).code).toBe(CLOSE_NO_HELLO);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(b.hub.status().port.state).toBe('none');
    expect(logFileLines(b).some((l) => l.includes('not yet'))).toBe(false);
  });

  it('replaces a stale holder, closing it with 4004', async () => {
    // The heartbeat would drop it first; this is a holder that went quiet between pings
    const b = await start({ hub: { staleMs: 150, pingIntervalMs: 10_000 } });
    const stale = await ScriptedHolder.connect(b, { hello: { holder: 'stale' } });
    await sleep(250);
    const fresh = await ScriptedHolder.connect(b, { hello: { holder: 'fresh' } });
    expect((await stale.closed).code).toBe(CLOSE_STALE);
    expect(b.hub.status().holder).toMatchObject({ connected: true, name: 'fresh' });
    expect(logFileLines(b)).toContainEqual(expect.stringMatching(/ = holder replaced$/));
    await fresh.close();
  });

  it('names the page\'s entry script in the welcome, as index.html names it at each hello', async () => {
    const b = await start();
    const first = await ScriptedHolder.open(b);
    first.hello();
    expect((await first.next('welcome')).page).toBe('index-AbC123de.js');
    await first.close();

    // A rebuild, with the server running on
    fs.writeFileSync(path.join(b.pageDir, 'index.html'), '<script crossorigin type="module" src="/assets/index-Zz9.js?v=1"></script>');
    const second = await ScriptedHolder.open(b);
    second.hello();
    expect((await second.next('welcome')).page).toBe('index-Zz9.js');
    await second.close();

    fs.rmSync(path.join(b.pageDir, 'index.html'));
    const third = await ScriptedHolder.open(b);
    third.hello();
    expect(await third.next('welcome')).toEqual({ t: 'welcome', protocol: PROTOCOL_VERSION });
  });

  it('takes the next holder at once when the first has closed', async () => {
    const b = await start();
    const first = await ScriptedHolder.connect(b);
    await first.close();
    await ScriptedHolder.connect(b, { hello: { holder: 'reloaded' } });
    expect(b.hub.status().holder).toMatchObject({ name: 'reloaded' });
  });
});

describe('the heartbeat', () => {
  it('pings, keeps a holder that answers, and drops one that does not', async () => {
    const b = await start({ hub: { pingIntervalMs: 40, staleMs: 150 } });
    const live = await ScriptedHolder.connect(b, { hello: { holder: 'live' } });
    await sleep(300);
    expect(live.received.filter((m) => m.t === 'ping').length).toBeGreaterThanOrEqual(3);
    expect(b.hub.status().holder).toMatchObject({ connected: true, name: 'live' });
    await live.close();

    const silent = await ScriptedHolder.connect(b, { hello: { holder: 'silent' }, autoPong: false });
    expect((await silent.closed).code).toBe(CLOSE_STALE);
    expect(b.hub.status().holder.connected).toBe(false);
    expect(logFileLines(b)).toContainEqual(expect.stringMatching(/ = holder stopped answering$/));
  });
});

describe('the port', () => {
  it('that is lost and returns within portWaitMs takes the job', async () => {
    const b = await start({ api: { portWaitMs: 1000 } });
    const h = await ScriptedHolder.connect(b);
    await h.reportPort({ state: 'lost' }, b);
    const call = b.api('POST', '/reset');
    await sleep(100);
    expect(h.hasJob()).toBe(false);
    await h.reportPort(OPEN_PORT);
    const { jobId, job } = await h.nextJob();
    expect(job).toEqual({ kind: 'reset' });
    h.result(jobId, { ok: true });
    expect((await call).status).toBe(200);
    const lines = logFileLines(b);
    expect(lines).toContainEqual(expect.stringMatching(/ = port lost$/));
    expect(lines).toContainEqual(expect.stringMatching(/ = port reopened$/));
  });

  it('that is lost and stays away is refused with port_not_open after portWaitMs', async () => {
    const b = await start({ api: { portWaitMs: 150 } });
    const h = await ScriptedHolder.connect(b);
    await h.reportPort({ state: 'lost' }, b);
    const t0 = Date.now();
    const r = await b.api('POST', '/reset');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'port_not_open', message: "the holder's port is lost" });
    expect(h.hasJob()).toBe(false);
  });

  it('that is lost ends the wait with no_holder when the holder goes too', async () => {
    const b = await start({ api: { portWaitMs: 2000 } });
    const h = await ScriptedHolder.connect(b);
    await h.reportPort({ state: 'lost' }, b);
    const call = b.api('POST', '/reset');
    await sleep(50);
    h.ws.terminate();
    const r = await call;
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('no_holder');
  });

  it('that is closed is refused at once', async () => {
    const b = await start();
    const h = await ScriptedHolder.connect(b);
    await h.reportPort({ state: 'closed' }, b);
    const r = await b.api('POST', '/console', { line: 'x' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'port_not_open', message: "the holder's port is closed" });
  });

  it('keeps the chip and MAC a flash reports', async () => {
    const b = await start();
    const h = await ScriptedHolder.connect(b, { port: { state: 'open' } });
    const build = makeBuild(path.join(b.workRoot, 'build'));
    const call = b.api('POST', '/flash', { build_dir: build.dir });
    const { jobId } = await h.nextJob();
    h.result(jobId, { ok: true, chip: 'ESP32-S3', mac: 'dc:da:0c:00:00:01' });
    await call;
    expect((await b.api('GET', '/status')).body.port).toMatchObject({ open: true, chip: 'ESP32-S3', mac: 'dc:da:0c:00:00:01' });
  });
});

describe('frames the protocol does not allow', () => {
  it('are ignored, and the bench carries on', async () => {
    const b = await start();
    const h = await ScriptedHolder.connect(b);
    for (const junk of [
      'null',
      '[]',
      '42',
      'not json',
      '{"t":"port"}',
      '{"t":"port","port":null}',
      '{"t":"port","port":{"state":"melted"}}',
      '{"t":"log","text":5}',
      '{"t":"result","jobId":"x"}',
      '{"t":"progress","jobId":"x","phase":"dancing"}',
      '{"t":"welcome","protocol":1}',
      '{"no":"t"}',
    ]) {
      h.send(junk);
    }
    h.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await sleep(50);
    expect(b.hub.status()).toMatchObject({ holder: { connected: true }, port: { state: 'open' } });

    // A failure code the protocol does not know is the job's own failure, not a crash
    const build = makeBuild(path.join(b.workRoot, 'build'));
    const call = b.api('POST', '/flash', { build_dir: build.dir });
    const { jobId } = await h.nextJob();
    h.send({ t: 'result', jobId: 'someone-else', ok: true });
    h.send({ t: 'result', jobId, ok: false, code: 'on_fire', message: 'smoke' });
    const r = await call;
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'flash_failed', message: 'smoke' });
    expect((await b.api('GET', '/status')).status).toBe(200);
  });
});
