// Fakes for the UpdateService tests (SM12): one-shot fake timers, a scripted electron-updater
// (like the real one it reports a failure as event AND rejection; `hold` keeps a check running)
// and a service harness on win32 that records states, opened URLs and the install order.
// B-080: desktopDeps – DesktopUpdates' wiring on win32 recording the drain order (with the version a pause names).
// Owns: these fakes only. Never: electron, network or real timers.

import type { UpdateState } from '../../../src/shared/model/system.ts';
import { UpdateService } from '../../../src/main/updates/update-service.ts';
import type { UpdateServiceOptions, Updater } from '../../../src/main/updates/update-service.ts';
import { inactiveUpdater, type DesktopUpdatesDeps } from '../../../src/main/updates-wiring.ts';

/** B-080: DesktopUpdates' deps on win32; `order` records drafts, pause[:to], resume, stop and start. */
export function desktopDeps(overrides: Partial<DesktopUpdatesDeps> = {}) {
  const order: string[] = [];
  const deps: DesktopUpdatesDeps = {
    updater: inactiveUpdater(),
    packaged: true, enabled: true, platform: 'win32', arch: 'x64', version: '0.2.0',
    autoDownload: () => true,
    renderer: { rendererReady: true, prepareRestart: async () => { order.push('drafts'); return true; } },
    idleSeconds: () => 600,
    runtime: {
      readiness: async () => ({ ready: true }),
      prepareRestart: async (cancel, to) => { order.push(cancel ? 'resume' : `pause${to ? `:${to}` : ''}`); },
      stop: async () => { order.push('stop'); },
      start: () => { order.push('start'); },
    },
    publish: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    ...overrides,
  };
  return { deps, order };
}

export const settle = async () => { for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve)); };

/** Fake one-shot timers: advance() runs what is due, in order. */
export function fakeClock() {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    hooks: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => { next += 1; timers.set(next, { at: now + ms, fn }); return next; },
      clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    },
    /** Delays of the armed timers, shortest first. */
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
        await settle();
      }
    },
  };
}

/** A scripted electron-updater: like the real one, a failure is reported as event AND rejection. */
export function fakeUpdater(script: { version?: string | null; checkFails?: number; downloadFails?: number; hold?: Promise<void> } = {}) {
  const listeners = new Map<string, (value: unknown) => void>();
  const calls = { check: 0, download: 0, install: 0 };
  const fail = { check: script.checkFails ?? 0, download: script.downloadFails ?? 0 }; // tests may raise them later
  const emit = (event: string, value?: unknown) => listeners.get(event)?.(value);
  const updater: Updater = {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, logger: console,
    on: (event, listener) => { listeners.set(event, listener); },
    checkForUpdates: async () => {
      calls.check += 1;
      emit('checking-for-update');
      await script.hold; // a check that takes its time (the network)
      if (fail.check-- > 0) { emit('error', new Error('offline')); throw new Error('offline'); }
      if (script.version === null) emit('update-not-available');
      else emit('update-available', { version: script.version ?? '0.3.0' });
      return null;
    },
    downloadUpdate: async () => {
      calls.download += 1;
      emit('download-progress', { percent: 40.4 });
      if (fail.download-- > 0) { emit('error', new Error('reset')); throw new Error('reset'); }
      emit('update-downloaded', { version: script.version ?? '0.3.0' });
      return null;
    },
    quitAndInstall: () => { calls.install += 1; },
  };
  return { updater, calls, fail, emit };
}

export function harness(options: Partial<UpdateServiceOptions> & { script?: Parameters<typeof fakeUpdater>[0]; idle?: number } = {}) {
  const clock = fakeClock();
  const { updater, calls, fail, emit } = fakeUpdater(options.script);
  const opened: string[] = [];
  const states: UpdateState[] = [];
  const order: string[] = [];
  const facts = { rendererReady: true, idleSeconds: options.idle ?? 600, runtimeReady: true };
  const service = new UpdateService(updater, {
    packaged: true, enabled: true, platform: 'win32', arch: 'x64', version: '0.2.0',
    autoDownload: () => false,
    facts: async () => ({ ...facts }),
    prepareInstall: async () => { order.push('drain'); },
    cancelInstall: () => { order.push('resume'); },
    openExternal: async (url) => { opened.push(url); },
    changed: (state) => { states.push(state); },
    ...clock.hooks,
    ...options,
  });
  return { service, clock, calls, fail, emit, opened, states, order, facts, updater };
}
