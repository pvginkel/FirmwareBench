// The messages between a holder and the server, over one WebSocket.
//
// A holder holds the device's serial port. It connects, takes jobs one at a time, and
// reports the port's state, everything the device prints, and each job's result. The page
// is the first holder; anything that speaks these messages can replace it, and the agent
// API does not change. Every message is one JSON text frame.

export const PROTOCOL_VERSION = 1;

/** The WebSocket path a holder connects to, on the page port. */
export const HOLDER_PATH = '/holder';

/**
 * - `none`: no port has been granted, or the holder has not said yet.
 * - `open`: open, and the holder is reading it.
 * - `lost`: the device dropped off the bus. A reset of a native-USB chip does this, and
 *   the holder reopens the port when it comes back.
 * - `closed`: granted but not open, because opening it failed.
 */
export type PortState = 'none' | 'open' | 'lost' | 'closed';

export interface PortReport {
  state: PortState;
  usbVendorId?: number;
  usbProductId?: number;
  /** As esptool-js names it, once the holder has connected to the chip: `ESP32-S3`. */
  chip?: string;
  mac?: string;
}

/** One image of a build, written at its own offset. */
export interface FlashImage {
  offset: number;
  /** The path `flasher_args.json` gives, for messages. */
  name: string;
  /** Where the holder fetches it, relative to the page's origin. */
  url: string;
  size: number;
  /** MD5 of the image as served, so the holder can check the download. */
  md5: string;
}

export type Job =
  /**
   * `chip` is the build's IDF target (`esp32s3`); nothing is written to another chip.
   * `flash` holds the build's flash mode, frequency and size, as `flasher_args.json` gives them.
   */
  | { kind: 'flash'; chip: string; flash: { mode: string; freq: string; size: string }; images: FlashImage[] }
  /** A hard reset into the firmware. The result comes once the port is open again. */
  | { kind: 'reset' }
  /** Writes `line` and a line ending to the device. */
  | { kind: 'console'; line: string };

export type JobKind = Job['kind'];

export type JobPhase = 'connecting' | 'writing' | 'resetting' | 'reopening';

/** Why a holder could not do a job. The server maps these onto the agent API's codes. */
export type HolderErrorCode = 'port_not_open' | 'wrong_chip' | 'flash_failed' | 'reset_failed' | 'console_failed' | 'busy';

export type JobResult =
  | { ok: true; chip?: string; mac?: string }
  | { ok: false; code: HolderErrorCode; message: string; chip?: string };

/** Holder to server. */
export type HolderMessage =
  | { t: 'hello'; protocol: number; holder: string; userAgent?: string }
  | { t: 'port'; port: PortReport }
  /** Device output, as text, in the order it was read. Lines are the server's business. */
  | { t: 'log'; text: string }
  | { t: 'progress'; jobId: string; phase: JobPhase; image?: number; written?: number; total?: number }
  | ({ t: 'result'; jobId: string } & JobResult)
  | { t: 'pong'; ts: number };

/** Server to holder. */
export type ServerMessage =
  | { t: 'welcome'; protocol: number }
  /** Sent before the server closes the socket: another holder is connected, or the protocol differs. */
  | { t: 'refused'; reason: string }
  | { t: 'job'; jobId: string; job: Job }
  | { t: 'ping'; ts: number };

/** WebSocket close codes the server uses when it turns a holder away. */
export const CLOSE_ANOTHER_HOLDER = 4001;
export const CLOSE_PROTOCOL_MISMATCH = 4002;
export const CLOSE_NO_HELLO = 4003;
export const CLOSE_STALE = 4004;

/** IDF target name for esptool-js's chip name: `ESP32-S3` is `esp32s3`. */
export function idfTarget(chipName: string): string {
  return chipName.toLowerCase().replace(/[^a-z0-9]/g, '');
}
