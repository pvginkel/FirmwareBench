// The bench page. It asks for the port once, on a click, and shows what the holder is
// doing. The engine runs in a dedicated worker, which picks the port up through
// getPorts(); without Web Serial in workers, it runs here on the page.

import type { EngineMessage, EngineStatus, PageMessage, WorkerReady } from './messages.ts';
import { entryName, newPageReloader } from './reload.ts';
import type { SerialLike, SerialPortLike } from './serial.ts';

/** Device log lines the page keeps. */
const MAX_LINES = 500;
const MAX_EVENTS = 200;

type PageSerial = SerialLike & { requestPort(): Promise<SerialPortLike> };

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

const view = {
  choose: el<HTMLButtonElement>('choose'),
  problem: el('problem'),
  server: el('server'),
  holder: el('holder'),
  port: el('port'),
  chip: el('chip'),
  job: el('job'),
  progress: el<HTMLProgressElement>('progress'),
  last: el('last'),
  log: el('log'),
  events: el('events'),
};

let toEngine: (msg: PageMessage) => void = () => undefined;

// ---- status ----------------------------------------------------------------------------

function hex4(n: number | undefined): string {
  return n === undefined ? '?' : n.toString(16).padStart(4, '0');
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

function renderStatus(s: EngineStatus): void {
  const detail = s.serverDetail ? `: ${s.serverDetail}` : '';
  const server = {
    connecting: 'connecting',
    holder: 'connected',
    offline: `offline${detail}`,
    refused: 'connected, then turned away',
    stopped: 'turned away',
  }[s.server];
  view.server.textContent = server;
  const where = s.context === 'worker' ? 'serial in the worker' : `serial on the page (${s.context}); keep this tab visible`;
  view.holder.textContent =
    s.server === 'holder'
      ? `this page (${where})`
      : s.server === 'refused' || s.server === 'stopped'
        ? `not this page${detail}`
        : `not yet (${where})`;
  view.holder.className = s.server === 'refused' || s.server === 'stopped' ? 'bad' : '';

  const p = s.port;
  const ids = p.usbVendorId !== undefined ? ` (USB ${hex4(p.usbVendorId)}:${hex4(p.usbProductId)})` : '';
  const state = {
    none: 'none chosen: use Choose port',
    open: 'open',
    lost: 'lost: waiting for it to come back',
    closed: 'closed: it would not open (is another program using it?)',
  }[p.state];
  view.port.textContent = `${state}${ids}`;
  view.port.className = p.state === 'open' ? 'good' : p.state === 'none' ? '' : 'bad';
  view.chip.textContent = p.chip ? `${p.chip}${p.mac ? `, MAC ${p.mac}` : ''}` : '—';

  const j = s.job;
  if (!j) {
    view.job.textContent = 'none';
    view.progress.hidden = true;
  } else {
    let text = `${j.kind}${j.phase ? `: ${j.phase}` : ''}`;
    if (j.phase === 'writing' && j.imageName) {
      text += ` ${j.imageName} (image ${(j.image ?? 0) + 1} of ${j.imageCount ?? '?'})`;
    }
    view.job.textContent = text;
    const writing = j.phase === 'writing' && j.total;
    view.progress.hidden = !writing;
    if (writing) {
      view.progress.max = j.total ?? 1;
      view.progress.value = j.written ?? 0;
    }
  }
  const l = s.lastJob;
  view.last.textContent = l ? `${l.kind} ${l.ok ? 'done' : `failed: ${l.message ?? ''}`} at ${time(l.at)}` : '—';
  view.last.className = l && !l.ok ? 'bad' : '';
}

// ---- the device log and the events ------------------------------------------------------

const ESC = String.fromCharCode(27);
const COLOUR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const lines: string[] = [];
let partial = '';
let drawPending = false;

function addLog(text: string): void {
  const parts = (partial + text).replace(COLOUR, '').split('\n');
  partial = parts.pop() ?? '';
  for (const line of parts) lines.push(line.replace(/\r$/, ''));
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  if (!drawPending) {
    drawPending = true;
    requestAnimationFrame(drawLog);
  }
}

function drawLog(): void {
  drawPending = false;
  const pane = view.log;
  const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 20;
  pane.textContent = lines.join('\n') + (partial ? `\n${partial}` : '');
  if (atEnd) pane.scrollTop = pane.scrollHeight;
}

function addEvent(text: string): void {
  const item = document.createElement('li');
  item.textContent = `${time(Date.now())} ${text}`;
  view.events.prepend(item);
  while (view.events.childElementCount > MAX_EVENTS) view.events.lastElementChild?.remove();
}

const reloadIfNewer = newPageReloader({
  own: entryName(import.meta.url),
  storage: {
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
  },
  reload: () => location.reload(),
  now: () => Date.now(),
  note: addEvent,
});

function onEngine(msg: EngineMessage): void {
  if (msg.t === 'status') {
    renderStatus(msg.status);
    reloadIfNewer(msg.status);
  } else if (msg.t === 'log') addLog(msg.text);
  else addEvent(msg.text);
}

// ---- starting the engine ----------------------------------------------------------------

function problem(text: string): void {
  view.problem.textContent = text;
  view.problem.hidden = false;
}

/** The fallback when a dedicated worker has no Web Serial: the same engine, on the page. */
async function runOnPage(serial: PageSerial, why: string): Promise<void> {
  const [{ Engine }, { connectEsptool }, { browserSocket }, { realClock }] = await Promise.all([
    import('./engine.ts'),
    import('./esptool.ts'),
    import('./server-link.ts'),
    import('./serial.ts'),
  ]);
  const engine = new Engine({
    serial,
    openSocket: browserSocket,
    connectEsptool,
    fetch: (url, init) => fetch(url, init),
    clock: realClock,
    location,
    context: `page, because ${why}`,
    userAgent: navigator.userAgent,
    toPage: onEngine,
  });
  toEngine = (msg) => void engine.fromPage(msg);
  await engine.start();
}

function start(): void {
  const serial = (navigator as Navigator & { serial?: PageSerial }).serial;
  if (!serial) {
    view.choose.disabled = true;
    problem(
      window.isSecureContext
        ? 'This browser has no Web Serial, so the bench cannot reach the device. Open this page in desktop Chrome or Edge.'
        : 'Web Serial needs a secure context: open this page over https.',
    );
    return;
  }

  view.choose.onclick = async () => {
    try {
      const port = await serial.requestPort();
      toEngine({ t: 'granted', info: port.getInfo() });
    } catch (e) {
      // NotFoundError is the operator closing the chooser
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) addEvent(`choosing the port failed: ${String(e)}`);
    }
  };

  let fellBack = false;
  const fallBack = (why: string) => {
    if (fellBack) return;
    fellBack = true;
    worker.terminate();
    runOnPage(serial, why).catch((e: unknown) => problem(`The engine did not start: ${String(e)}`));
  };
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<EngineMessage | WorkerReady>) => {
    const msg = event.data;
    if (msg.t !== 'ready') onEngine(msg);
    else if (msg.serial) toEngine = (m) => worker.postMessage(m);
    else fallBack('the worker has no Web Serial');
  };
  worker.onerror = (event) => fallBack(`the worker failed: ${event.message || 'no reason given'}`);
}

start();
