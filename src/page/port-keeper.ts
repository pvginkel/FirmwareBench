// The device's serial port: which one the holder has, whether it is open, the monitor that
// reads it between jobs, and getting it back without a click after the device drops off
// the bus. Unplugging and the board's RESET button drop it; it comes back as a new
// SerialPort object with the grant intact (design §9).

import type { PortReport, PortState } from '../shared/protocol.ts';
import {
  MONITOR_BAUD,
  NON_FATAL_READ_ERRORS,
  errorMessage,
  errorName,
  eventPort,
  sameInfo,
  samePort,
  sleep,
  type Clock,
  type PortInfo,
  type SerialLike,
  type SerialPortLike,
} from './serial.ts';

export interface PortKeeperEvents {
  /** The state, the chip or the MAC changed. */
  changed(): void;
  /** Device output, in the order it was read. */
  bytes(data: Uint8Array): void;
  note(text: string): void;
}

/** How often a wait for the port polls `getPorts()`, in case no `connect` event comes. */
const POLL_MS = 500;
/** How long a port that has just come back is left alone before it is used. */
const SETTLE_MS = 300;

interface Monitor {
  port: SerialPortLike;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  stopping: boolean;
  done: Promise<void>;
}

/** Opens a port. One that came back after a loss can still count as open: close, and once more. */
async function openPort(port: SerialPortLike): Promise<void> {
  try {
    await port.open({ baudRate: MONITOR_BAUD });
  } catch (e) {
    if (errorName(e) !== 'InvalidStateError') throw e;
    try {
      await port.close();
    } catch {
      // It was not open after all
    }
    await port.open({ baudRate: MONITOR_BAUD });
  }
}

export class PortKeeper {
  private readonly serial: SerialLike;
  private readonly clock: Clock;
  private readonly events: PortKeeperEvents;
  private current: SerialPortLike | null = null;
  private stateValue: PortState = 'none';
  private chip?: string;
  private mac?: string;
  /** A job holds the port, and the keeper leaves reopening it to the job. */
  private busy = false;
  private stopped = false;
  /**
   * Losses and returns in the order they happened. A `connect` event can come before
   * anything waits for it, so a wait first looks for a return after the latest loss.
   */
  private seq = 0;
  private lostSeq = 0;
  private lastConnect: { seq: number; port: SerialPortLike } | null = null;
  private readonly backWaiters = new Set<(port: SerialPortLike) => void>();
  private opening: Promise<void> | null = null;
  private monitor: Monitor | null = null;
  private recovering = false;

  constructor(serial: SerialLike, clock: Clock, events: PortKeeperEvents) {
    this.serial = serial;
    this.clock = clock;
    this.events = events;
  }

  get port(): SerialPortLike | null {
    return this.current;
  }

  get state(): PortState {
    return this.stateValue;
  }

  get monitoring(): boolean {
    return this.monitor !== null;
  }

  report(): PortReport {
    const info = this.current?.getInfo() ?? {};
    return { state: this.stateValue, usbVendorId: info.usbVendorId, usbProductId: info.usbProductId, chip: this.chip, mac: this.mac };
  }

  /** Listens for the port coming and going, and opens a port granted earlier, without a click. */
  async start(): Promise<void> {
    this.serial.addEventListener('connect', this.onConnect);
    this.serial.addEventListener('disconnect', this.onDisconnect);
    if (await this.pickUp()) await this.openMonitor('page load').catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.serial.removeEventListener('connect', this.onConnect);
    this.serial.removeEventListener('disconnect', this.onDisconnect);
    await this.endMonitor();
  }

  /** The operator chose a port with `requestPort()`. */
  async choose(info: PortInfo): Promise<void> {
    if (this.busy) {
      this.events.note('a job is running: choose the port again when it is done');
      return;
    }
    const ports = (await this.serial.getPorts()).filter((p) => p.connected !== false);
    const pick = ports.find((p) => sameInfo(p.getInfo(), info)) ?? ports[0];
    if (!pick) {
      this.events.note('the chosen port is not among the granted ports');
      return;
    }
    if (this.current && samePort(pick, this.current) && this.monitor && this.stateValue === 'open') return;
    await this.stopMonitor();
    if (!this.current || !samePort(pick, this.current)) {
      this.chip = undefined;
      this.mac = undefined;
    }
    this.current = pick;
    await this.openMonitor('chosen').catch(() => undefined);
  }

  setChip(chip: string, mac: string): void {
    this.chip = chip;
    this.mac = mac;
    this.events.changed();
  }

  /** For a job: the port open and read, waiting up to `waitMs` for a port that is lost. */
  async ensureOpen(waitMs: number): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    if (this.monitor && this.stateValue === 'open') return;
    if (!this.current) await this.pickUp();
    if (!this.current) throw new Error('no port has been chosen');
    if (this.stateValue === 'lost') {
      const back = await this.waitBack(waitMs);
      if (!back) throw new Error(`the port is lost, and did not come back within ${waitMs / 1000} s`);
      this.current = back;
      await sleep(this.clock, SETTLE_MS);
    }
    await this.openMonitor('job');
    if (!this.monitor) throw new Error('the port did not open');
  }

  beginJob(): void {
    this.busy = true;
  }

  /** After a job: reopens the port if the job left it closed, or goes on waiting for it. */
  async endJob(): Promise<void> {
    this.busy = false;
    if (this.stopped) return;
    if (this.stateValue === 'lost') void this.recover();
    else if (!this.monitor && this.current) await this.openMonitor('after the job').catch(() => undefined);
  }

  /** A point in the port's history, for `lostSince()`. */
  mark(): number {
    return this.seq;
  }

  lostSince(mark: number): boolean {
    return this.stateValue === 'lost' && this.lostSeq > mark;
  }

  /** The port to use from here on: the object that came back after a loss. */
  use(port: SerialPortLike): void {
    this.current = port;
  }

  /**
   * Waits for the port to come back after a loss: a `connect` event since the loss, or
   * `getPorts()` polled for a matching port that is connected. Null when `timeoutMs` passes.
   */
  waitBack(timeoutMs: number): Promise<SerialPortLike | null> {
    const lc = this.lastConnect;
    if (lc && lc.seq > this.lostSeq) return Promise.resolve(lc.port);
    return new Promise((resolve) => {
      let finished = false;
      let cancelPoll = (): void => undefined;
      let cancelTimeout = (): void => undefined;
      const finish = (port: SerialPortLike | null): void => {
        if (finished) return;
        finished = true;
        this.backWaiters.delete(finish);
        cancelTimeout();
        cancelPoll();
        resolve(port);
      };
      const poll = (): void => {
        cancelPoll = this.clock.after(POLL_MS, () => {
          void this.findReturned().then((port) => {
            if (port) finish(port);
            else if (!finished) poll();
          });
        });
      };
      cancelTimeout = this.clock.after(timeoutMs, () => finish(null));
      this.backWaiters.add(finish);
      poll();
    });
  }

  /** Opens the port and starts the monitor. Calls that overlap share one attempt. */
  openMonitor(reason: string): Promise<void> {
    this.opening ??= this.doOpen(reason).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** Stops the monitor and closes the port, for esptool-js to open it. */
  async stopMonitor(): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    await this.endMonitor();
  }

  /** Reads a port that is open already: the one esptool-js hands back after a flash. */
  startMonitor(port: SerialPortLike): void {
    this.current = port;
    const m: Monitor = { port, reader: null, stopping: false, done: Promise.resolve() };
    this.monitor = m;
    this.setState('open');
    m.done = this.read(m).then(() => {
      if (this.monitor === m) this.monitor = null;
      if (!m.stopping && this.stateValue === 'open') this.lose();
    });
  }

  async write(data: Uint8Array): Promise<void> {
    const writable = this.monitor ? this.monitor.port.writable : null;
    if (!writable) throw new Error('the port is not open');
    const writer = writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  private readonly onDisconnect = (event: Event): void => {
    const port = eventPort(event);
    if (this.current && samePort(port, this.current)) this.lose();
  };

  private readonly onConnect = (event: Event): void => {
    const port = eventPort(event);
    if (this.current && !samePort(port, this.current)) return;
    this.lastConnect = { seq: ++this.seq, port };
    for (const waiter of [...this.backWaiters]) waiter(port);
    if (this.busy || this.stateValue === 'open') return;
    if (this.stateValue === 'lost') {
      void this.recover();
    } else {
      this.current = port;
      void this.openMonitor('connect').catch(() => undefined);
    }
  };

  private lose(): void {
    if (this.stateValue === 'lost') return;
    this.events.note('port lost');
    this.markLost();
  }

  /** Records a loss: a return from before it no longer counts. */
  private markLost(): void {
    this.lostSeq = ++this.seq;
    this.setState('lost');
    if (!this.busy) void this.recover();
  }

  /** Reopens a lost port when it comes back, while no job holds it. */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      while (this.stateValue === 'lost' && !this.busy && !this.stopped) {
        const back = await this.waitBack(60_000);
        if (!back || this.busy || this.stopped || this.stateValue !== 'lost') continue;
        this.current = back;
        await this.openMonitor('returned').catch(() => undefined);
      }
    } finally {
      this.recovering = false;
    }
  }

  /** Takes a granted port when the keeper has none: one that is connected, else the first. */
  private async pickUp(): Promise<SerialPortLike | null> {
    const ports = await this.serial.getPorts();
    const pick = ports.find((p) => p.connected !== false) ?? ports[0];
    if (!pick) {
      this.setState('none');
      return null;
    }
    this.current = pick;
    if (pick.connected === false) {
      this.lose();
      return null;
    }
    return pick;
  }

  private async findReturned(): Promise<SerialPortLike | null> {
    try {
      const ports = await this.serial.getPorts();
      return ports.find((p) => p.connected === true && (!this.current || samePort(p, this.current))) ?? null;
    } catch {
      return null;
    }
  }

  private async doOpen(reason: string): Promise<void> {
    if (this.monitor && this.stateValue === 'open') return;
    // A monitor still on a port that was lost ends with that port's stream
    await this.endMonitor();
    const port = this.current ?? (await this.pickUp());
    if (!port) return;
    try {
      await openPort(port);
    } catch (e) {
      this.events.note(`could not open the port (${reason}): ${errorMessage(e)}`);
      if (port.connected === false) this.markLost();
      else this.setState('closed');
      throw e;
    }
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (e) {
      this.events.note(`could not clear DTR and RTS: ${errorMessage(e)}`);
    }
    this.startMonitor(port);
  }

  private async read(m: Monitor): Promise<void> {
    while (!m.stopping) {
      const readable = m.port.readable;
      if (!readable) return;
      const reader = readable.getReader();
      m.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value?.length) this.events.bytes(value);
        }
      } catch (e) {
        if (m.stopping) return;
        if (!NON_FATAL_READ_ERRORS.includes(errorName(e))) {
          if (errorName(e) !== 'NetworkError') this.events.note(`the port stopped reading: ${errorMessage(e)}`);
          return;
        }
        this.events.note(`serial ${errorName(e)}, reading on`);
      } finally {
        reader.releaseLock();
      }
    }
  }

  private async endMonitor(): Promise<void> {
    const m = this.monitor;
    if (!m) return;
    m.stopping = true;
    try {
      await m.reader?.cancel();
    } catch {
      // The stream is gone with the device
    }
    await m.done;
    if (this.monitor === m) this.monitor = null;
    try {
      await m.port.close();
    } catch {
      // Lost, or closed already
    }
  }

  private setState(state: PortState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.events.changed();
  }
}
