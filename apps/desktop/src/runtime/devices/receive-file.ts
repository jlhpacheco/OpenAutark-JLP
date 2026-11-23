// The peer method 'files.put' – the receiving side of devices.send_file (send-file.ts): a file or a whole folder from a
// linked PC, one piece of at most 1 MiB at a time. Umzug 21.11.2026 (PCSEC): a transfer starts with `begin`, which passes
// this PC's `security.otherPcs` for the sending agent (other-pcs.ts), picks the place (landing.ts) and refuses with the
// numbers when the announced size does not fit the free space there. A file grows as `.<id>.part` and takes its free
// name at its last piece; a folder grows as the working folder `.<id>.partdir` and takes its free name at `done` – a
// partial one never looks finished. A transfer without a piece for IDLE_MS (a lost link, a sender that stopped) is
// dropped with what it wrote; an abort does the same at once. A PC on a version before this one sends pieces without
// `begin`: its first piece opens the transfer into the inbox.
// Owns: 'files.put' and the open transfers. Never: overwrites a file, writes outside the landing folder, or keeps a
// partial file or folder after a transfer ended without its last piece.

import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { decodeBase64 } from '../rpc/uploads.ts';
import { fingerprintOf } from '../security/policy.ts';
import { gateOtherPcs } from './other-pcs.ts';
import { clean, freeBytes, landing, placeFile, placeFolder, sizeText } from './landing.ts';

const ID = /^[0-9a-f-]{36}$/;
/** A transfer without a piece this long ended without its last piece (its sender or the link is gone). */
export const IDLE_MS = 5 * 60_000;

interface Transfer { dir: string; name: string; work?: string; files: number; lastAt: number }
interface Open { map: Map<string, Transfer>; timer?: ReturnType<typeof setInterval> }
const opened = new WeakMap<object, Open>();

function openOf(services: RuntimeServices): Open {
  let entry = opened.get(services);
  if (!entry) { entry = { map: new Map() }; opened.set(services, entry); }
  return entry;
}

/** Keeps `transfer` open, with the idle check running while any transfer is. */
function keep(services: RuntimeServices, id: string, transfer: Transfer): void {
  const entry = openOf(services);
  entry.map.set(id, transfer);
  if (!entry.timer) { entry.timer = setInterval(() => void dropIdle(services), 60_000); entry.timer.unref?.(); }
}

/** Ends a transfer and removes what it wrote (its part file or its working folder). */
async function discard(services: RuntimeServices, id: string): Promise<void> {
  const entry = openOf(services);
  const transfer = entry.map.get(id);
  entry.map.delete(id);
  if (!entry.map.size && entry.timer) { clearInterval(entry.timer); entry.timer = undefined; }
  if (!transfer) return;
  if (transfer.work) await rm(transfer.work, { recursive: true, force: true, maxRetries: 3 });
  else await rm(path.join(transfer.dir, `.${id}.part`), { force: true });
}

/** Drops each transfer whose last piece is at least `idleMs` old, with what it wrote; how many. */
export async function dropIdle(services: RuntimeServices, idleMs = IDLE_MS): Promise<number> {
  const now = Date.now();
  const idle = [...openOf(services).map].filter(([, transfer]) => now - transfer.lastAt >= idleMs).map(([id]) => id);
  for (const id of idle) await discard(services, id).catch(() => undefined);
  return idle.length;
}

interface Begin { name: string; folder: boolean; size?: number; from?: string; at?: string; agentId?: string; agentName?: string; chatId?: string; taskId?: string }

function readBegin(value: unknown): Begin {
  const b = (value ?? {}) as Record<string, unknown>;
  const text = (key: string, max = 1024): string | undefined => (typeof b[key] === 'string' && (b[key] as string).length <= max && b[key] !== '' ? b[key] as string : undefined);
  const name = text('name', 260);
  if (!name) throw new WorkforceError('bad_request', 'A transfer names its file or folder.');
  const size = typeof b.size === 'number' && Number.isFinite(b.size) && b.size >= 0 ? b.size : undefined;
  return {
    name, folder: b.folder === true, ...(size === undefined ? {} : { size }), from: text('from'), at: text('at'), agentId: text('agentId', 200),
    agentName: text('agentName', 80), chatId: text('chatId', 200), taskId: text('taskId', 200),
  };
}

/** The relative path of a file inside a folder transfer, as clean names (never `..`, never absolute). */
function relParts(rel: unknown): string[] {
  if (typeof rel !== 'string' || !rel || rel.length > 2048) throw new WorkforceError('bad_request', 'A piece of a folder names its place in it (rel).');
  return rel.split('/').map((part) => clean(part, '_'));
}

type Piece = { id?: unknown; name?: unknown; offset?: unknown; dataBase64?: unknown; last?: unknown; abort?: unknown; begin?: unknown; rel?: unknown; dir?: unknown; done?: unknown };
type Answer = { ok: true; path?: string; landing?: string; note?: string; files?: number };

/** The peer method: begin a transfer, one piece of a file, an empty folder, the end, or an abort. */
export async function receivePiece(services: RuntimeServices, params: unknown, fromDeviceId: string, signal?: AbortSignal): Promise<Answer> {
  const p = (params ?? {}) as Piece;
  if (typeof p.id !== 'string' || !ID.test(p.id)) throw new WorkforceError('bad_request', 'A file piece needs its transfer id.');
  const id = p.id;
  let from = 'linked PC';
  try { from = services.devices.list().find((device) => device.id === fromDeviceId)?.name ?? from; } catch { /* unnamed */ }
  if (p.begin !== undefined) return begin(services, id, readBegin(p.begin), from, signal);
  if (p.abort === true) { await discard(services, id); await rm(path.join(inboxOf(services, from), `.${id}.part`), { force: true }); return { ok: true }; }
  let transfer = openOf(services).map.get(id);
  if (!transfer && typeof p.name === 'string' && p.offset === 0) transfer = await legacyBegin(services, id, p.name, from);
  if (!transfer) throw new WorkforceError('conflict', 'This transfer is no longer open here (it stopped); I send it again from the start.');
  transfer.lastAt = Date.now();
  try {
    if (transfer.work && p.done === true) {
      const placed = await placeFolder(transfer.work, transfer.dir, transfer.name);
      transfer.work = undefined; // in place: nothing to remove any more
      await discard(services, id);
      return { ok: true, path: placed, files: transfer.files };
    }
    const parts = transfer.work ? relParts(p.rel) : [transfer.name];
    if (transfer.work && p.dir === true) { await mkdir(path.join(transfer.work, ...parts), { recursive: true }); return { ok: true }; }
    const dir = transfer.work ? path.join(transfer.work, ...parts.slice(0, -1)) : transfer.dir;
    const placed = await putPiece(dir, `.${id}.part`, parts.at(-1)!, p);
    if (!placed) return { ok: true };
    if (transfer.work) { transfer.files++; return { ok: true, path: placed }; }
    await discard(services, id);
    return { ok: true, path: placed };
  } catch (error) {
    await discard(services, id); // a broken piece ends the transfer with what it wrote
    throw error;
  }
}

async function begin(services: RuntimeServices, id: string, ask: Begin, from: string, signal?: AbortSignal): Promise<Answer> {
  await gateOtherPcs(services, {
    agentId: ask.agentId, agentName: ask.agentName, summary: `Receive the ${ask.folder ? 'folder' : 'file'} ${ask.name}`,
    fingerprint: fingerprintOf('files.put', { name: ask.name, folder: ask.folder, from: ask.from ?? null, at: ask.at ?? null }), chatId: ask.chatId, taskId: ask.taskId, signal,
  }, from);
  const place = await landing(services, ask, from);
  if (ask.size !== undefined) {
    const free = await freeBytes(place.dir);
    if (free !== undefined && free < ask.size) {
      const here = (() => { try { return services.devices.self().name || 'this PC'; } catch { return 'this PC'; } })();
      throw new WorkforceError('conflict', `${ask.name} is ${sizeText(ask.size)}, and ${here} has only ${sizeText(free)} free where it would land (${place.dir}).`);
    }
  }
  await mkdir(place.dir, { recursive: true });
  const work = ask.folder ? path.join(place.dir, `.${id}.partdir`) : undefined;
  if (work) await mkdir(work);
  keep(services, id, { dir: place.dir, name: clean(ask.name, ask.folder ? 'folder' : 'file'), ...(work ? { work } : {}), files: 0, lastAt: Date.now() });
  return { ok: true, landing: place.dir, ...(place.note ? { note: place.note } : {}) };
}

const inboxOf = (services: RuntimeServices, from: string): string => path.join(services.paths.workspace, 'inbox', clean(from, 'linked PC'));

/** The first piece from a PC on a version before `begin`: past `otherPcs` (it names no agent), into the inbox. */
async function legacyBegin(services: RuntimeServices, id: string, name: string, from: string): Promise<Transfer> {
  await gateOtherPcs(services, { summary: `Receive the file ${name}`, fingerprint: '' }, from);
  const transfer: Transfer = { dir: inboxOf(services, from), name: clean(name, 'file'), files: 0, lastAt: Date.now() };
  keep(services, id, transfer);
  return transfer;
}

/** One piece appended to `part` in `dir`; the last one puts the file in place under a free `name` (its path). */
async function putPiece(dir: string, part: string, name: string, p: Piece): Promise<string | undefined> {
  if (typeof p.dataBase64 !== 'string' || typeof p.offset !== 'number') throw new WorkforceError('bad_request', 'A file piece needs name, offset and dataBase64.');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, part);
  const have = (await stat(file).catch(() => undefined))?.size ?? 0;
  if (have !== p.offset) throw new WorkforceError('conflict', `This file piece does not follow the last one (${have} bytes so far).`);
  await appendFile(file, decodeBase64(p.dataBase64, 'dataBase64'));
  return p.last === true ? placeFile(file, dir, name) : undefined;
}
