// RPC handlers: linked devices (list, rename, remove), phone/browser access (pwa.*), the live screen
// preview and the person's computer-use Stop / Resume.
// Owns: param checks and scope rules. `pwa.exchange` is callable without a token (via `POST /rpc`);
// `pwa.pushSubscribe`, `pwa.pushConfig` and `pwa.pushUnsubscribe` are open to every authenticated
// device and bound to the caller's scope; computer.activity/stop/resume to every paired device
// ('todo'); B-084 (D6): devices.list/rename/revoke also to the owner's phone on a secure transport ('settings' + secure,
// as remote.*) – Sicher-Runde 19.11.2026 devices.wake too (Wake on a PC whose app is closed, wake.ts); devices.bye answers
// main's own link only (the goodbye before a deliberate stop, away.ts, and the wake helper's file for main to start it –
// pinning my own PCs and phones, wake.ts).
// Everything else (pwa.state/enable/link/revoke, computer.preview) is owner-only.
// Never: implements mesh/PWA behaviour.

import { WorkforceError } from '../../../shared/errors.ts';
import type { Settings } from '../../../shared/model/system.ts';
import { bad, id, input, onlyKeys, optBool, optId, optNum, optOneOf, optText, text } from '../params.ts';
import { computerActivityOf } from '../../computer/activity.ts';
import { callerDeviceName } from '../device-name.ts';
import { isPhoneRoute } from '../../../shared/api/phone-route.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import type { MeshApi } from '../extras.ts';
import { relayAddress } from '../../../shared/model/relay.ts';
import { AWAY_REASONS } from '../../devices/away.ts';
import { meetingAddress } from '../../devices/connect.ts';
import type { DeviceMesh } from '../../devices/mesh.ts';
import { DevicesRepo } from '../../devices/repo.ts';
import { wakeFileFor, wakeKey, writeWakeFile } from '../../devices/wake.ts';
import { fromMain } from './security.ts';

const BINDS: readonly Settings['pwa']['bind'][] = ['localhost', 'lan', 'tailscale'];
/** B-084 (D6): device administration for my phone on a secure transport, like the PC. */
const DEVICE_ADMIN = { capability: 'settings', secure: true } as const;

/** Phones name themselves "iPhone · Safari" / "Android · Chrome" (ui/pwa/install.ts). */
function clientKind(name: string | undefined): 'phone' | 'browser' {
  return name && /^(iphone|android)\b/i.test(name) ? 'phone' : 'browser';
}

/** `{endpoint?}` of pwa.pushConfig / pwa.pushUnsubscribe: a browser's https push endpoint. */
function pushEndpoint(params: unknown): string | undefined {
  const o = input(params);
  onlyKeys(o, ['endpoint']);
  const endpoint = optText(o, 'endpoint', { max: 2000 });
  if (endpoint !== undefined && !/^https:\/\//.test(endpoint)) bad('endpoint', 'an https push endpoint');
  return endpoint;
}

/** The mesh behind extras.mesh (compose/network.ts passes core.mesh): its goodbye and wake. */
const meshOf = (ctx: HandlerContext) => ctx.extras.mesh as MeshApi & Partial<Pick<DeviceMesh, 'bye' | 'wake'>>;

/** devices.bye: the goodbye to every live link, then the wake helper's file (written fresh, or removed when nobody could wake this PC). */
async function bye(params: unknown, ctx: HandlerContext): Promise<{ ok: true; sleeper: boolean }> {
  if (!fromMain(ctx.scope)) throw new WorkforceError('forbidden', "devices.bye is the desktop app's own step right before it stops.");
  const o = input(params);
  onlyKeys(o, ['reason']);
  const reason = optOneOf(o, 'reason', AWAY_REASONS) ?? bad('reason', 'quit, update or session-end');
  await meshOf(ctx).bye?.(reason);
  const s = ctx.services;
  const relay = relayAddress(meetingAddress(s.settings.get().devices.relay) ?? '');
  const written = writeWakeFile(s.paths.data, wakeFileFor({ relay, key: wakeKey(s.db, s.clock.now()), devices: new DevicesRepo(s.db).list({ kinds: ['pc', 'phone'] }) })); // W: my phones wake it too
  return { ok: true, sleeper: reason === 'quit' && written };
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- linked devices
  table.add('devices.list', (_params, ctx) => ctx.services.devices.list(), DEVICE_ADMIN);
  table.add('devices.rename', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'name']);
    return ctx.extras.mesh.rename(id(o), text(o, 'name', { max: 60 }));
  }, DEVICE_ADMIN);
  table.add('devices.revoke', async (params, ctx) => {
    const deviceId = id(input(params));
    const device = ctx.services.devices.list().find((entry) => entry.id === deviceId);
    if (!device) throw new WorkforceError('not_found', 'Device not found.');
    // Phones/browsers hold PWA tokens and push subscriptions: those end too.
    if (device.kind === 'phone' || device.kind === 'browser') await ctx.extras.pwa.revoke(deviceId);
    else ctx.extras.mesh.revoke(deviceId);
    return { ok: true };
  }, DEVICE_ADMIN);
  table.add('devices.bye', (params, ctx) => bye(params, ctx));
  table.add('devices.wake', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const wake = meshOf(ctx).wake;
    if (!wake) throw new WorkforceError('unavailable', 'Waking PCs is not available on this PC.');
    await wake.call(ctx.extras.mesh, id(o));
    return { ok: true };
  }, DEVICE_ADMIN);

  // ---------------------------------------------------------------- phone / browser access
  table.add('pwa.state', (_params, ctx) => ctx.extras.pwa.state());
  table.add('pwa.enable', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['enabled', 'bind']);
    const enabled = optBool(o, 'enabled');
    if (enabled === undefined) bad('enabled', 'true or false');
    return ctx.extras.pwa.enable({ enabled, bind: optOneOf(o, 'bind', BINDS) });
  });
  table.add('pwa.link', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'route']);
    const route = optText(o, 'route', { max: 210 });
    if (route !== undefined && !isPhoneRoute(route)) bad('route', 'an app route such as #/home or #/chat/<id>');
    return ctx.extras.pwa.link({ name: optText(o, 'name', { max: 60 }), ...(route ? { route } : {}) });
  });
  table.add('pwa.revoke', async (params, ctx) => {
    await ctx.extras.pwa.revoke(id(input(params), 'deviceId'));
    return { ok: true };
  });
  table.add('pwa.pushSubscribe', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['subscription']);
    const subscription = o.subscription as { endpoint?: unknown } | null | undefined;
    if (!subscription || typeof subscription !== 'object' || typeof subscription.endpoint !== 'string' || !/^https:\/\//.test(subscription.endpoint)) {
      bad('subscription', 'a PushSubscription (JSON) with an https endpoint');
    }
    if (JSON.stringify(subscription).length > 4096) bad('subscription', 'at most 4 KB');
    ctx.extras.pwa.pushSubscribe(subscription, ctx.scope);
    return { ok: true };
  }, 'any');
  table.add('pwa.pushConfig', (params, ctx) => ctx.extras.pwa.pushConfig(ctx.scope, pushEndpoint(params)), 'any');
  table.add('pwa.pushUnsubscribe', (params, ctx) => ({ ok: true, removed: ctx.extras.pwa.pushUnsubscribe(ctx.scope, pushEndpoint(params)) }), 'any');
  table.add('pwa.exchange', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['secret', 'name']);
    const secret = text(o, 'secret', { max: 200 });
    const name = optText(o, 'name', { max: 60 });
    return ctx.extras.pwa.exchange(secret, { name, kind: clientKind(name) });
  }, 'any');

  // ---------------------------------------------------------------- computer use
  table.add('computer.preview', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['deviceId', 'display']);
    return ctx.extras.computer.preview({ deviceId: optId(o, 'deviceId'), display: optNum(o, 'display', { min: 0, max: 16 }) });
  });
  table.add('computer.activity', (_params, ctx) => computerActivityOf(ctx.services).current(), { capability: 'todo' });
  table.add('computer.stop', (_params, ctx) => computerActivityOf(ctx.services).stop(callerDeviceName(ctx)), { capability: 'todo' });
  table.add('computer.resume', (_params, ctx) => computerActivityOf(ctx.services).resume(), { capability: 'todo' });
}
