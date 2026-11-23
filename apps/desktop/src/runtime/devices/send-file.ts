// devices.send_file: a file or a whole folder goes to another linked PC over the mesh's RPC, one piece of 1 MiB at a
// time. The tool is a remote one, so `device` picks the PC the file lies on: with `device: "Tower", to: "<this PC's
// name>"` a file comes from Tower to here ("this" there would mean Tower itself). Umzug 21.11.2026 (PCSEC): `path` may
// be a folder – walked with everything in it, its layout kept, empty folders too; a link to a folder is not followed
// (the answer counts them) – and `at` names a folder on the receiving PC. Where it lands without `at` (the same folder
// as here when that PC has it, else its inbox/<this PC>/) and the free name are the receiver's (receive-file.ts); a PC
// on a version before this one takes single files into its inbox.
// Owns: this tool and the sending side of a transfer. Never: overwrites a file there, or leaves a partial one after a
// stop (an abort tells the receiver to drop it).

import { randomUUID } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { readPath } from '../tools/builtin/files.ts';
import { clip, defineTool } from '../tools/builtin/util.ts';
import { resolveDevice } from '../tools/placement.ts';
import { failure, json, type ToolContext } from '../tools/types.ts';
import { WAIT_MS } from '../security/approvals.ts';

/** A piece's base64 stays well under the channel's frame limit (8 MiB, channel.ts). */
const PIECE_BYTES = 1024 * 1024; // B-077: 1 MiB, so the link's keepalive pings never wait long behind one piece
/** `begin` may wait for the person's answer there (security.otherPcs ask). */
const BEGIN_MS = WAIT_MS + 30_000;

type Put = (params: Record<string, unknown>, timeoutMs?: number) => Promise<{ path?: string; landing?: string; note?: string; files?: number }>;

/** Everything in `root`: files and empty folders by their path relative to it ('/' between parts), sorted. */
async function walk(root: string): Promise<{ files: Array<{ rel: string; abs: string }>; empty: string[]; links: number; bytes: number }> {
  const out = { files: [] as Array<{ rel: string; abs: string }>, empty: [] as string[], links: 0, bytes: 0 };
  const visit = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length && rel) out.empty.push(rel);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(abs, next);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = await stat(abs).catch(() => undefined); // a link counts as what it points to
        if (info?.isFile()) { out.files.push({ rel: next, abs }); out.bytes += info.size; } else if (entry.isSymbolicLink()) out.links++;
      }
    }
  };
  await visit(root, '');
  return out;
}

/** Sends one file in pieces (`extra`: its place in a folder); the receiver's path of it. */
async function sendPieces(put: Put, file: string, ctx: ToolContext, extra: Record<string, unknown>): Promise<{ path?: string; bytes: number }> {
  const size = (await stat(file)).size;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(PIECE_BYTES);
    let offset = 0;
    for (;;) {
      ctx.signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, PIECE_BYTES, offset);
      const last = offset + bytesRead >= size;
      const answer = await put({ ...extra, offset, dataBase64: buffer.subarray(0, bytesRead).toString('base64'), last });
      offset += bytesRead;
      if (last) return { path: answer.path, bytes: offset };
      if (!bytesRead) throw new WorkforceError('conflict', 'The file got shorter while it was being sent.');
    }
  } finally {
    await handle.close();
  }
}

/** The answer of a receiver on a version before folders and `at` (it refuses `begin` as a piece without data). */
const olderReceiver = (error: unknown): boolean => /needs name, offset and dataBase64/.test(String((error as Error)?.message ?? error));

export const sendFile = defineTool<{ to: string; path: string; at?: string }>({
  name: 'devices.send_file',
  description: "Sends my file or folder (with everything in it) to a linked PC: into at there, else into the same folder when that PC has it, else its inbox; a taken name gets \" (2)\". Run on that PC (device) with to: this PC, it fetches one instead.",
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['to', 'path'],
    properties: {
      to: { type: 'string', minLength: 1, maxLength: 120, description: 'A PC from devices.list.' },
      path: { type: 'string', minLength: 1, maxLength: 1024 },
      at: { type: 'string', minLength: 1, maxLength: 1024, description: 'An absolute folder on that PC.' },
    },
  },
  category: 'write_local', remote: true,
  describe: (args) => ({ summary: `Send ${clip(args.path, 80)} to ${clip(args.to, 40)}${args.at ? ` (${clip(args.at, 60)})` : ''}`, resource: args.path, reversible: true, external: false }),
  async run(args, ctx) {
    const target = resolveDevice(ctx.services, args.to);
    if ('error' in target) return failure(target.error);
    if (target.self || !target.id) return failure(`${target.name} is the PC the file already lies on.`);
    const source = await readPath(ctx, args.path);
    const info = await stat(source).catch(() => undefined);
    const folder = Boolean(info?.isDirectory());
    if (!info || (!folder && !info.isFile())) return failure(`There is no file or folder at ${args.path}.`);
    const id = randomUUID();
    const put: Put = (params, timeoutMs) => ctx.services.devices.call(target.id!, 'files.put', { id, ...params }, ctx.signal, timeoutMs) as ReturnType<Put>;
    const name = path.basename(source);
    const tree = folder ? await walk(source) : undefined;
    let begun: Awaited<ReturnType<Put>> = {};
    let older = false;
    try {
      begun = await put({ begin: {
        name, folder, size: tree?.bytes ?? info.size, from: path.dirname(source), ...(args.at ? { at: args.at } : {}),
        agentId: ctx.agent.id, agentName: ctx.agent.name, ...(ctx.conversationId ? { chatId: ctx.conversationId } : {}), ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      } }, BEGIN_MS);
    } catch (error) {
      if (!olderReceiver(error)) throw error;
      if (folder || args.at) return failure(`${target.name} runs an older Autark that takes single files into its inbox only; after its update it takes folders and at.`);
      older = true;
    }
    try {
      if (!folder) {
        const sent = await sendPieces(put, source, ctx, older ? { name } : {});
        return json({ ok: true, sentTo: target.name, path: sent.path, bytes: sent.bytes, ...(begun.note ? { note: begun.note } : {}) });
      }
      if (!tree) throw new WorkforceError('conflict', 'The folder could not be read.');
      for (const rel of tree.empty) { ctx.signal.throwIfAborted(); await put({ rel, dir: true }); }
      let bytes = 0;
      for (const file of tree.files) bytes += (await sendPieces(put, file.abs, ctx, { rel: file.rel })).bytes;
      const done = await put({ done: true });
      return json({
        ok: true, sentTo: target.name, path: done.path ?? begun.landing, files: done.files ?? tree.files.length, bytes,
        ...(tree.links ? { linksNotFollowed: tree.links } : {}), ...(begun.note ? { note: begun.note } : {}),
      });
    } catch (error) {
      await ctx.services.devices.call(target.id, 'files.put', { id, abort: true }).catch(() => undefined);
      throw error;
    }
  },
});
