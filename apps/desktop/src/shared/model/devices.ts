// Device model: this PC, linked PCs, phones and browsers.
// 19.11.2026 (Sicher-Runde D2): a linked PC says why it goes (`away`, device.bye before a deliberate stop), the public key of
// its wake helper (`caps.wakeKey`, runtime/devices/wake.ts) and what its Update button did (`UpdateAnswer`, system.update).
// Fest round 22.11.2026 (G): the connection's quality now (`link`, LinkQuality – measured, never stored).
// Owns: the device registry shapes shared by runtime and UI, phone/browser access state, and the app version order (compareAppVersions).
// Never: carries private keys or one-time pairing secrets to the UI.

import type { UpdateState } from './system.ts';

export type DeviceKind = 'pc' | 'phone' | 'browser';
// Every PC is home of its own data and linked PCs are peers ('home'); 'node' is only read from older
// pairings and means nothing else; phones and browsers are 'client'.
export type DeviceRole = 'home' | 'node' | 'client';

export interface DeviceCaps {
  engines?: string[]; // engines with logged-in accounts on that device
  computerUse?: boolean;
  browser?: boolean;
  shell?: boolean;
  screens?: number;
  adbPhones?: string[]; // phones attached to that PC over ADB (serials), as it last saw them
  appPhones?: string[]; // phones whose Autark app is attached to that PC (device ids): phone.* reaches them through it
  os?: string;
  /** F25 (16.11.2026): the Autark version that PC runs (Settings › Devices; a newer one on my own PC checks for the update here). Older PCs send none. */
  version?: string;
  /** 19.11.2026: the base64url Ed25519 public key of that PC's wake helper (runtime/devices/wake.ts); absent: it cannot be woken. */
  wakeKey?: string;
}

/**
 * Fest round 22.11.2026 (G): how good this PC's connection to a device is now (runtime/devices/link-quality.ts, memory only):
 * the round trip (median of the last pings), `slow` from SLOW_LINK_MS, and for a linked PC its clock minus this PC's
 * (`offsetMs`, NTP-style); `at` is the newest sample.
 */
export interface LinkQuality { rttMs: number; slow?: true; offsetMs?: number; at: number }
/** A voice call turns awkward past ~150 ms each way (ITU-T G.114): a round trip from here on is a slow connection. */
export const SLOW_LINK_MS = 300;
/** A figure older than this says nothing about now (two catch-up rounds of a PC link, twenty pings of a page). */
export const LINK_STALE_MS = 5 * 60_000;

/** Why a linked PC is away: the person closed its app, it installs an update, or its Windows session ended. */
export type AwayReason = 'quit' | 'update' | 'session-end';
/** What a linked PC said with `device.bye` right before a deliberate stop (cleared when its link is back). */
export interface DeviceAway { reason: AwayReason; at: number }

/**
 * system.update's answer (E4): what the PC's own updater says right after its fresh check – 'downloading' / 'downloaded' /
 * 'installing' (it goes on by itself), 'current' (the official feed has nothing newer), 'available' with
 * automaticInstall false (it installs by hand there), 'error' with its message, 'development' (no updater). A PC on an
 * older version answers only `{ ok: true }`.
 */
export type UpdateAnswer = { ok: true } & Partial<Pick<UpdateState, 'status' | 'version' | 'availableVersion' | 'message' | 'automaticInstall'>>;

/**
 * Orders two app versions ("0.3.8", "0.3.6-local.3"): negative when `a` is older, 0 when equal, positive when newer. The
 * numbers count first; a pre-release ("-local.3") is older than its plain version; unreadable parts count as 0.
 */
export function compareAppVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = '', pre = ''] = value.trim().replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const diff = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (diff) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

export interface Device {
  id: string;
  name: string; // "Laptop Küche"
  kind: DeviceKind;
  role: DeviceRole;
  fingerprint: string; // sha256 of the device public key
  addresses: string[]; // base URLs it was reached on (LAN, tailnet, the address the meeting server saw)
  caps: DeviceCaps;
  /** Linked PCs: 'connecting' until the first dial ends, 'offline' after a failed dial or a closed link. */
  status: 'online' | 'connecting' | 'offline' | 'pairing' | 'revoked';
  self: boolean; // this installation
  pairedAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
  /**
   * A linked PC that joined as an employee: the person (people/*) it belongs to. Absent = the CEO's
   * own device (everything the same). An employee's PC may not run tools on this PC.
   */
  personId?: string;
  /** B-081: this PC joined that PC – as its CEO (everything the same) or as an employee there (files stay there). */
  joinedAs?: 'ceo' | 'employee';
  /** 19.11.2026: a linked PC that said goodbye before a deliberate stop (device.bye); gone again once its link is back. */
  away?: DeviceAway;
  /** G (22.11.2026): this PC's connection to it now, while measured (never stored). */
  link?: LinkQuality;
}

export interface PwaState {
  enabled: boolean;
  urls: string[]; // reachable URLs (localhost, LAN, tailnet)
  secure: boolean; // https available (needed for install/mic/push on phones)
  /** Paired phones/browsers; `notifications` = the PC holds a push subscription from it. */
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt?: number; notifications?: boolean }>;
  /** The PC can send Web Push: its VAPID key is available. */
  pushReady: boolean;
  vapidPublicKey?: string; // base64url VAPID public key for PushManager.subscribe (when pushReady)
}

/**
 * What a phone/browser needs to turn notifications on (pwa.pushConfig, open to every paired
 * device): whether the PC can push, the key to subscribe with, and whether this very browser's
 * subscription is stored on the PC (the "On" state – a granted browser permission alone is not).
 */
export interface PushConfig {
  pushReady: boolean;
  vapidPublicKey?: string;
  subscribed: boolean;
  /** Why push is not ready ("The PC could not prepare notifications." …), when it is not. */
  reason?: string;
}
