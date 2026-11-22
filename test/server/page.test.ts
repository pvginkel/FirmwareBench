// The page port: the static page, its caching, the traversal guard, and what is not served.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOLDER_PATH } from '../../src/shared/protocol.ts';
import { ASSET_JS, INDEX_HTML, logFileLines, ScriptedHolder, startTestBench, type TestBench } from './helpers.ts';

let bench: TestBench;

beforeEach(async () => {
  bench = await startTestBench();
});

afterEach(async () => {
  await bench.close();
});

/** A raw request, so the path goes out as written: fetch would resolve `..` first. */
function raw(method: string, urlPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bench.pagePort, method, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the page', () => {
  it('serves index.html at / and by name, never cached', async () => {
    for (const p of ['/', '/index.html', '/?reload=1']) {
      const r = await raw('GET', p);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toBe(INDEX_HTML);
    }
  });

  it('serves hashed assets with long caching, and other files revalidated', async () => {
    const a = await raw('GET', '/assets/index-AbC123de.js');
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(a.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(a.body).toBe(ASSET_JS);
    const t = await raw('GET', '/robots.txt');
    expect(t.status).toBe(200);
    expect(t.headers['cache-control']).toBe('no-cache');
  });

  it('answers HEAD without a body', async () => {
    const r = await raw('HEAD', '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(r.body).toBe('');
  });

  it('keeps every request inside the page directory', async () => {
    expect(fs.existsSync(path.join(bench.pageDir, '..', 'secret.txt'))).toBe(true);
    for (const p of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/..%2fsecret.txt',
      '//etc/passwd',
      '/%2fetc%2fpasswd',
      '/..%5csecret.txt',
      '/%00',
      '/%E0%A4%A',
    ]) {
      const r = await raw('GET', p);
      expect([p, r.status]).toEqual([p, r.status >= 400 && r.status < 500 ? r.status : 'not a 4xx']);
      expect(r.body).not.toContain('the secret');
      expect(r.body).not.toContain('root:');
    }
  });

  it('answers 404 for what is not there, 405 for other methods, and 204 for the favicon', async () => {
    expect((await raw('GET', '/nothing.js')).status).toBe(404);
    expect((await raw('GET', '/assets')).status).toBe(404);
    expect((await raw('GET', '/jobs/abc')).status).toBe(404);
    expect((await raw('GET', '/jobs/abc/images/0')).status).toBe(404);
    expect((await raw('GET', '/jobs/abc/images/x')).status).toBe(404);
    expect((await raw('POST', '/')).status).toBe(405);
    expect((await raw('GET', HOLDER_PATH)).status).toBe(426);
    const f = await raw('GET', '/favicon.ico');
    expect(f.status).toBe(204);
    expect(f.body).toBe('');
  });

  it('says when the page is not built', async () => {
    fs.rmSync(path.join(bench.pageDir, 'index.html'));
    const r = await raw('GET', '/');
    expect(r.status).toBe(404);
    expect(r.body).toMatch(/the page is not built/);
  });
});

describe('WebSocket upgrades', () => {
  it('are refused on any path but the holder\'s', async () => {
    for (const p of ['/ws', '/holder/x', '/']) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${bench.pagePort}${p}`);
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on('open', () => {
          resolve(101);
          ws.terminate();
        });
        ws.on('error', () => resolve(-1));
      });
      expect([p, status]).toEqual([p, 404]);
    }
  });
});

/** The status a holder upgrade gets: 101 when it is taken. */
function upgrade(b: TestBench, opts: { origin?: string; headers?: Record<string, string> } = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(b.holderUrl(), opts);
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      resolve(101);
      ws.terminate();
    });
    ws.on('error', () => resolve(-1));
  });
}

describe('the Origin check on the holder upgrade', () => {
  it('refuses a foreign Origin and a missing one with 403, and writes no marker', async () => {
    const before = logFileLines(bench);
    expect(await upgrade(bench, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade(bench, { origin: `http://127.0.0.1:${bench.pagePort + 1}` })).toBe(403);
    expect(await upgrade(bench, { origin: 'null' })).toBe(403);
    expect(await upgrade(bench)).toBe(403);
    expect(logFileLines(bench)).toEqual(before);
    expect(bench.hub.status().holder.connected).toBe(false);
  });

  it('accepts the page\'s own Origin', async () => {
    expect(await upgrade(bench, { origin: bench.pageUrl('') })).toBe(101);
    // The scripted holder sends it, as a browser does
    await ScriptedHolder.connect(bench);
    expect(bench.hub.status().holder.connected).toBe(true);
  });

  it('takes the host from X-Forwarded-Host behind the edge', async () => {
    const edge = { 'x-forwarded-host': 'bench.pvginkel-x.home' };
    expect(await upgrade(bench, { origin: 'https://bench.pvginkel-x.home', headers: edge })).toBe(101);
    expect(await upgrade(bench, { origin: 'https://BENCH.pvginkel-x.home', headers: edge })).toBe(101);
    expect(await upgrade(bench, { origin: bench.pageUrl(''), headers: edge })).toBe(403);
    expect(await upgrade(bench, { origin: 'https://other.home', headers: edge })).toBe(403);
  });

  it('accepts the origins it is given besides', async () => {
    await bench.close();
    bench = await startTestBench({ allowedOrigins: ['http://localhost:5173/', 'not a url'] });
    expect(await upgrade(bench, { origin: 'http://localhost:5173' })).toBe(101);
    expect(await upgrade(bench, { origin: 'http://localhost:5174' })).toBe(403);
    expect(await upgrade(bench, { origin: bench.pageUrl('') })).toBe(101);
  });
});
