// A fake Web Serial, a fake server socket and a fake esptool-js for the page's tests,
// after the spike's fake.mjs, which drove the spike's engine in Chromium. The fake port
// behaves as Chrome's does where the engine depends on it:
// - cancelling the readable discards what it had queued, and the next `readable` is new;
// - closing a port with a locked stream fails;
// - a port object that comes back after a loss still counts as open until it is closed;
// - bytes the device sends while the port is closed are heard by no one.

import { vi } from 'vitest';
import type { FlashOptions } from 'esptool-js';
import { Engine } from '../../src/page/engine.ts';
import { EsptoolSession, ROM_BAUD, TransportHandle, flashBaud, type ConnectEsptool, type ConnectMode, type EspSession } from '../../src/page/esptool.ts';
import type { EngineMessage } from '../../src/page/messages.ts';
import { realClock, type PortInfo, type PortSignals, type SerialLike, type SerialPortLike } from '../../src/page/serial.ts';
import type { OpenSocket, SocketHandle, SocketHandlers } from '../../src/page/server-link.ts';
import type { HolderMessage, ServerMessage } from '../../src/shared/protocol.ts';

export const S3_INFO: PortInfo = { usbVendorId: 0x303a, usbProductId: 0x1001 };
/** A CH343 UART bridge, as on SonosDisplay. */
export const BRIDGE_INFO: PortInfo = { usbVendorId: 0x1a86, usbProductId: 0x55d3 };

const encoder = new TextEncoder();

export class FakePort implements SerialPortLike {
  connected = true;
  isOpen = false;
  /** Lost while open: it counts as open, and is dead, until it is closed. */
  stale = false;
  baudRate: number | undefined;
  opens = 0;
  /** Every setSignals() call, in order, with the fake time it came at. */
  readonly signals: (PortSignals & { at: number })[] = [];
  /** What the host wrote, as text. */
  written = '';
  /**
   * The chip resets, and boots on. The S3's own USB resets it as RTS is asserted, and it
   * boots while RTS is still held; a bridge's EN/IO0 circuit holds it in reset while RTS is
   * asserted, and it boots as RTS is released.
   */
  onReset: (() => void) | null = null;
  readonly resetOn: 'assert' | 'release';
  private readonly info: PortInfo;
  private stream: ReadableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private writableStream: WritableStream<Uint8Array> | null = null;
  private rts = false;

  constructor(info: PortInfo = S3_INFO) {
    this.info = info;
    this.resetOn = info.usbVendorId === S3_INFO.usbVendorId ? 'assert' : 'release';
  }

  getInfo(): PortInfo {
    return this.info;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.isOpen || this.stale || !this.connected) return null;
    if (!this.stream) {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          this.controller = c;
        },
        cancel: () => {
          // As in Chrome: what was queued is gone, and a task later the port lets go of
          // the stream, so the next `readable` is a new one
          setTimeout(() => {
            if (this.stream === stream) {
              this.stream = null;
              this.controller = null;
            }
          }, 0);
        },
      });
      this.stream = stream;
    }
    return this.stream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.isOpen && !this.stale && this.connected ? this.writableStream : null;
  }

  async open(options: { baudRate: number }): Promise<void> {
    if (this.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
    if (!this.connected) throw new DOMException('Failed to open serial port.', 'NetworkError');
    this.isOpen = true;
    this.opens++;
    this.baudRate = options.baudRate;
    this.writableStream = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written += new TextDecoder().decode(chunk);
      },
    });
  }

  async close(): Promise<void> {
    if (!this.isOpen) throw new DOMException('The port is already closed.', 'InvalidStateError');
    if (this.stream?.locked || this.writableStream?.locked) throw new TypeError('Cannot close a port with locked streams');
    this.isOpen = false;
    this.stale = false;
    this.stream = null;
    this.controller = null;
    this.writableStream = null;
  }

  async setSignals(signals: PortSignals): Promise<void> {
    if (!this.isOpen || this.stale) throw new DOMException('The port is closed.', 'InvalidStateError');
    this.signals.push({ ...signals, at: Date.now() });
    if (signals.requestToSend === true && !this.rts) {
      this.rts = true;
      if (this.resetOn === 'assert') this.onReset?.();
    }
    if (signals.requestToSend === false && this.rts) {
      this.rts = false;
      if (this.resetOn === 'release') this.onReset?.();
    }
  }

  /** The device sends. False when no one hears it. */
  push(data: string | Uint8Array): boolean {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (!this.readable || !this.controller) return false;
    try {
      this.controller.enqueue(bytes);
      return true;
    } catch {
      // A stream being cancelled takes nothing more
      return false;
    }
  }

  /** A serial error such as `FramingError`: the stream errors, and the next `readable` is new. */
  fault(name: string): void {
    const controller = this.controller;
    this.stream = null;
    this.controller = null;
    controller?.error(new DOMException(`A ${name} occurred`, name));
  }

  /** The device drops off the bus. */
  lose(): void {
    this.connected = false;
    if (this.isOpen) this.stale = true;
    try {
      this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'));
    } catch {
      // The stream was closed already
    }
    this.stream = null;
    this.controller = null;
    this.writableStream = null;
  }

  /** RTS on, then off, with the time between: the resets the port saw. */
  rtsPulses(): number[] {
    const pulses: number[] = [];
    let on: number | null = null;
    for (const s of this.signals) {
      if (s.requestToSend === true) on = s.at;
      if (s.requestToSend === false && on !== null) {
        pulses.push(s.at - on);
        on = null;
      }
    }
    return pulses;
  }
}

function portEvent(type: string, port: FakePort): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'target', { value: port });
  return event;
}

export class FakeSerial extends EventTarget implements SerialLike {
  ports: FakePort[] = [];

  async getPorts(): Promise<SerialPortLike[]> {
    return this.ports.filter((p) => p.connected);
  }

  /** The device drops off the bus: the port errors, leaves getPorts(), and `disconnect` fires. */
  unplug(port: FakePort): void {
    port.lose();
    this.ports = this.ports.filter((p) => p !== port);
    this.dispatchEvent(portEvent('disconnect', port));
  }

  /**
   * The device comes back, as the same object or a new one. `event: false` leaves out the
   * `connect` event, so only polling getPorts() finds it; `listed: false` leaves it out of
   * getPorts(), so only the event announces it.
   */
  plug(port: FakePort, opts: { event?: boolean; listed?: boolean } = {}): FakePort {
    port.connected = true;
    if (opts.listed ?? true) this.ports.push(port);
    if (opts.event ?? true) this.dispatchEvent(portEvent('connect', port));
    return port;
  }
}

export class FakeSocket implements SocketHandle {
  readonly url: string;
  readonly sent: HolderMessage[] = [];
  closed = false;
  private readonly handlers: SocketHandlers;

  constructor(url: string, handlers: SocketHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as HolderMessage);
  }

  close(): void {
    this.closed = true;
  }

  /** The server side: the upgrade succeeds. */
  accept(): void {
    this.handlers.open();
  }

  /** Accepts, and welcomes the holder once it says hello. */
  welcome(): void {
    this.accept();
    this.message({ t: 'welcome', protocol: 1 });
  }

  message(msg: ServerMessage): void {
    this.handlers.message(JSON.stringify(msg));
  }

  drop(code = 1006, reason = ''): void {
    this.handlers.close(code, reason);
  }

  of<T extends HolderMessage['t']>(t: T): Extract<HolderMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<HolderMessage, { t: T }> => m.t === t);
  }
}

export class FakeServer {
  readonly sockets: FakeSocket[] = [];

  readonly open: OpenSocket = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    this.sockets.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }

  /** Everything the holder sent of one kind, over every socket. */
  of<T extends HolderMessage['t']>(t: T): Extract<HolderMessage, { t: T }>[] {
    return this.sockets.flatMap((s) => s.of(t));
  }

  logText(): string {
    return this.of('log')
      .map((m) => m.text)
      .join('');
  }

  results(): Extract<HolderMessage, { t: 'result' }>[] {
    return this.of('result');
  }
}

export interface FakeEsptool {
  connect: ConnectEsptool;
  /** The modes main() was called with. */
  modes: ConnectMode[];
  /** What writeFlash() was given. */
  writes: FlashOptions[];
  /** The rate esptool-js's Transport was at for each writeFlash(). */
  writeBauds: number[];
  /** What each session's release() handed back. */
  released: Uint8Array[];
}

/**
 * esptool-js with the real Transport over the fake port, and a fake chip behind it.
 * connect() does what ESPLoader.main() does to the port: open at the ROM rate, start the
 * read loop, then, when the flash rate is another, the baud change, which closes and reopens
 * it. `before` runs first in each connect, to make one fail; `afterWrite` runs as each
 * writeFlash() ends.
 */
export function fakeEsptool(
  opts: {
    chip?: string;
    mac?: string;
    before?: (port: SerialPortLike, mode: ConnectMode, n: number) => void;
    afterWrite?: (port: SerialPortLike) => void;
  } = {},
): FakeEsptool {
  const writes: FlashOptions[] = [];
  const writeBauds: number[] = [];
  const released: Uint8Array[] = [];
  const modes: ConnectMode[] = [];
  const connect: ConnectEsptool = async (port, mode) => {
    const n = modes.push(mode);
    opts.before?.(port, mode, n);
    const transport = new TransportHandle(port);
    await transport.raw.connect(ROM_BAUD);
    void transport.raw.readLoop();
    const baud = flashBaud(port);
    if (baud !== ROM_BAUD) await transport.raw.changeBaudrate(baud);
    const loader = {
      writeFlash: async (o: FlashOptions) => {
        writes.push(o);
        writeBauds.push(transport.raw.baudrate);
        o.fileArray.forEach((f, i) => {
          o.reportProgress?.(i, 0, f.data.length);
          o.reportProgress?.(i, f.data.length, f.data.length);
        });
        opts.afterWrite?.(port);
      },
    };
    const session: EspSession = new EsptoolSession(transport, loader, opts.chip ?? 'ESP32-S3', opts.mac ?? 'aa:bb:cc:dd:ee:ff');
    const release = session.release.bind(session);
    session.release = async () => {
      const bytes = await release();
      released.push(bytes);
      return bytes;
    };
    return session;
  };
  return { connect, modes, writes, writeBauds, released };
}

/** fetch() for the job's images, by URL. */
export function imageFetch(images: Record<string, Uint8Array>): (url: string) => Promise<Response> {
  return async (url) => {
    const data = images[url];
    return data ? new Response(data.slice()) : new Response('not found', { status: 404 });
  };
}

export interface Harness {
  serial: FakeSerial;
  server: FakeServer;
  engine: Engine;
  page: EngineMessage[];
}

export function harness(opts: { connectEsptool?: ConnectEsptool; fetch?: (url: string) => Promise<Response> } = {}): Harness {
  const serial = new FakeSerial();
  const server = new FakeServer();
  const page: EngineMessage[] = [];
  const engine = new Engine({
    serial,
    openSocket: server.open,
    connectEsptool: opts.connectEsptool ?? fakeEsptool().connect,
    fetch: opts.fetch ?? imageFetch({}),
    clock: realClock,
    location: { protocol: 'https:', host: 'bench.example' },
    context: 'test',
    toPage: (m) => page.push(m),
  });
  return { serial, server, engine, page };
}

export interface Started extends Harness {
  port: FakePort;
}

/** A holder that is welcomed, with a port granted earlier and open: the S3's own USB, unless `info` says otherwise. */
export async function started(opts: Parameters<typeof harness>[0] & { info?: PortInfo } = {}): Promise<Started> {
  const h = harness(opts);
  const port = new FakePort(opts.info);
  h.serial.ports.push(port);
  await h.engine.start();
  h.server.last.welcome();
  await until(() => h.engine.status().port.state === 'open');
  return { ...h, port };
}

/** Advances fake time in small steps until `cond` holds. */
export async function until(cond: () => boolean, maxMs = 60_000, stepMs = 10): Promise<void> {
  for (let t = 0; !cond(); t += stepMs) {
    if (t > maxMs) throw new Error(`still waiting after ${maxMs} ms of fake time`);
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

export function tick(ms: number): Promise<void> {
  return vi.advanceTimersByTimeAsync(ms).then(() => undefined);
}
