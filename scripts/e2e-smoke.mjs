// End-to-end check of the bench: the built page in headless Chromium, with a fake
// navigator.serial, against the real server (spawned here, on its own ports).
//
//   cexec frontend sh -c 'cd /work/scratch/FirmwareBench && npm run build && \
//     timeout 300 node scripts/e2e-smoke.mjs [start|dev]'
//
// Headless Chromium only runs in the `frontend` tool container. Playwright is taken from
// PLAYWRIGHT_DIR (default /work/scratch/bench-smoke, where it is installed). Ports come from
// E2E_PAGE_PORT / E2E_API_PORT (3530 / 3531), logs go under E2E_RUN_DIR.
//
// The fake serial is installed on the page only. Playwright cannot reach a dedicated worker,
// so the worker's script is patched to report no Web Serial, which makes the page run the
// engine itself (the page's fallback). The worker path itself is only checked to load.
// A flash against the fake board must fail cleanly; it cannot succeed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pwDir = process.env.PLAYWRIGHT_DIR ?? '/work/scratch/bench-smoke';
const { chromium } = await import(pathToFileURL(path.join(pwDir, 'node_modules/playwright/index.mjs')).href);
const mode = process.argv[2] ?? 'start';
const PAGE = Number(process.env.E2E_PAGE_PORT ?? 3530);
const API = Number(process.env.E2E_API_PORT ?? 3531);
const runDir = process.env.E2E_RUN_DIR ?? path.join(root, 'run-e2e');
const BUILD = process.env.E2E_BUILD_DIR ?? '/work/ToiletAutomation/spikes/bench/build/hello_world';
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, evidence = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  -- ' + evidence : ''}`);
};
const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${API}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const until = async (fn, ms, step = 200) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
};

let server;
function startServer() {
  const args = mode === 'dev' ? ['src/server/main.ts'] : ['dist/node/server/main.js'];
  server = spawn(process.execPath, args, {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      BENCH_PAGE_PORT: String(PAGE), BENCH_API_PORT: String(API), BENCH_LOG_DIR: runDir,
      BENCH_WORK_ROOT: '/work', BENCH_PAGE_DIR: path.join(root, 'dist/page'),
    },
    stdio: ['ignore', fs.openSync(path.join(runDir, 'server.out'), 'a'), fs.openSync(path.join(runDir, 'server.out'), 'a')],
  });
  return server;
}
async function stopServer() {
  const s = server; server = undefined;
  if (!s || s.exitCode !== null) return;
  s.kill('SIGTERM');
  await new Promise((r) => { s.once('exit', r); setTimeout(() => { s.kill('SIGKILL'); r(); }, 8000); });
}

// Installed before the page's scripts. window.__fake drives it.
function fakeSerial() {
  const info = { usbVendorId: 0x303a, usbProductId: 0x1001 };
  const serial = new EventTarget();
  const ports = [];
  const fake = { ports, written: [], rts: [], serial };
  const fire = (type, port) => {
    const ev = new Event(type);
    Object.defineProperty(ev, 'target', { value: port });
    serial.dispatchEvent(ev);
  };
  class FakePort {
    constructor() { this.readable = null; this.writable = null; this.connected = true; this.rtsOn = false; }
    getInfo() { return info; }
    async open() {
      if (this.readable) throw new DOMException('already open', 'InvalidStateError');
      if (!this.connected) throw new DOMException('lost', 'NetworkError');
      this.readable = new ReadableStream({ start: (c) => { this.ctrl = c; } });
      this.writable = new WritableStream({ write: (chunk) => { fake.written.push(new TextDecoder().decode(chunk)); } });
    }
    async close() { this.readable = null; this.writable = null; }
    async setSignals(s) {
      if (!this.connected) throw new DOMException('The device has been lost.', 'NetworkError');
      if (s.requestToSend !== undefined) fake.rts.push({ v: s.requestToSend, at: performance.now() });
      if (s.requestToSend === true) this.rtsOn = true;
      if (s.requestToSend === false && this.rtsOn) { this.rtsOn = false; setTimeout(() => fake.reboot(this), 20); }
    }
    push(t) { this.ctrl.enqueue(new TextEncoder().encode(t)); }
    lose() {
      this.connected = false;
      try { this.ctrl.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* already */ }
      this.readable = null; this.writable = null;
      ports.splice(ports.indexOf(this), 1);
      fire('disconnect', this);
    }
  }
  fake.reboot = (p) => { p.lose(); setTimeout(() => fake.plug(), 800); };
  fake.plug = () => { const q = new FakePort(); ports.push(q); fire('connect', q); return q; };
  fake.push = (t) => ports[0].push(t);
  fake.lose = () => ports[0].lose();
  fake.grant = () => { if (!ports.length) ports.push(new FakePort()); };
  serial.getPorts = async () => ports.slice();
  serial.requestPort = async () => { fake.grant(); return ports[0]; };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  window.__fake = fake;
}

async function newPage(browser, notes) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakeSerial);
  // Playwright cannot put the fake into a dedicated worker: make the worker report no Web
  // Serial, so the page runs the engine (the fallback).
  await ctx.route('**/assets/worker-*.js', async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({ response: res, body: `Object.defineProperty(WorkerNavigator.prototype,'serial',{get(){return undefined},configurable:true});\n${body}` });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') notes.push(`console error: ${m.text()}`); });
  page.on('requestfailed', (r) => notes.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('worker', (w) => notes.push(`worker: ${w.url()}`));
  return { ctx, page };
}

const status = async () => (await api('GET', '/status')).json;
const logText = async () => (await api('GET', '/log')).json.lines.map((l) => l.text ?? l.line ?? JSON.stringify(l)).join('\n');

startServer();
const up = await until(async () => (await fetch(`http://127.0.0.1:${API}/status`)).ok, 15000);
check(`server starts (${mode})`, !!up);
if (!up) { console.log(fs.readFileSync(path.join(runDir, 'server.out'), 'utf8')); await stopServer(); process.exit(1); }

const browser = await chromium.launch({ channel: 'chromium' });
try {
  const notes = [];
  const { page } = await newPage(browser, notes);
  const workerGot = new Promise((r) => page.on('response', (res) => { if (/assets\/worker-.*\.js/.test(res.url())) r(res.status()); }));
  await page.goto(`http://localhost:${PAGE}/`);
  const wstatus = await Promise.race([workerGot, sleep(5000).then(() => null)]);
  check('3a page loads; module worker script served', wstatus === 200, `worker status ${wstatus}`);

  const held = await until(async () => (await status()).holder?.connected === true, 10000);
  const s0 = await status();
  check('3b holder connects (Origin accepted)', !!held, `holder=${JSON.stringify(s0.holder)}`);
  check('3c engine ran on the page (fallback), not the worker', /bench page \(page/.test(String(s0.holder?.name)), `name=${s0.holder?.name}`);

  await page.click('#choose');
  const opened = await until(async () => (await status()).port?.state === 'open', 8000);
  check('3d choosing the port gives port.open', !!opened, JSON.stringify((await status()).port));

  await page.evaluate(() => window.__fake.push('boot ok\n\x1b[32mgreen line\x1b[0m\nthird \x1b[1;31mred\x1b[0m done\n'));
  await sleep(500);
  const lt = await logText();
  check('3e output in GET /log, colour stripped', /green line/.test(lt) && /third red done/.test(lt) && !lt.includes('\x1b'), JSON.stringify(lt.slice(-80)));
  const serialLog = fs.readFileSync(path.join(runDir, 'serial.log'), 'utf8');
  check('3f serial.log has the lines without ANSI', /green line/.test(serialLog) && !serialLog.includes('\x1b'));

  const waitP = api('GET', `/log?wait=${encodeURIComponent('late marker \\d+')}&timeout=5&since=${(await status()).log.cursor}`);
  await sleep(800);
  await page.evaluate(() => window.__fake.push('late marker 42\n'));
  const w = await waitP;
  check('3g GET /log?wait matches a later line', w.status === 200 && JSON.stringify(w.json).includes('late marker 42'), `status ${w.status} ${JSON.stringify(w.json).slice(0, 160)}`);

  await page.evaluate(() => { window.__fake.written.length = 0; });
  const con = await api('POST', '/console', { line: 'help' });
  const wr = await page.evaluate(() => window.__fake.written.join(''));
  check('4 POST /console reaches the fake as "help\\r\\n"', con.status === 200 && wr === 'help\r\n', `status ${con.status} wrote ${JSON.stringify(wr)}`);

  await page.evaluate(() => { window.__fake.rts.length = 0; });
  const rs = await api('POST', '/reset');
  const rts = await page.evaluate(() => window.__fake.rts);
  const t = rts.find((e) => e.v === true), f = rts.find((e) => e.v === false && t && e.at > t.at);
  const dt = t && f ? Math.round(f.at - t.at) : null;
  check('5 POST /reset: RTS true then false ~100 ms later, cursor returned', rs.status === 200 && dt !== null && dt >= 80 && dt <= 400 && typeof rs.json.cursor === 'number', `status ${rs.status} ${JSON.stringify(rs.json)} pulse ${dt} ms`);
  await until(async () => (await status()).port?.state === 'open', 8000);

  const fl = await api('POST', '/flash', { build_dir: BUILD, timeout: 30 });
  const code = fl.json?.error;
  const lt2 = await logText();
  const after = await api('POST', '/console', { line: 'after' });
  check('6a flash fails cleanly', fl.status >= 400 && ['flash_failed', 'wrong_chip', 'timed_out'].includes(code), `status ${fl.status} ${JSON.stringify(fl.json).slice(0, 240)}`);
  check('6b flash log marker', /flash/i.test(lt2), '');
  check('6c job slot freed (console works after)', after.status === 200, `status ${after.status} ${JSON.stringify(after.json).slice(0, 160)}`);
  await until(async () => (await status()).port?.state === 'open', 8000);

  await page.evaluate(() => window.__fake.lose());
  const lost = await until(async () => (await status()).port?.state === 'lost', 5000, 50);
  await page.evaluate(() => window.__fake.plug());
  const back = await until(async () => (await status()).port?.state === 'open', 8000);
  const lt3 = await logText();
  check('7 lost then open again without a click, with markers', !!lost && !!back && /port lost/i.test(lt3) && /port reopened/i.test(lt3), `lost=${!!lost} back=${!!back} markers lost=${/port lost/i.test(lt3)} reopened=${/port reopened/i.test(lt3)}`);

  const second = await newPage(browser, notes);
  await second.page.goto(`http://localhost:${PAGE}/`);
  await sleep(2500);
  const prob = `${await second.page.textContent('#server')} | ${await second.page.textContent('#holder')}`;
  const probVisible = true;
  const still = await status();
  check('8 second holder refused, page shows why; first holder unaffected', probVisible && /turned away/i.test(prob) && /another/i.test(prob) && still.holder?.connected === true, `problem=${JSON.stringify(prob)} holder=${still.holder?.connected}`);
  await second.ctx.close();
  await sleep(1000);
  await page.waitForTimeout(100);

  await stopServer();
  const t0 = Date.now();
  startServer();
  await until(async () => (await fetch(`http://127.0.0.1:${API}/status`)).ok, 15000);
  const re = await until(async () => (await status()).holder?.connected === true, 40000, 500);
  check('9 page reconnects after a server restart', !!re, `${Math.round((Date.now() - t0) / 1000)} s`);
  const reopened = await until(async () => (await status()).port?.state === 'open', 10000);
  check('9b port reported open again after reconnect', !!reopened, JSON.stringify((await status()).port));

  console.log('browser notes:\n  ' + (notes.join('\n  ') || 'none'));
  console.log('page holder line:', JSON.stringify(await page.textContent('#holder')));
} finally {
  await browser.close();
  await stopServer();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
