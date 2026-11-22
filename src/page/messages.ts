// The messages between the page and the engine, which runs in the worker (or, without Web
// Serial in workers, on the page itself).

import type { JobKind, JobPhase, PortReport } from '../shared/protocol.ts';
import type { PortInfo } from './serial.ts';

export type ServerState =
  /** Opening the WebSocket, or waiting for the server's welcome. */
  | 'connecting'
  /** Welcomed: this page is the holder. */
  | 'holder'
  /** No connection; the engine retries by itself. */
  | 'offline'
  /** Turned away because another holder is connected; the engine retries, slowly. */
  | 'refused'
  /** Turned away for good (another protocol version): the page has to be reloaded. */
  | 'stopped';

export interface JobView {
  id: string;
  kind: JobKind;
  phase?: JobPhase;
  /** While writing: the image's index, name and count, and esptool-js's byte counts. */
  image?: number;
  imageName?: string;
  imageCount?: number;
  written?: number;
  total?: number;
}

export interface LastJob {
  kind: JobKind;
  ok: boolean;
  message?: string;
  at: number;
}

export interface EngineStatus {
  /** Where the engine runs, and why when it is not the worker. */
  context: string;
  server: ServerState;
  /** Why the server state is what it is, and when the next attempt is. */
  serverDetail?: string;
  port: PortReport;
  job: JobView | null;
  lastJob?: LastJob;
}

export type EngineMessage =
  | { t: 'status'; status: EngineStatus }
  /** Device output, decoded, in the order it was read. */
  | { t: 'log'; text: string }
  /** What the engine did or saw: esptool-js's lines, errors, port events. */
  | { t: 'note'; text: string };

export type PageMessage =
  /** The operator granted a port through `requestPort()`; the info says which. */
  { t: 'granted'; info: PortInfo };

/** The worker's first message: whether it has Web Serial, and so runs the engine. */
export interface WorkerReady {
  t: 'ready';
  serial: boolean;
}
