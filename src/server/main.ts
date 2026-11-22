// Starts the bench from the environment:
//
//   BENCH_PAGE_PORT  the page, the holder's WebSocket and the images, on 0.0.0.0 (3520)
//   BENCH_API_PORT   the agent API, on 127.0.0.1 only (3521)
//   BENCH_PAGE_DIR   the built page (dist/page)
//   BENCH_WORK_ROOT  build directories must be under this (/work)
//   BENCH_LOG_DIR    where serial.log goes (/work/.bench)
//
// It runs from source (`node src/server/main.ts`) and from tsc's output alike.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, startBench } from './app.ts';

function port(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`${name} is not a port number: ${v}`);
  return Number(v);
}

function dir(name: string, fallback: string): string {
  return path.resolve(process.env[name] || fallback);
}

/** The repo root: the nearest directory with a package.json, from source or from dist alike. */
function packageRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return process.cwd();
    d = up;
  }
}

async function main(): Promise<void> {
  const bench = await startBench({
    pagePort: port('BENCH_PAGE_PORT', DEFAULTS.pagePort),
    apiPort: port('BENCH_API_PORT', DEFAULTS.apiPort),
    pageDir: dir('BENCH_PAGE_DIR', path.join(packageRoot(), 'dist', 'page')),
    workRoot: dir('BENCH_WORK_ROOT', '/work'),
    logDir: dir('BENCH_LOG_DIR', '/work/.bench'),
  });
  console.log(
    `bench: page on http://${bench.pageHost}:${bench.pagePort}, agent API on http://${bench.apiHost}:${bench.apiPort}, log ${bench.log.path}`,
  );

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`bench: ${signal}, stopping`);
    // Should anything hold the process open after the close, this ends it
    setTimeout(() => process.exit(1), 5000).unref();
    bench.close().then(
      () => {
        process.exitCode = 0;
      },
      (e: unknown) => {
        console.error('bench: close failed:', e);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  console.error(`bench: ${(e as Error)?.message ?? String(e)}`);
  process.exit(1);
});
