// esptool-js 0.7.1 behind the narrow interface the engine uses: connect to the chip's
// bootloader, write images, reset into the firmware, and hand the open port back.

import { ESPLoader, Transport } from 'esptool-js';
import type { Before, FlashFreqValues, FlashModeValues, FlashOptions, FlashSizeValues, IEspLoaderTerminal } from 'esptool-js';
import { md5hex } from './md5.ts';
import { MONITOR_BAUD, pulseRts, sleep, type Clock, type SerialPortLike } from './serial.ts';

export const ROM_BAUD = 115200;
/** Behind a UART bridge. */
export const FLASH_BAUD = 460800;
/** USB vendor of the chip's own USB: USB-Serial-JTAG, or USB-OTG. */
export const ESPRESSIF_VID = 0x303a;
/** Before the reset on the chip's own USB: how long the port has to be quiet, and the longest wait for it. */
export const DRAIN_QUIET_MS = 20;
export const DRAIN_MAX_MS = 300;

/** The port is the chip's own USB, not a UART bridge. */
export function nativeUsb(port: SerialPortLike): boolean {
  return port.getInfo().usbVendorId === ESPRESSIF_VID;
}

/**
 * The rate to flash at. The chip's own USB ignores the rate, and esptool-js changes it by
 * closing and reopening the port, which starts a boot of its own on the S3. So there the
 * flash stays at the ROM's rate, and esptool-js changes nothing.
 */
export function flashBaud(port: SerialPortLike): number {
  return nativeUsb(port) ? ROM_BAUD : FLASH_BAUD;
}

export type ConnectMode = Before;
export type Terminal = IEspLoaderTerminal;

export interface FlashFile {
  address: number;
  data: Uint8Array;
}

/** As `flasher_args.json` gives them, or `keep`. */
export interface FlashSettings {
  mode: string;
  freq: string;
  size: string;
}

/** One connection to the chip's bootloader. */
export interface EspSession {
  /** As esptool-js names it: `ESP32-S3`. */
  readonly chip: string;
  readonly mac: string;
  writeFlash(files: FlashFile[], settings: FlashSettings, progress: (file: number, written: number, total: number) => void): Promise<void>;
  /** Resets the chip into its firmware with the RTS pulse, while esptool-js still reads the port. */
  hardReset(clock: Clock): Promise<void>;
  /**
   * Stops esptool-js reading and returns what it read but did not consume: the start of the
   * first boot. The port stays open with its stream unlocked, for the monitor to read on.
   */
  release(): Promise<Uint8Array>;
  /** Closes the port. Does nothing after `release()`. */
  disconnect(): Promise<void>;
}

/**
 * Connects through `main(mode)`: the reset into download mode (unless `no_reset`), sync,
 * chip detection, the stub and the baud change. Closes the port again when it fails.
 */
export type ConnectEsptool = (port: SerialPortLike, mode: ConnectMode, terminal: Terminal) => Promise<EspSession>;

/** What a session needs of `ESPLoader`, so a test can stand in for the chip. */
export interface LoaderLike {
  writeFlash(options: FlashOptions): Promise<void>;
}

/** The fields of esptool-js 0.7.1's Transport that `release()` works on. */
interface TransportInternals {
  device: unknown;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

/** esptool-js's Transport over a port, with the handover the bench needs. */
export class TransportHandle {
  readonly port: SerialPortLike;
  readonly raw: Transport;
  private loop: Promise<void> = Promise.resolve();
  private released = false;

  constructor(port: SerialPortLike) {
    this.port = port;
    this.raw = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0], false);
    // Keep each read loop esptool-js starts (on connect, and again on a baud change), so
    // release() can wait for the last one to end
    const readLoop = this.raw.readLoop.bind(this.raw);
    this.raw.readLoop = () => (this.loop = readLoop());
  }

  /**
   * Transport.readLoop() reads one chunk at a time through the reader it keeps in `reader`,
   * appends it to its buffer, and goes on while `device.readable` is set. disconnect()
   * cancels that reader, and cancelling a Web Serial stream discards what the OS has
   * buffered. So instead:
   * - the loop is pointed at a device without a readable, so it stops at its next turn,
   *   after appending a chunk it was already handed;
   * - the reader's lock is released, which rejects a read still pending without touching
   *   the stream, and the loop ends on that error.
   * Every byte the loop took is then in the buffer, and every later byte is still in the
   * port's stream, which the monitor reads next.
   */
  async release(): Promise<Uint8Array> {
    if (this.released) return new Uint8Array(0);
    this.released = true;
    const t = this.raw as unknown as TransportInternals;
    const device = t.device;
    t.device = { readable: null };
    t.reader?.releaseLock();
    await this.loop;
    t.device = device;
    const bytes = this.raw.peek().slice();
    this.raw.flushInput();
    return bytes;
  }

  async disconnect(): Promise<void> {
    if (!this.released) await this.raw.disconnect();
  }
}

export class EsptoolSession implements EspSession {
  readonly chip: string;
  readonly mac: string;
  private readonly transport: TransportHandle;
  private readonly loader: LoaderLike;

  constructor(transport: TransportHandle, loader: LoaderLike, chip: string, mac: string) {
    this.transport = transport;
    this.loader = loader;
    this.chip = chip;
    this.mac = mac;
  }

  writeFlash(files: FlashFile[], settings: FlashSettings, progress: (file: number, written: number, total: number) => void): Promise<void> {
    return this.loader.writeFlash({
      fileArray: files.map((f) => ({ data: f.data, address: f.address })),
      flashMode: settings.mode as FlashModeValues,
      flashFreq: settings.freq as FlashFreqValues,
      flashSize: settings.size as FlashSizeValues,
      // Never erase the whole flash: that would take the provisioned nvs partition with it
      eraseAll: false,
      compress: true,
      calculateMD5Hash: md5hex,
      reportProgress: progress,
    });
  }

  /**
   * Nothing read before the reset is the first boot: not what the stub sent, and not a boot
   * a reopen may start. flushInput() only drops what the read loop has taken in, so when to
   * call it depends on when the chip boots:
   * - the chip's own USB resets it as RTS is asserted, and it boots while RTS is still held.
   *   What the stub sent is drained first, until the port is quiet;
   * - a bridge's EN/IO0 circuit holds the chip in reset while RTS is asserted, and it boots
   *   as RTS is released. The buffer is emptied just before the release, when the read loop
   *   has had the pulse's 100 ms to take in everything sent before the reset, a boot the
   *   reopen at the monitor's rate started included.
   */
  async hardReset(clock: Clock): Promise<void> {
    const raw = this.transport.raw;
    if (nativeUsb(this.transport.port)) {
      await drainInput(raw, clock);
      await pulseRts((on) => raw.setRTS(on), clock);
      return;
    }
    // The boot has to be read at the firmware's rate
    if (raw.baudrate !== MONITOR_BAUD) await raw.changeBaudrate(MONITOR_BAUD);
    await pulseRts((on) => raw.setRTS(on), clock, () => raw.flushInput());
  }

  release(): Promise<Uint8Array> {
    return this.transport.release();
  }

  disconnect(): Promise<void> {
    return this.transport.disconnect();
  }
}

/**
 * Waits until the read loop has taken in nothing for `DRAIN_QUIET_MS`, or `DRAIN_MAX_MS`
 * have passed, and drops what it took in. esptool-js's own drainInput() waits 100 ms of
 * quiet, on the wall clock.
 */
async function drainInput(raw: Transport, clock: Clock): Promise<void> {
  const deadline = clock.now() + DRAIN_MAX_MS;
  let seen = -1;
  while (raw.inWaiting() !== seen && clock.now() < deadline) {
    seen = raw.inWaiting();
    await sleep(clock, DRAIN_QUIET_MS);
  }
  raw.flushInput();
}

export const connectEsptool: ConnectEsptool = async (port, mode, terminal) => {
  const transport = new TransportHandle(port);
  // main() changes the rate after the stub only when the two differ
  const loader = new ESPLoader({ transport: transport.raw, baudrate: flashBaud(port), romBaudrate: ROM_BAUD, terminal });
  try {
    await loader.main(mode);
    const mac = await loader.chip.readMac(loader);
    return new EsptoolSession(transport, loader, loader.chip.CHIP_NAME, mac);
  } catch (e) {
    await transport.disconnect().catch(() => undefined);
    throw e;
  }
};
