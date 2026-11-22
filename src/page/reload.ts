// The page reloads itself when the server has another build of it, so a page fix reaches
// the operator's tab without a click: the server names its build's entry script in each
// welcome, and the page compares it with the one it was loaded from. The port's grant
// survives the reload, and the worker picks the port up again.

import type { EngineStatus } from './messages.ts';

/** At most one reload in this long, per tab, so a page that keeps differing cannot loop. */
export const RELOAD_GAP_MS = 2 * 60_000;
/** In sessionStorage, which a reload keeps: when this tab last reloaded itself. */
export const RELOAD_KEY = 'bench.reloadedAt';

/**
 * A built page's entry script, from its `import.meta.url`: `index-<hash>.js`. Undefined
 * under `vite dev`, which serves sources: there is no build to compare.
 */
export function entryName(url: string): string | undefined {
  return /\/assets\/([^/]+\.js)$/.exec(new URL(url).pathname)?.[1];
}

export interface ReloadDeps {
  /** The entry script this page was loaded from. */
  own: string | undefined;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  reload(): void;
  now(): number;
  note(text: string): void;
}

/**
 * Takes each engine status. Reloads when the server's page is another one and no job is
 * running, at most once per `RELOAD_GAP_MS`; a job that is running holds the reload back
 * until the status after it.
 */
export function newPageReloader(deps: ReloadDeps): (status: EngineStatus) => void {
  let reloading = false;
  let heldBack = false;
  return (status) => {
    const server = status.serverPage;
    if (reloading || !deps.own || !server || server === deps.own || status.job) return;
    let last: number;
    try {
      last = Number(deps.storage.getItem(RELOAD_KEY) ?? 0);
    } catch {
      return;
    }
    if (last > 0 && deps.now() - last < RELOAD_GAP_MS) {
      if (!heldBack) deps.note(`the server has another page (${server}), and this tab reloaded itself less than 2 minutes ago: reload it by hand`);
      heldBack = true;
      return;
    }
    try {
      deps.storage.setItem(RELOAD_KEY, String(deps.now()));
    } catch {
      // Without the guard, no reload
      return;
    }
    reloading = true;
    deps.note(`the server has another page (${server}): reloading`);
    deps.reload();
  };
}
