// The jobs: a flash with esptool-js's real Transport and a fake chip, a wrong chip, an image
// that does not match its MD5, a reset by the RTS pulse, and a console line.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlashImage, Job } from '../../src/shared/protocol.ts';
import { fakeEsptool, imageFetch, started as start, tick, until, type FakeEsptool, type Started } from './fakes.ts';

let h: Started;

const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');
const bytes = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * seed + seed) & 0xff);

const BUILD = [
  { offset: 0x0, name: 'bootloader/bootloader.bin', data: bytes(0x5200, 3) },
  { offset: 0x8000, name: 'partition_table/partition-table.bin', data: bytes(0xc00, 5) },
  { offset: 0xd000, name: 'ota_data_initial.bin', data: bytes(0x2000, 7) },
  { offset: 0x10000, name: 'hello_world.bin', data: bytes(0x2d000, 11) },
];

function images(jobId: string): FlashImage[] {
  return BUILD.map((im, i) => ({ offset: im.offset, name: im.name, url: `/jobs/${jobId}/images/${i}`, size: im.data.length, md5: md5(im.data) }));
}

function served(jobId: string, change: (i: number, data: Uint8Array) => Uint8Array = (_i, d) => d) {
  return imageFetch(Object.fromEntries(BUILD.map((im, i) => [`/jobs/${jobId}/images/${i}`, change(i, im.data)])));
}

const flashJob = (jobId: string, chip = 'esp32s3'): Job => ({
  kind: 'flash',
  chip,
  flash: { mode: 'dio', freq: '80m', size: '2MB' },
  images: images(jobId),
});

async function run(jobId: string, job: Job) {
  h.server.last.message({ t: 'job', jobId, job });
  await until(() => h.server.results().some((r) => r.jobId === jobId));
  return h.server.results().find((r) => r.jobId === jobId);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  await h.engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a flash', () => {
  let esptool: FakeEsptool;

  beforeEach(async () => {
    esptool = fakeEsptool();
    h = await start({ connectEsptool: esptool.connect, fetch: served('j1') });
  });

  it('writes each image at its offset, compressed, never erasing, and resets into the firmware', async () => {
    const result = await run('j1', flashJob('j1'));

    expect(result).toEqual({ t: 'result', jobId: 'j1', ok: true, chip: 'ESP32-S3', mac: 'aa:bb:cc:dd:ee:ff' });
    expect(esptool.writes).toHaveLength(1);
    const w = esptool.writes[0]!;
    expect(w.fileArray.map((f) => [f.address, md5(f.data)])).toEqual(BUILD.map((im) => [im.offset, md5(im.data)]));
    expect(w.eraseAll).toBe(false);
    expect(w.compress).toBe(true);
    expect([w.flashMode, w.flashFreq, w.flashSize]).toEqual(['dio', '80m', '2MB']);
    const sample = bytes(1001, 13);
    expect(w.calculateMD5Hash?.(sample)).toBe(md5(sample));

    // One reset into the firmware, by the RTS pulse, at the monitor's rate
    expect(h.port.rtsPulses()).toEqual([100]);
    expect(h.port.baudRate).toBe(115200);
    const phases = h.server.of('progress').map((p) => p.phase);
    expect([...new Set(phases)]).toEqual(['connecting', 'writing', 'resetting', 'reopening']);
    expect(h.server.of('progress').filter((p) => p.phase === 'writing').map((p) => p.image)).toContain(3);
    expect(h.engine.status().port).toMatchObject({ state: 'open', chip: 'ESP32-S3', mac: 'aa:bb:cc:dd:ee:ff' });
  });

  it('passes the whole first boot to the log: what esptool-js read, then what the monitor reads', async () => {
    const boot = ['ESP-ROM:esp32s3-20210327\r\n', 'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n', 'I (31) boot: ESP-IDF v5.5\r\n', 'Hello world!\r\n'];
    h.port.onReset = () => {
      h.port.push(boot[0]!);
      setTimeout(() => h.port.push(boot[1]!), 1);
      setTimeout(() => h.port.push(boot[2]!), 30);
      setTimeout(() => h.port.push(boot[3]!), 400);
    };
    await run('j1', flashJob('j1'));
    await tick(500);

    expect(h.server.logText()).toBe(boot.join(''));
    // The first of it reached the log through esptool-js's buffer
    expect(new TextDecoder().decode(esptool.released[0])).toBe(boot[0]);
    // The port was never closed after the reset
    const opens = h.port.opens;
    h.port.push('later\n');
    await tick(5);
    expect(h.port.opens).toBe(opens);
    expect(h.server.logText().endsWith('Hello world!\r\nlater\n')).toBe(true);
  });

  it('logs only what the chip sends after the reset pulse, not a boot still on its way when the pulse began', async () => {
    // On the board, the reopen at the monitor's rate before the pulse starts a boot of its
    // own. Its lines are queued in the port's stream when the read loop starts, and more come
    // while RTS is held
    const stale = [
      'ESP-ROM:esp32s3-20210327\r\n',
      '        Usage          Type ST Offset   Length\r\n',
      'I (59) boot:  0 nvs              WiFi data        01 02 00009000 00006000\r\n',
      'I (109) esp_image: segment 3: paddr=00020020 vaddr=42000020 size=0f4b0h ( 62640) map\r\n',
    ];
    const boot = ['ESP-ROM:esp32s3-20210327\r\n', 'rst:0x15 (USB_UART_CHIP_RESET),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n', 'Hello world!\r\n'];
    const open = h.port.open.bind(h.port);
    h.port.open = async (options) => {
      await open(options);
      if (esptool.writes.length === 0 || options.baudRate !== 115200) return;
      h.port.push(stale[0]!);
      setTimeout(() => h.port.push(stale[1]!), 40);
      setTimeout(() => h.port.push(stale[2]!), 60);
      setTimeout(() => h.port.push(stale[3]!), 110);
    };
    h.port.onReset = () => {
      h.port.push(boot[0]!);
      setTimeout(() => h.port.push(boot[1]!), 1);
      setTimeout(() => h.port.push(boot[2]!), 400);
    };
    await run('j1', flashJob('j1'));
    await tick(500);

    expect(h.server.logText()).toBe(boot.join(''));
    expect(new TextDecoder().decode(esptool.released[0])).toBe(boot[0]);
  });

  it('writes nothing to another chip, and puts it back into its firmware', async () => {
    await h.engine.stop();
    esptool = fakeEsptool({ chip: 'ESP32' });
    h = await start({ connectEsptool: esptool.connect, fetch: served('j2') });

    const result = await run('j2', flashJob('j2'));

    expect(result).toMatchObject({ ok: false, code: 'wrong_chip', chip: 'ESP32' });
    expect(result).toHaveProperty('message', expect.stringMatching(/esp32s3.*ESP32.*nothing was written/));
    expect(esptool.writes).toEqual([]);
    expect(h.port.rtsPulses()).toEqual([100]);
    expect(h.engine.status().port.state).toBe('open');
  });

  it('refuses an image that does not match its MD5, before touching the port', async () => {
    await h.engine.stop();
    esptool = fakeEsptool();
    const tampered = served('j3', (i, d) => (i === 2 ? d.map((b, k) => (k === 100 ? b ^ 1 : b)) : d));
    h = await start({ connectEsptool: esptool.connect, fetch: tampered });

    const result = await run('j3', flashJob('j3'));

    expect(result).toMatchObject({ ok: false, code: 'flash_failed' });
    expect(result).toHaveProperty('message', expect.stringMatching(/ota_data_initial\.bin has MD5 .*nothing was written/));
    expect(esptool.modes).toEqual([]);
    expect(h.port.opens).toBe(1);
    expect(h.engine.status().port.state).toBe('open');
  });

  it('refuses an image of the wrong size', async () => {
    await h.engine.stop();
    esptool = fakeEsptool();
    h = await start({ connectEsptool: esptool.connect, fetch: served('j4', (i, d) => (i === 0 ? d.subarray(0, 100) : d)) });

    const result = await run('j4', flashJob('j4'));

    expect(result).toMatchObject({ ok: false, code: 'flash_failed' });
    expect(result).toHaveProperty('message', expect.stringContaining('came as 100 bytes'));
    expect(esptool.modes).toEqual([]);
  });

  it('flashes again after a flash: the monitor gives the handed-back port up cleanly', async () => {
    expect(await run('j1', flashJob('j1'))).toMatchObject({ ok: true });
    h.port.push('between\n');
    await tick(5);
    expect(await run('j1-again', flashJob('j1'))).toMatchObject({ ok: true });

    expect(esptool.writes).toHaveLength(2);
    expect(h.port.rtsPulses()).toEqual([100, 100]);
    expect(h.server.logText()).toBe('between\n');
    expect(h.engine.status().port.state).toBe('open');
  });

  it('answers busy to a job that comes while one runs', async () => {
    h.server.last.message({ t: 'job', jobId: 'j1', job: flashJob('j1') });
    h.server.last.message({ t: 'job', jobId: 'j9', job: { kind: 'reset' } });
    await until(() => h.server.results().length === 2);

    expect(h.server.results()).toMatchObject([
      { jobId: 'j9', ok: false, code: 'busy' },
      { jobId: 'j1', ok: true },
    ]);
  });
});

describe('a reset and a console line', () => {
  beforeEach(async () => {
    h = await start();
  });

  it('resets with a 100 ms RTS pulse while the monitor reads on', async () => {
    h.port.onReset = () => h.port.push('rst:0xc (RTC_SW_CPU_RST)\r\nHello world!\r\n');
    const before = h.port.signals.length;

    const result = await run('r1', { kind: 'reset' });

    expect(result).toEqual({ t: 'result', jobId: 'r1', ok: true });
    expect(h.port.rtsPulses()).toEqual([100]);
    // RTS, then DTR again, as esptool-js's Transport.setRTS does for Windows' usbser.sys
    expect(h.port.signals.slice(before).map(({ at: _at, ...s }) => s)).toEqual([
      { requestToSend: true },
      { dataTerminalReady: false },
      { requestToSend: false },
      { dataTerminalReady: false },
    ]);
    expect(h.port.opens).toBe(1);
    expect(h.server.logText()).toBe('rst:0xc (RTC_SW_CPU_RST)\r\nHello world!\r\n');
  });

  it('writes a console line with CR LF', async () => {
    const result = await run('c1', { kind: 'console', line: 'heap' });
    expect(result).toEqual({ t: 'result', jobId: 'c1', ok: true });
    expect(h.port.written).toBe('heap\r\n');
  });
});
