// The bench, put together: the log, the holder hub, the page port and the agent API. Both
// listeners start here, so a test can start the whole bench in-process on ephemeral ports.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentApi, type AgentApiConfig } from './agent-api.ts';
import { HolderHub, type HubOptions } from './holder-hub.ts';
import { createPageServer, pageEntry } from './page-server.ts';
import { SerialLog, type SerialLogOptions } from './serial-log.ts';

/** The agent API binds here and nowhere else, so the edge never reaches it. */
export const API_HOST = '127.0.0.1';

export const DEFAULTS = {
  pagePort: 3520,
  pageHost: '0.0.0.0',
  apiPort: 3521,
  flashTimeoutMs: 120_000,
  resetTimeoutMs: 20_000,
  consoleTimeoutMs: 10_000,
  portWaitMs: 10_000,
} as const;

export interface BenchOptions {
  /** 0 takes an ephemeral port. */
  pagePort?: number;
  pageHost?: string;
  /** 0 takes an ephemeral port. The API always binds to 127.0.0.1. */
  apiPort?: number;
  pageDir: string;
  /** Origins a holder may connect from besides the page's own, such as Vite's dev server. */
  allowedOrigins?: string[];
  /** Build directories must be under this. */
  workRoot: string;
  /** Where `serial.log` and its rotations go. */
  logDir: string;
  log?: Omit<SerialLogOptions, 'dir'>;
  hub?: Omit<HubOptions, 'log'>;
  api?: Partial<Omit<AgentApiConfig, 'workRoot'>>;
}

export interface Bench {
  pagePort: number;
  pageHost: string;
  apiPort: number;
  apiHost: string;
  log: SerialLog;
  hub: HolderHub;
  close(): Promise<void>;
}

export async function startBench(opts: BenchOptions): Promise<Bench> {
  const log = new SerialLog({ ...opts.log, dir: opts.logDir });
  log.open();
  const hub = new HolderHub({ pageEntry: () => pageEntry(opts.pageDir), ...opts.hub, log });
  const page = createPageServer({ hub, pageDir: opts.pageDir, allowedOrigins: opts.allowedOrigins });
  const api = http.createServer(
    agentApi(hub, log, {
      workRoot: opts.workRoot,
      flashTimeoutMs: opts.api?.flashTimeoutMs ?? DEFAULTS.flashTimeoutMs,
      resetTimeoutMs: opts.api?.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs,
      consoleTimeoutMs: opts.api?.consoleTimeoutMs ?? DEFAULTS.consoleTimeoutMs,
      portWaitMs: opts.api?.portWaitMs ?? DEFAULTS.portWaitMs,
    }),
  );
  const pageHost = opts.pageHost ?? DEFAULTS.pageHost;

  let started = false;
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      // Ends a running job first, so its blocked call still gets its answer
      hub.close();
      await new Promise((r) => setImmediate(r));
      for (const ws of page.wss.clients) ws.terminate();
      page.wss.close();
      const done = Promise.all([stop(page.server), stop(api)]);
      page.server.closeAllConnections();
      api.closeAllConnections();
      await done;
      if (started) log.marker('bench stopped');
      log.close();
    })();
    return closing;
  };

  try {
    const pagePort = await listen(page.server, opts.pagePort ?? DEFAULTS.pagePort, pageHost);
    const apiPort = await listen(api, opts.apiPort ?? DEFAULTS.apiPort, API_HOST);
    log.marker(`bench started: page on ${pageHost}:${pagePort}, agent API on ${API_HOST}:${apiPort}`);
    started = true;
    return { pagePort, pageHost, apiPort, apiHost: API_HOST, log, hub, close };
  } catch (e) {
    await close();
    throw e;
  }
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}
