// W (19.11.2026, owner: "vom Handy bitte eben auch alles, also die PCs updaten … Und natürlich auch erwachen lassen. Auch
// wenn die App komplett zu ist"): how Settings › Devices on a phone wakes a PC, and what it shows while no PC answers.
// - Wake: through the PC this page is connected to (devices.wake – that PC sends it, runtime/devices/wake.ts); when no PC
//   answers, or that PC has no meeting server, through the phone's own meeting-server link: the Android app ({t:'wake'}
//   over its port, answered {t:'woken'} – relay/Wake.java; an app that can says so with `wake: true` in its 'status') or
//   the iPhone web app (window.autarkHosted.wake, ui/hosted/wake.ts). Either signs with the phone's own key; the PC's wake
//   helper takes it because the PC pinned my phones (wake.ts wakeFileFor).
// - The kept list: the last live device list (with each PC's wake key) in this device's IndexedDB (DEVICES_KEY), shown
//   while the PC does not answer – as "unreachable": no PC is this page's own or online then, so each own PC with a wake
//   key offers Wake (device-version.ts rowAction).
// Owns: the way a wake takes from here, the kept list and its unreachable view. Never: holds a private key or a token
// (the list carries public keys only), or wakes anything but the PC asked for.

import { signal } from '@preact/signals';
import type { Device } from '../../shared/model/devices.ts';
import { RpcError } from '../lib/rpc-error.ts';
import { rpc } from '../lib/rpc.ts';
import { hostedShell } from '../pwa/hosted.ts';
import { idbGet, idbSet } from '../pwa/idb.ts';
import { isAndroidApp } from '../pwa/native.ts';
import { hasNativePort, onNative, sendNative } from '../pwa/native-port.ts';

/** The phone's own way to the meeting server. */
export type OwnWay = 'android' | 'hosted';

/** The Android app said in its 'status' that it wakes PCs itself (an older app says nothing and is not asked). */
export const androidWakes = signal(false);
let heard = false;

/** This page's own way to wake a PC without any PC's help, or undefined (a browser, an older phone app). */
export function ownWay(): OwnWay | undefined {
  if (isAndroidApp()) {
    if (!heard) { heard = true; onNative('status', (msg) => { androidWakes.value = msg.wake === true; }); }
    if (androidWakes.value && hasNativePort()) return 'android';
  }
  return hostedShell()?.wake ? 'hosted' : undefined;
}

/** How long the Android app may take for its answer (finding the helper and its reply: up to 10 s each). */
export const ANDROID_WAKE_MS = 25_000;

/** Asks the Android app to wake `device` with its own key; resolves on {t:'woken', id}, rejects with the app's sentence. */
export function askAndroid(device: Pick<Device, 'id' | 'name'>, key: string, waitMs: number = ANDROID_WAKE_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let off: () => void = () => undefined;
    const timer = setTimeout(() => { off(); reject(new Error(`The Autark app on this phone did not answer about ${device.name}.`)); }, waitMs);
    off = onNative('woken', (msg) => {
      if (msg.id !== device.id) return;
      clearTimeout(timer);
      off();
      if (typeof msg.error === 'string' && msg.error) reject(new Error(msg.error.slice(0, 300)));
      else resolve();
    });
    if (!sendNative({ t: 'wake', id: device.id, key, name: device.name })) { clearTimeout(timer); off(); reject(new Error('The Autark app on this phone is not ready yet – try again in a moment.')); }
  });
}

export interface WakeDeps {
  /** The page's connection to a PC is open. */
  open(): boolean;
  /** devices.wake on that PC. */
  call(id: string): Promise<unknown>;
  own: OwnWay | undefined;
  android(device: Device, key: string): Promise<void>;
  hosted(key: string, name: string): Promise<void>;
}

const liveDeps = (): WakeDeps => ({
  open: () => rpc.status.peek() === 'open',
  call: (id) => rpc.call('devices.wake', { id }),
  own: ownWay(),
  android: (device, key) => askAndroid(device, key),
  hosted: (key, name) => hostedShell()!.wake!(key, name),
});

/** True when a Wake pressed here has a way to go: an open connection to a PC, or the phone's own link. */
export const wakesFromHere = (open: boolean, own: OwnWay | undefined): boolean => open || own !== undefined;

/**
 * Wakes `device`: through the connected PC first; when it cannot ('unavailable' – no meeting server there, or the
 * connection went) or no PC answers, through the phone's own link. Returns the way it went; rejects with a sentence.
 */
export async function wakePc(device: Device, deps: WakeDeps = liveDeps()): Promise<'pc' | OwnWay> {
  const key = device.caps.wakeKey;
  const own = key ? deps.own : undefined;
  if (deps.open()) {
    try {
      await deps.call(device.id);
      return 'pc';
    } catch (error) {
      if (!own || !(error instanceof RpcError && error.code === 'unavailable')) throw error;
    }
  }
  if (!own || !key) throw new Error(`${device.name} can be woken from here only while one of your PCs is reachable.`);
  if (own === 'android') await deps.android(device, key);
  else await deps.hosted(key, device.name);
  return own;
}

// ------------------------------------------------------------------ the kept list

/** The IndexedDB key of the kept device list (pwa/idb.ts; next to D1's offline copy). */
export const DEVICES_KEY = 'devices';
const KINDS = new Set(['pc', 'phone', 'browser']);

/** A stored value as the kept list, or undefined (only rows with the parts the page reads). */
export function readDevicesCopy(value: unknown): Device[] | undefined {
  const o = value as { v?: unknown; list?: unknown } | null;
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.list)) return undefined;
  return (o.list as Array<Partial<Device> | null>).filter((row): row is Device => Boolean(row && typeof row.id === 'string'
    && typeof row.name === 'string' && KINDS.has(row.kind as string) && typeof row.status === 'string'
    && row.caps && typeof row.caps === 'object' && typeof row.fingerprint === 'string')).slice(0, 200);
}

/** Keeps a live list (never throws). */
export const keepDevices = (list: readonly Device[], now: number = Date.now()): Promise<void> =>
  idbSet(DEVICES_KEY, { v: 1, at: now, list }).catch(() => undefined);

/** The kept list, if there is one. */
export const keptDevices = (): Promise<Device[] | undefined> => idbGet<unknown>(DEVICES_KEY).then(readDevicesCopy, () => undefined);

/** The list while no PC answers this page: no PC is its own or online from here (each own PC with a wake key offers Wake). */
export function unreachableView(list: readonly Device[]): Device[] {
  return list.map((device) => (device.kind !== 'pc' ? device
    : { ...device, self: false, status: device.status === 'online' || device.status === 'connecting' ? 'offline' : device.status }));
}
