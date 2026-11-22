// The connection to the server: hello and welcome, ping and pong, reconnecting with
// back-off, and being turned away.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePort, harness, started as start, tick, until, type Harness } from './fakes.ts';

let h: Harness;

async function started(): Promise<Awaited<ReturnType<typeof start>>> {
  const s = await start();
  h = s;
  return s;
}

const server = () => h.engine.status().server;
const detail = () => h.engine.status().serverDetail ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  await h.engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the server connection', () => {
  it('says hello on the page origin, answers pings, and reports the port once welcomed', async () => {
    h = harness();
    h.serial.ports.push(new FakePort());
    await h.engine.start();
    const s = h.server.last;
    expect(s.url).toBe('wss://bench.example/holder');

    s.accept();
    expect(s.sent).toEqual([{ t: 'hello', protocol: 1, holder: 'bench page (test)' }]);
    expect(server()).toBe('connecting');

    s.message({ t: 'welcome', protocol: 1 });
    expect(server()).toBe('holder');
    expect(s.of('port')).toMatchObject([{ port: { state: 'open' } }]);

    s.message({ t: 'ping', ts: 42 });
    expect(s.of('pong')).toEqual([{ t: 'pong', ts: 42 }]);
  });

  it('reconnects by itself with back-off, and catches the server up', async () => {
    const { port } = await started();
    port.push('one\n');
    await tick(5);
    h.server.last.drop(1006);
    expect(server()).toBe('offline');
    port.push('while away\n');

    await tick(950);
    expect(h.server.sockets).toHaveLength(1);
    await tick(100);
    expect(h.server.sockets).toHaveLength(2);

    // That one never opens: the next try waits twice as long
    h.server.last.drop(1006);
    await tick(1950);
    expect(h.server.sockets).toHaveLength(2);
    await tick(100);
    expect(h.server.sockets).toHaveLength(3);

    const s = h.server.last;
    s.welcome();
    port.push('back\n');
    await tick(5);
    expect(s.of('port')).toMatchObject([{ port: { state: 'open' } }]);
    expect(s.of('log').map((m) => m.text)).toEqual(['while away\n', 'back\n']);
    expect(h.server.logText()).toBe('one\nwhile away\nback\n');

    // Welcomed again, the back-off starts over
    s.drop(1006);
    await tick(1050);
    expect(h.server.sockets).toHaveLength(4);
  });

  it('backs off long when another holder is connected, and says so', async () => {
    await started();
    h.server.last.drop(1006);
    await tick(1050);
    const s = h.server.last;
    s.accept();
    s.message({ t: 'refused', reason: 'another holder is connected' });
    s.drop(4001, 'another holder is connected');

    expect(server()).toBe('refused');
    expect(detail()).toContain('another holder is connected');
    await tick(59_000);
    expect(h.server.sockets).toHaveLength(2);
    await tick(2000);
    expect(h.server.sockets).toHaveLength(3);
  });

  it('stops on a protocol mismatch, and says to reload', async () => {
    await started();
    h.server.last.drop(1006);
    await tick(1050);
    const s = h.server.last;
    s.accept();
    s.message({ t: 'refused', reason: 'protocol 1 is not 2: reload the page' });
    s.drop(4002, 'protocol 1 is not 2: reload the page');

    expect(server()).toBe('stopped');
    expect(detail()).toContain('Reload the page');
    await tick(10 * 60_000);
    expect(h.server.sockets).toHaveLength(2);
  });

  it('gives up a socket the server has gone quiet on, and connects again', async () => {
    await started();
    const first = h.server.last;
    await until(() => h.server.sockets.length === 2, 70_000, 500);
    expect(first.closed).toBe(true);
    expect(server()).toBe('connecting');
  });

  it('keeps a socket the server pings', async () => {
    await started();
    for (let t = 0; t < 120_000; t += 20_000) {
      await tick(20_000);
      h.server.last.message({ t: 'ping', ts: t });
    }
    expect(h.server.sockets).toHaveLength(1);
    expect(h.server.last.of('pong')).toHaveLength(6);
  });
});
