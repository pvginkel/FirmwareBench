// The parts of Web Serial the bench uses, and the clock it waits on. TypeScript's DOM
// library has no Web Serial types yet, and these narrow interfaces are also what the tests
// fake.

export interface PortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface PortSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  /** False once the device is off the bus. Undefined where the browser does not say. */
  readonly connected?: boolean;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: PortSignals): Promise<void>;
  getInfo(): PortInfo;
}

/** `navigator.serial`. Its `connect` and `disconnect` events carry the port as `target`. */
export interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
}

/** The port a `connect` or `disconnect` event is about. */
export function eventPort(event: Event): SerialPortLike {
  return event.target as unknown as SerialPortLike;
}

/** The firmware's console rate. USB-Serial-JTAG ignores it; a UART bridge does not. */
export const MONITOR_BAUD = 115200;

/** Errors after which a port hands out a new readable and reading can go on. */
export const NON_FATAL_READ_ERRORS = ['BufferOverrunError', 'FramingError', 'BreakError', 'ParityError'];

export function sameInfo(a: PortInfo, b: PortInfo): boolean {
  return a.usbVendorId !== undefined && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
}

/** A device that comes back after a reset or a replug can be a new SerialPort object. */
export function samePort(a: SerialPortLike, b: SerialPortLike): boolean {
  return a === b || sameInfo(a.getInfo(), b.getInfo());
}

export function errorName(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.name : '';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.message : String(e);
}

export interface Clock {
  now(): number;
  /** Runs `fn` after `ms`. The function it returns cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.after(ms, resolve));
}

/** RTS asserted for this long resets the S3 (design §9). */
export const RESET_PULSE_MS = 100;

/**
 * The reset that works on the board: RTS on, 100 ms, RTS off. esptool-js 0.7.1's own
 * `after('hard_reset')` resets nothing there. `setRts` must send DTR again after each RTS
 * change, as esptool-js's `Transport.setRTS` does: Windows' usbser.sys only passes an RTS
 * change on with a DTR change. `beforeRelease` runs at the end of the pulse, just before RTS
 * is released.
 */
export async function pulseRts(setRts: (on: boolean) => Promise<void>, clock: Clock, beforeRelease?: () => void): Promise<void> {
  await setRts(true);
  await sleep(clock, RESET_PULSE_MS);
  beforeRelease?.();
  await setRts(false);
}

/** `setRts` for a port the monitor has open: the same two signal writes as `Transport.setRTS`. */
export function portRts(port: SerialPortLike): (on: boolean) => Promise<void> {
  return async (on) => {
    await port.setSignals({ requestToSend: on });
    await port.setSignals({ dataTerminalReady: false });
  };
}
