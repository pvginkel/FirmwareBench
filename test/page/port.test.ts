// The port coming and going: lost and returned as the same object or a new one, a connect
// event that fired before anything waited for it, and a job that arrives while it is lost.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/shared/protocol.ts';
import { FakePort, fakeEsptool, imageFetch, started as start, tick, until, type Started } from './fakes.ts';

let h: Started;

async function started(opts: Parameters<typeof start>[0] = {}): Promise<Started> {
  h = await start(opts);
  return h;
}

const state = () => h.engine.status().port.state;
const reported = () => h.server.of('port').map((m) => m.port.state);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  await h.engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the port', () => {
  it('opens a port granted earlier on load, without a click, and clears DTR and RTS', async () => {
    await started();
    expect(h.port.opens).toBe(1);
    expect(h.port.baudRate).toBe(115200);
    expect(h.port.signals[0]).toMatchObject({ dataTerminalReady: false, requestToSend: false });
    expect(h.server.last.of('port')).toEqual([{ t: 'port', port: { state: 'open', usbVendorId: 0x303a, usbProductId: 0x1001 } }]);
  });

  it('reopens the same port object when it comes back', async () => {
    await started();
    h.port.push('before\n');
    await tick(5);
    h.serial.unplug(h.port);
    await until(() => state() === 'lost');

    // Back as the same object, which still counts as open: close, and open once more
    h.serial.plug(h.port);
    await until(() => state() === 'open');
    h.port.push('after\n');
    await tick(5);

    expect(h.server.logText()).toBe('before\nafter\n');
    expect(reported()).toEqual(['open', 'lost', 'open']);
    expect(h.port.opens).toBe(2);
  });

  it('opens the new port object the device comes back as', async () => {
    await started();
    h.serial.unplug(h.port);
    await until(() => state() === 'lost');

    const again = h.serial.plug(new FakePort());
    await until(() => state() === 'open');
    again.push('after\n');
    await tick(5);

    expect(again.opens).toBe(1);
    expect(h.server.logText()).toBe('after\n');
    expect(reported()).toEqual(['open', 'lost', 'open']);
  });

  it('finds a port that came back without a connect event, by polling getPorts()', async () => {
    await started();
    h.serial.unplug(h.port);
    await until(() => state() === 'lost');

    const again = h.serial.plug(new FakePort(), { event: false });
    await until(() => state() === 'open', 2000);
    expect(again.opens).toBe(1);
  });

  it('reads on after a non-fatal serial error', async () => {
    await started();
    h.port.push('one\n');
    await tick(5);
    h.port.fault('FramingError');
    await tick(5);
    h.port.push('two\n');
    await tick(5);

    expect(state()).toBe('open');
    expect(h.server.logText()).toBe('one\ntwo\n');
  });
});

describe('a job and the port', () => {
  const consoleJob = (line: string): Job => ({ kind: 'console', line });

  it('holds a job that arrives while the port is lost until it comes back', async () => {
    await started();
    h.serial.unplug(h.port);
    await until(() => state() === 'lost');

    h.server.last.message({ t: 'job', jobId: 'j1', job: consoleJob('heap') });
    await tick(3000);
    expect(h.server.results()).toEqual([]);

    const again = h.serial.plug(new FakePort(), { event: false });
    await until(() => h.server.results().length === 1);

    expect(h.server.results()[0]).toEqual({ t: 'result', jobId: 'j1', ok: true });
    expect(again.written).toBe('heap\r\n');
    expect(state()).toBe('open');
  });

  it('fails a job with port_not_open when the port stays away for 10 s', async () => {
    await started();
    h.serial.unplug(h.port);
    await until(() => state() === 'lost');

    h.server.last.message({ t: 'job', jobId: 'j1', job: consoleJob('heap') });
    await tick(9900);
    expect(h.server.results()).toEqual([]);
    await tick(200);

    expect(h.server.results()).toMatchObject([{ jobId: 'j1', ok: false, code: 'port_not_open' }]);
  });

  it('takes the port back from a connect event that fired before the wait began', async () => {
    // The reset into download mode drops the port, and it is back, with its connect event,
    // before esptool-js gives up. It is not in getPorts() yet, so only the event tells.
    const data = new Uint8Array(4096).fill(7);
    let returned: FakePort | null = null;
    const esptool = fakeEsptool({
      before: (_port, _mode, n) => {
        if (n !== 1) return;
        h.serial.unplug(h.port);
        returned = h.serial.plug(new FakePort(), { listed: false });
        throw new Error('Failed to connect with the device');
      },
    });
    await started({ connectEsptool: esptool.connect, fetch: imageFetch({ '/jobs/j1/images/0': data }) });
    const md5 = createHash('md5').update(data).digest('hex');
    const job: Job = {
      kind: 'flash',
      chip: 'esp32s3',
      flash: { mode: 'keep', freq: 'keep', size: 'keep' },
      images: [{ offset: 0x10000, name: 'app.bin', url: '/jobs/j1/images/0', size: data.length, md5 }],
    };
    h.server.last.message({ t: 'job', jobId: 'j1', job });
    await until(() => h.server.results().length === 1, 5000);

    expect(h.server.results()[0]).toMatchObject({ ok: true, chip: 'ESP32-S3' });
    expect(esptool.modes).toEqual(['default_reset', 'no_reset']);
    expect(returned).not.toBeNull();
    expect(returned!.rtsPulses()).toEqual([100]);
    expect(state()).toBe('open');
  });
});
