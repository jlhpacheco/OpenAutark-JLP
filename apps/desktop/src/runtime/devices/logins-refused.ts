// 24.11.2026 (ORENDA find, Konrad: "logins not sent … forbidden" came 231 times in an hour and told nobody): which linked PCs
// refuse the plan logins this PC sends them (LoginSync, devices/sync/logins.ts stops sending there until something relevant
// changes). Kept in memory only, like the connection quality (link-quality.ts): Settings › Devices reads it from the device
// row (`loginsRefused`) and says in words that this PC's sign-ins are not shared there and what the person can do.
// Owns: the memory of who refuses and withLoginsRefused(). Never: stores anything, decides when a send is tried again.

import type { Device } from '../../shared/model/devices.ts';

const refused = new Map<string, number>();

/** `deviceId` answered 'forbidden' to the logins sent to it (at `at`); true when that is news (it did not refuse before). */
export function noteLoginsRefused(deviceId: string, at = Date.now()): boolean {
  const news = !refused.has(deviceId);
  refused.set(deviceId, at);
  return news;
}

/** The refusal is over (a new connection, another role there, or it took a login after all); true when there was one. */
export function clearLoginsRefused(deviceId: string): boolean {
  return refused.delete(deviceId);
}

export const loginsRefused = (deviceId: string): number | undefined => refused.get(deviceId);

/** `device` with its refusal (`loginsRefused`), as Settings › Devices and devices.list show it. */
export function withLoginsRefused<T extends { id: string }>(device: T): T & Pick<Device, 'loginsRefused'> {
  const at = refused.get(device.id);
  return at === undefined ? device : { ...device, loginsRefused: { at } };
}
