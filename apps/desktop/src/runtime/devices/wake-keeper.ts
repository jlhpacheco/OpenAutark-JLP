// 0.3.19 (23.11.2026, owner: Wake did nothing after Autark was ended in Task Manager): <data>/wake.json is kept current
// while the app runs – written at start and whenever my linked devices or the meeting server change – instead of only at
// the person's quit (devices.bye), so a helper the broker service starts after a hard end (Task Manager, a crash) still
// finds it. "Wake while closed" off (devices.wakeHelper false) removes the file: no helper then waits for anyone.
// Changes are bundled (one write 2 s after the last; device.upserted comes often) and only a changed content is written.
// Owns: when the file is written. Never: starts a helper (main and the broker do) or writes the key anywhere else.

import type { RuntimeServices } from '../contracts.ts';
import type { Settings } from '../../shared/model/system.ts';
import { relayAddress } from '../../shared/model/relay.ts';
import { meetingAddress } from './connect.ts';
import { DevicesRepo } from './repo.ts';
import { wakeFileFor, wakeKey, writeWakeFile } from './wake.ts';
import type { WakeFile } from './wake-sign.ts';

export const WAKE_KEEP_DELAY_MS = 2_000;

/** "Wake while closed" (absent = on). */
export const wakeHelperOn = (settings: Pick<Settings, 'devices'>): boolean => settings.devices?.wakeHelper !== false;

/** The helper's file as it should be now: undefined when the waker is off, no meeting server is set or nobody could wake this PC. */
export function currentWakeFile(s: Pick<RuntimeServices, 'settings' | 'db' | 'clock'>): WakeFile | undefined {
  const settings = s.settings.get();
  if (!wakeHelperOn(settings)) return undefined;
  const relay = relayAddress(meetingAddress(settings.devices.relay) ?? '');
  return wakeFileFor({ relay, key: wakeKey(s.db, s.clock.now()), devices: new DevicesRepo(s.db).list({ kinds: ['pc', 'phone'] }) }); // W: my phones wake it too
}

export interface WakeKeeperDeps {
  s: Pick<RuntimeServices, 'settings' | 'db' | 'clock' | 'bus' | 'paths' | 'log'>;
  write?: typeof writeWakeFile;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** Writes the file now and again after every change; returns its stop. Never throws. */
export function keepWakeFile(deps: WakeKeeperDeps): () => void {
  const { s } = deps;
  const write = deps.write ?? writeWakeFile;
  const timers = deps.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  let last: string | undefined;
  let pending: unknown;
  const flush = () => {
    pending = undefined;
    try {
      const file = currentWakeFile(s);
      const text = file ? JSON.stringify(file) : '';
      if (text === last) return;
      write(s.paths.data, file);
      last = text;
    } catch (error) {
      s.log.warn('wake helper file not kept', { error: String(error) });
    }
  };
  const later = () => { if (pending === undefined) pending = timers.set(flush, WAKE_KEEP_DELAY_MS); };
  const offs = [s.bus.on('device.upserted', later), s.bus.on('device.removed', later), s.bus.on('settings.updated', later)];
  flush();
  return () => {
    for (const off of offs) off();
    if (pending !== undefined) timers.clear(pending);
    pending = undefined;
  };
}
