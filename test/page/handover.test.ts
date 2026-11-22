// The first-boot handover, on esptool-js's real Transport over the fake port: after the
// reset, what esptool-js read goes to the log, and the monitor reads on from the next
// byte, with nothing lost and nothing twice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportHandle } from '../../src/page/esptool.ts';
import { FakePort, tick } from './fakes.ts';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Reads the port as the monitor does, until stopped. */
function monitor(port: FakePort): { text: () => string; stop: () => Promise<void> } {
  const readable = port.readable;
  if (!readable) throw new Error('the port has no readable');
  const reader = readable.getReader();
  let text = '';
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decode(value);
    }
  })();
  return {
    text: () => text,
    stop: async () => {
      await reader.cancel();
      await done;
      reader.releaseLock();
    },
  };
}

async function esptoolReading(port: FakePort): Promise<TransportHandle> {
  const handle = new TransportHandle(port);
  await handle.raw.connect(115200);
  void handle.raw.readLoop();
  return handle;
}

describe('TransportHandle.release', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends a read still pending, and leaves the port open and unlocked', async () => {
    const port = new FakePort();
    const handle = await esptoolReading(port);
    await tick(5);

    expect(decode(await handle.release())).toBe('');
    expect(port.isOpen).toBe(true);
    expect(port.readable?.locked).toBe(false);

    const m = monitor(port);
    port.push('rst:0x1 (POWERON)\n');
    await tick(5);
    expect(m.text()).toBe('rst:0x1 (POWERON)\n');
    await m.stop();
  });

  it('hands over what esptool-js read, and the monitor reads on from the next byte', async () => {
    const port = new FakePort();
    const handle = await esptoolReading(port);
    port.push('ESP-ROM:esp32s3\n');
    await tick(1);
    port.push('rst:0x1\n');
    await tick(1);
    // Handed to the pending read, which has not appended it yet, and one more queued behind it
    port.push('boot:0x8\n');
    port.push('load:0x3fce\n');
    const early = decode(await handle.release());
    port.push('I (31) boot: ESP-IDF\n');

    const m = monitor(port);
    await tick(5);
    port.push('Hello world!\n');
    await tick(5);

    expect(early).toBe('ESP-ROM:esp32s3\nrst:0x1\nboot:0x8\n');
    expect(m.text()).toBe('load:0x3fce\nI (31) boot: ESP-IDF\nHello world!\n');
    await m.stop();
  });

  it('works on the read loop esptool-js restarts on a baud change', async () => {
    const port = new FakePort();
    const handle = await esptoolReading(port);
    const change = handle.raw.changeBaudrate(460800);
    await tick(200);
    await change;
    expect(port.baudRate).toBe(460800);
    port.push('after the change\n');
    await tick(1);

    expect(decode(await handle.release())).toBe('after the change\n');
    expect(port.readable?.locked).toBe(false);
  });

  it('makes disconnect() a no-op once the monitor has the port', async () => {
    const port = new FakePort();
    const handle = await esptoolReading(port);
    await handle.release();
    const m = monitor(port);
    await handle.disconnect();
    expect(port.isOpen).toBe(true);
    port.push('still reading\n');
    await tick(5);
    expect(m.text()).toBe('still reading\n');
    await m.stop();
  });

  // Why the handover does not close and reopen: cancelling the stream drops what it queued
  it('is needed: disconnect() and a reopen lose what the port had queued', async () => {
    const port = new FakePort();
    const handle = await esptoolReading(port);
    port.push('first\n');
    port.push('second\n');
    const disconnect = handle.raw.disconnect();
    await tick(500);
    await disconnect;
    await port.open({ baudRate: 115200 });
    const m = monitor(port);
    await tick(5);

    expect(decode(handle.raw.peek())).toBe('first\n');
    expect(m.text()).toBe('');
    await m.stop();
  });
});
