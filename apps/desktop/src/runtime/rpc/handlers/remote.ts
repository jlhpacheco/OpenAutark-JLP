// RPC handlers: connecting PCs (Settings › Devices) – this PC's IDs and requests, connecting to another PC by an ID or
// address, deciding requests waiting here (a new member with a name or the person it belongs to, or – F13 – a new person;
// F17: also one waiting on another of my PCs, decided there), and the PCs on this network.
// Eine-ID 22.11.2026: remote.connect takes no role (the PC asked decides from the ID) but the name I propose as a new
// member; remote.name changes that name while my request waits. Review 22.11.2026: remote.confirm is my yes to becoming
// one of the other person's devices (the request stops at 'confirm' until then).
// The owner and – B-084 (D6) – the owner's phone on a secure transport ('settings' + secure: the app's tunnel, HTTPS or
// the tailnet; a plain LAN browser and people never), so Settings › Devices on the phone is the PC's.
// Whether other PCs may ask at all is settings.devices.findable (settings.json).
// Owns: param checks and the device tier. Never: request logic, or returning keys or session secrets.

import { WorkforceError } from '../../../shared/errors.ts';
import { readDecide } from '../../remote/mirror.ts';
import { input, onlyKeys, optBool, optText, text } from '../params.ts';
import type { RemoteApi } from '../extras.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

/** B-084 (D6): device administration for my phone on a secure transport, like the PC. */
const DEVICE_ADMIN = { capability: 'settings', secure: true } as const;

function remoteOf(ctx: HandlerContext): RemoteApi {
  if (!ctx.extras.remote) throw new WorkforceError('unavailable', 'Connecting PCs is not available on this PC.');
  return ctx.extras.remote;
}

export function register(table: HandlerTable): void {
  table.add('remote.state', (_params, ctx) => remoteOf(ctx).state(), DEVICE_ADMIN);
  table.add('remote.connect', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['target', 'name']);
    const name = optText(o, 'name', { max: 200, allowEmpty: true })?.trim();
    return remoteOf(ctx).connect({ target: text(o, 'target', { max: 200 }), ...(name ? { name } : {}) });
  }, DEVICE_ADMIN);
  table.add('remote.name', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name']);
    await remoteOf(ctx).rename(text(o, 'name', { max: 200, allowEmpty: true }));
    return { ok: true as const };
  }, DEVICE_ADMIN);
  table.add('remote.confirm', (_params, ctx) => remoteOf(ctx).confirm(), DEVICE_ADMIN);
  table.add('remote.cancel', (_params, ctx) => { remoteOf(ctx).cancel(); return { ok: true as const }; }, DEVICE_ADMIN);
  table.add('remote.decide', async (params, ctx) => {
    const { id, accept, personId, newPerson } = readDecide(params, (person) => Boolean(ctx.services.people?.get(person)));
    await remoteOf(ctx).decide(id, accept, personId, newPerson);
    return { ok: true as const };
  }, DEVICE_ADMIN);
  table.add('remote.nearby', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['refresh']);
    return remoteOf(ctx).nearby(optBool(o, 'refresh') ?? false);
  }, DEVICE_ADMIN);
}
