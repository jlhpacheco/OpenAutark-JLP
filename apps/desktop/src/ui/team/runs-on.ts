// Where an agent runs, said the same way everywhere (owner 21.11.2026: "ein klareres System, wo ein Agent läuft … muss
// mehr in die UI … verständlicher für alle, nicht nur KI, sondern auch Menschen"). An agent runs on one PC: this one
// (no deviceId), another PC of the person's own, or – on an employee's PC – a PC of the company they work for. With no
// other PC linked there is nothing to say, so nothing shows. The agent page names it ("Runs on", with a move to another
// own PC – the runtime's 'Works on', agents.update deviceId), the team list names it for an agent that is not here, and
// the live bar names the PC whose run it shows. Every PC row comes from devices.list once, then 'device.upserted' /
// 'device.removed' keep it current; no polling.
// Owns: that PC list, the rule and its words. Never: moves an agent itself or draws anything.

import { signal } from '@preact/signals';
import type { Device } from '../../shared/model/devices.ts';
import type { Agent } from '../../shared/model/org.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';

/** Every PC this one knows (itself too), not removed or half-paired. */
export const pcs = signal<Device[]>([]);
let watched = false;

const isPc = (device: Device) => device.kind === 'pc' && device.status !== 'revoked' && device.status !== 'pairing';

/** Starts keeping `pcs` current (idempotent; a device without devices.list – a phone – keeps it empty). */
export function watchPcs(): void {
  if (watched || !can('devices.list')) return;
  watched = true;
  const refresh = () => { rpc.call('devices.list').then((list) => { pcs.value = list.filter(isPc); }, () => undefined); };
  rpc.on('device.upserted', (device) => {
    const rest = pcs.peek().filter((entry) => entry.id !== device.id);
    pcs.value = isPc(device) ? [...rest, device] : rest;
  });
  rpc.on('device.removed', ({ id }) => { pcs.value = pcs.peek().filter((entry) => entry.id !== id); });
  rpc.onOpen(refresh);
  refresh();
}

/** Where an agent runs: this PC, one of my own PCs, or a PC of the company I work for (an employer's PC). */
export interface RunsOn {
  /** The PC's id; undefined = this PC. */
  id?: string;
  name: string;
  here: boolean;
  /** A PC of the company this person works for (it never runs here, and it is not mine to move). */
  company: boolean;
  online: boolean;
}

/** Where `agent` runs; undefined where this PC has no other PC (nothing to tell apart). */
export function runsOn(agent: Pick<Agent, 'deviceId'>, list: readonly Device[] = pcs.value): RunsOn | undefined {
  const self = list.find((device) => device.self);
  const others = list.filter((device) => !device.self);
  if (!others.length) return undefined;
  if (!agent.deviceId || agent.deviceId === self?.id) return { name: self?.name ?? 'This PC', here: true, company: false, online: true };
  const pc = others.find((device) => device.id === agent.deviceId);
  // A PC this one has no link to: on an employee's PC a company PC, else another of my own.
  const company = pc ? pc.joinedAs === 'employee' : others.some((device) => device.joinedAs === 'employee');
  return { id: agent.deviceId, name: pc?.name ?? (company ? 'a company PC' : 'another PC'), here: false, company, online: pc?.status === 'online' };
}

/** "This PC" · "Tower" · "MomosDojo · company PC" – and "· offline" when that PC is not reachable now. */
export function runsOnText(where: RunsOn): string {
  if (where.here) return `This PC (${where.name})`;
  return [where.name, where.company ? 'company PC' : '', where.online ? '' : 'offline'].filter(Boolean).join(' · ');
}

/** A PC's name for a line ("This runs on Tower"); 'another of your PCs' while the list does not know it. */
export function pcLabel(id: string): string {
  return pcs.value.find((device) => device.id === id)?.name ?? 'another of your PCs';
}

/** The PCs an agent of mine can move to: this one and my own other PCs that are online (the runtime refuses an offline one). */
export function moveTargets(list: readonly Device[] = pcs.value): Device[] {
  return list.filter((device) => device.self || (!device.personId && device.joinedAs !== 'employee' && device.status === 'online'));
}
