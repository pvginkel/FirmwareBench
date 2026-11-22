// The dedicated worker that holds the port. A worker's timers are not throttled when the
// tab is hidden, and the page's are (design §9), so the WebSocket, the heartbeat answers
// and the jobs all live here. The page only asks for the port and shows status.

import { Engine } from './engine.ts';
import { connectEsptool } from './esptool.ts';
import type { EngineMessage, PageMessage, WorkerReady } from './messages.ts';
import { realClock, type SerialLike } from './serial.ts';
import { browserSocket } from './server-link.ts';

interface WorkerScope {
  navigator: { serial?: SerialLike; userAgent: string };
  location: { protocol: string; host: string };
  postMessage(msg: EngineMessage | WorkerReady): void;
  onmessage: ((event: MessageEvent<PageMessage>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const serial = scope.navigator.serial;

if (serial) {
  const engine = new Engine({
    serial,
    openSocket: browserSocket,
    connectEsptool,
    fetch: (url, init) => fetch(url, init),
    clock: realClock,
    location: scope.location,
    context: 'worker',
    userAgent: scope.navigator.userAgent,
    toPage: (msg) => scope.postMessage(msg),
  });
  scope.onmessage = (event) => void engine.fromPage(event.data);
  scope.postMessage({ t: 'ready', serial: true });
  void engine.start();
} else {
  // No Web Serial in this worker: the page runs the engine itself
  scope.postMessage({ t: 'ready', serial: false });
}
