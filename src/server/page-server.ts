// The page port, open to the LAN through the edge: the static page, the holder's WebSocket,
// and the images of the running job. Nothing here starts a job; only the agent API does.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { HOLDER_PATH } from '../shared/protocol.ts';
import type { HolderHub } from './holder-hub.ts';

export interface PageServerOptions {
  hub: HolderHub;
  /** Vite's output: `index.html`, and hashed files under `assets/`. */
  pageDir: string;
}

export interface PageServer {
  server: http.Server;
  wss: WebSocketServer;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const IMAGE_PATH = /^\/jobs\/([^/]+)\/images\/(\d{1,6})$/;

export function createPageServer(opts: PageServerOptions): PageServer {
  const root = path.resolve(opts.pageDir);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      if (!res.headersSent) text(res, 500, `internal error: ${(e as Error).message}`);
      else res.destroy();
    }
  });

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = pathOf(req.url);
    if (pathname === null) return text(res, 400, 'bad path');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return text(res, 405, 'method not allowed');
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const m = IMAGE_PATH.exec(pathname);
    if (m) return image(req, res, m[1] ?? '', Number(m[2]));
    if (pathname === HOLDER_PATH) return text(res, 426, 'the holder connects here with a WebSocket');
    if (pathname.startsWith('/jobs/')) return text(res, 404, 'not found');
    staticFile(req, res, pathname);
  }

  function image(req: http.IncomingMessage, res: http.ServerResponse, jobId: string, index: number): void {
    const im = opts.hub.image(jobId, index);
    if (!im) return text(res, 404, 'no such image: the job is not running');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': im.data.length,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : im.data);
  }

  function staticFile(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, rel);
    // The traversal guard: a path that leaves the page directory is not there
    if (!file.startsWith(root + path.sep)) return text(res, 404, 'not found');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        if (rel === 'index.html') return text(res, 404, `the page is not built: no ${file} (run npm run build)`);
        return text(res, 404, 'not found');
      }
      const name = path.relative(root, file).split(path.sep).join('/');
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size,
        'cache-control': cacheControl(name),
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    if (pathOf(req.url) !== HOLDER_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => opts.hub.accept(ws, clientAddress(req)));
  });

  return { server, wss };
}

/**
 * `index.html` is never cached, so a new build is picked up on the next load; what Vite
 * writes under `assets/` has a content hash in its name and never changes.
 */
function cacheControl(name: string): string {
  if (name === 'index.html') return 'no-store';
  if (name.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/** The decoded path of a request, or null when it cannot be decoded. */
function pathOf(url: string | undefined): string | null {
  const raw = (url ?? '/').split('?')[0] ?? '/';
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!p.startsWith('/') || p.includes('\0') || p.includes('\\')) return null;
  return p;
}

/** The edge is nginx, which says who connected in X-Forwarded-For. */
function clientAddress(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body + '\n');
}
