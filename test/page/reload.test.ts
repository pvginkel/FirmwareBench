// The page reloading itself when the server's build of it is another one: what the engine
// takes from the welcome, and when the page reloads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../src/page/messages.ts';
import { RELOAD_GAP_MS, RELOAD_KEY, entryName, newPageReloader } from '../../src/page/reload.ts';
import { started, type Started } from './fakes.ts';

function status(over: Partial<EngineStatus> = {}): EngineStatus {
  return { context: 'worker', server: 'holder', port: { state: 'open' }, job: null, ...over };
}

function tab(own: string | undefined, stored: Record<string, string> = {}) {
  let now = 1_000_000;
  const reloads: number[] = [];
  const notes: string[] = [];
  const storage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
  };
  const check = newPageReloader({ own, storage, reload: () => reloads.push(now), now: () => now, note: (t) => notes.push(t) });
  return {
    check,
    reloads,
    notes,
    stored,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('entryName', () => {
  it('names a built entry script, and nothing under vite dev', () => {
    expect(entryName('https://bench.example/assets/index-Czo42VQf.js')).toBe('index-Czo42VQf.js');
    expect(entryName('http://localhost:5173/main.ts')).toBeUndefined();
  });
});

describe('the page reloading itself', () => {
  it('reloads once when the server has another page and no job runs', () => {
    const t = tab('index-old.js');
    t.check(status({ serverPage: 'index-new.js' }));
    t.check(status({ serverPage: 'index-new.js' }));

    expect(t.reloads).toHaveLength(1);
    expect(t.stored[RELOAD_KEY]).toBe(String(t.reloads[0]));
  });

  it('stays when the page is the same, the server names none, or the page is not built', () => {
    const same = tab('index-a.js');
    same.check(status({ serverPage: 'index-a.js' }));
    const unnamed = tab('index-a.js');
    unnamed.check(status());
    const dev = tab(undefined);
    dev.check(status({ serverPage: 'index-a.js' }));

    expect([...same.reloads, ...unnamed.reloads, ...dev.reloads]).toEqual([]);
  });

  it('waits for a running job to end', () => {
    const t = tab('index-old.js');
    t.check(status({ serverPage: 'index-new.js', job: { id: 'j1', kind: 'flash', phase: 'writing' } }));
    expect(t.reloads).toEqual([]);

    t.check(status({ serverPage: 'index-new.js' }));
    expect(t.reloads).toHaveLength(1);
  });

  it('reloads at most once per 2 minutes, and says so when it holds back', () => {
    const t = tab('index-old.js', { [RELOAD_KEY]: String(1_000_000 - 1000) });
    t.check(status({ serverPage: 'index-new.js' }));
    t.check(status({ serverPage: 'index-new.js' }));
    expect(t.reloads).toEqual([]);
    expect(t.notes).toEqual([expect.stringMatching(/reload it by hand/)]);

    t.advance(RELOAD_GAP_MS);
    t.check(status({ serverPage: 'index-new.js' }));
    expect(t.reloads).toHaveLength(1);
  });

  it('does not reload when sessionStorage cannot keep the guard', () => {
    const reloads: number[] = [];
    const check = newPageReloader({
      own: 'index-old.js',
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('denied', 'SecurityError');
        },
      },
      reload: () => reloads.push(1),
      now: () => 0,
      note: () => undefined,
    });
    check(status({ serverPage: 'index-new.js' }));
    expect(reloads).toEqual([]);
  });
});

describe('the engine', () => {
  let h: Started;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await h.engine.stop();
    vi.useRealTimers();
  });

  it('passes the page the welcome names on to the page, in its status', async () => {
    h = await started();
    expect(h.engine.status().serverPage).toBeUndefined();

    h.server.last.message({ t: 'welcome', protocol: 1, page: 'index-new.js' });

    expect(h.engine.status().serverPage).toBe('index-new.js');
    const last = h.page.filter((m) => m.t === 'status').at(-1);
    expect(last).toMatchObject({ status: { serverPage: 'index-new.js' } });
  });
});
