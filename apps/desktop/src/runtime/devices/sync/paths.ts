// A file, folder or media tab that came from another of the CEO's PCs reads and writes there (B-076, mesh method
// 'files.path', the way computer.preview asks a linked PC): files.readPath / writePath / listPath and the media tab's
// files.uploadPath name that PC in `device`, and this PC asks it – when its link is down at once "<name> is offline",
// so the tab says so calmly and its next look tries again. The other PC answers with its own file-tab rules
// (rpc/handlers/files-path.ts PATH_OPS – a stamp conflict stays a conflict). A media file it stores ('store') comes back
// with its `files` row, which this PC takes like a synced row (rows.ts); the bytes follow when first shown (blobs.ts
// needBlob pulls them from there). One mesh frame holds at most 8 MiB (channel.ts) and a larger one closes the whole
// link, so a save that cannot fit stays here with a clear answer, and a read whose text would not fit answers 'large'.
// B-081: a missing path's `near` (its similar paths, found there) comes back as it is; 'root' answers that PC's <data>,
// workspace and map – system.root with `device`, the new-tab page's Files cell of that PC.
// Sicher-Runde 19.11.2026 (REVIEW-2 3): the request names who asks (`by`: the person, an agent with its id and name, or
// neither – a script); this PC gates it with its own settings like a forwarded tool call (security/tool-gate.ts
// gateForwarded): an agent's read/list/store passes `read`, its write `write`, for that path – it may wait for the person's
// answer –, a call naming neither passes only what is open, the person's passes as it is. A PC older than
// GATES_FORWARDED_FROM gets no `by` (it would refuse the unknown key); there the sender's gate with the path is all.
// 20.11.2026: a network path (`\\host\share\…`) asked by an agent or a script is refused here until the person confirmed
// that host on this PC (files/net-hosts.ts); the person's own request was asked on the PC it came from.
// Umzug 21.11.2026 (PCSEC H1): before that, every request but the person's passes this PC's `security.otherPcs`
// (other-pcs.ts gateOtherPcs – the one check for every way an agent on another PC reaches this PC: tools.call,
// files.put and these paths; a request naming no agent counts as refused under ask and no).
// 21.11.2026 (pane between people, shared/model/pane.ts): an employee's PC or the company's PC (for its CEO, or `for` the
// colleague whose call it passes on, pane/relay.ts) gets a path only when it lies in a path shared with that person
// (pane/shares.ts reach, key 'path:<abs>'; resolved here first, never 'root'); the CEO's own PCs as before. A PC that is
// no link here is asked through the company's PC (callPc). Such a caller's claim to speak for the person (`by.person`)
// counts only from the CEO's own PCs, a link inside a shared folder is checked where it really leads, and a missing
// path's `near` (names around it, outside the share) stays here.
// Owns: this forwarding and the peer method. Never: answers an unshared path to a PC that is no 'ceo' link, passes a
// request on to a third PC, or logs a path or a file's content.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../../shared/errors.ts';
import type { FileRef, RootInfo } from '../../../shared/model/system.ts';
import '../../contracts/open-fs.ts'; // rootMaps on RuntimeServices (module augmentation)
import type { RuntimeServices } from '../../contracts.ts';
import { ROOT_README } from '../../root/layout.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../shared/ids.ts';
import { SECURITY_LABELS, type SecuritySwitch } from '../../../shared/model/security-settings.ts';
import { fingerprintOf } from '../../security/policy.ts';
import { WAIT_MS } from '../../security/approvals.ts';
import { peerGates } from '../../security/tool-gate.ts';
import { checkNetHost } from '../../files/net-hosts.ts';
import { DevicesRepo } from '../repo.ts';
import { isCeoPc, linkOf } from './home.ts';
import { gateOtherPcs } from '../other-pcs.ts';
import { reach } from '../../pane/shares.ts';
import { callPc } from '../../pane/relay.ts';
import type { RowSync } from './rows.ts';

export type PathOp = 'read' | 'write' | 'list' | 'store' | 'root';
type Obj = Record<string, unknown>;
/** This PC's own operations on checked parameters (files-path.ts PATH_OPS). */
export type PathOps = Record<'read' | 'write' | 'list', (o: Obj) => Promise<unknown>>;
/** Who asks for another PC's file: the person, one of the company's agents, or a session that names neither (a script). */
export type PathCaller = { person: true } | { agentId: string; agentName?: string } | Record<string, never>;

const plain = (value: unknown): value is Obj => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** What a request or an answer between PCs may hold, under the mesh's 8 MiB frame (channel.ts) with room for the rest. */
const FRAME_ROOM = 7 * 1024 * 1024;
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

export class RemotePaths {
  private readonly s: RuntimeServices;
  private readonly rows: RowSync;
  private readonly ops: PathOps;

  constructor(s: RuntimeServices, rows: RowSync, ops: PathOps) {
    this.s = s;
    this.rows = rows;
    this.ops = ops;
    hubs.set(s, this);
  }

  /** Runs `op` on PC `device` (parameters without `device`) for `by` – linked here, else through the company's PC; a media file stored there arrives with its row. */
  async forward(device: string, op: PathOp, params: Obj, by: PathCaller = {}): Promise<unknown> {
    const record = new DevicesRepo(this.s.db).get(device);
    const linked = Boolean(linkOf(record));
    const name = record?.name ?? 'That PC';
    if (linked && !this.s.devices.online(device)) throw new WorkforceError('unavailable', `${name} is offline.`, { details: { deviceId: device, reachable: false } });
    if (op === 'write' && bytesOf(params) > FRAME_ROOM) throw new WorkforceError('bad_request', `This text is too large to save on ${name} (about 7 MB at most between PCs).`, { details: { deviceId: device } });
    const gates = !linked || peerGates(record?.caps?.version); // a PC reached through the company's PC is new enough to share
    const waits = gates && !('person' in by); // that PC may ask the person first (up to WAIT_MS)
    const sent = { ...params, op, ...(gates ? { by } : {}) };
    const answer = await callPc(this.s, device, 'files.path', sent, undefined, waits ? WAIT_MS + 30_000 : undefined);
    if (op !== 'store') return answer;
    const { ref, item } = (plain(answer) ? answer : {}) as { ref?: FileRef; item?: unknown };
    if (!ref) throw new WorkforceError('unavailable', `${name} did not send the file.`);
    if (item) await this.rows.receive({ items: [item] }, device).catch((error: unknown) => this.s.log.info('stored file row not taken', { id: ref.id, error: String((error as Error)?.message ?? error) }));
    return ref;
  }

  /** 'files.path' from a linked PC: the operation here – for anyone but the CEO's own PCs only on a path shared with its person. */
  async serve(params: unknown, from: string): Promise<unknown> {
    const { op, by: claimed, for: forPerson, ...rest } = plain(params) ? params : {};
    const ceo = isCeoPc(this.s.db, from);
    if (!ceo) rest.path = this.sharedPath(op, rest.path, from, forPerson);
    const by = ceo ? claimed : plain(claimed) ? { ...claimed, person: undefined } : claimed; // only my own PCs speak for me
    if (!(plain(by) && by.person === true)) checkNetHost(this.s.db, rest.path); // the person's PC asked its person already
    await this.gate(op, rest, by, from);
    const out = (answer: unknown) => (ceo || !plain(answer) ? answer : { ...answer, near: undefined }); // no names from outside a share
    if (op === 'read') {
      const answer = await this.ops.read(rest);
      if (!plain(answer) || bytesOf(answer) <= FRAME_ROOM) return out(answer);
      const { text: _text, ...facts } = answer;
      return out({ ...facts, state: 'large' });
    }
    if (op === 'write' || op === 'list') return out(await this.ops[op](rest));
    if (op === 'root') return this.root();
    if (op !== 'store') throw new WorkforceError('bad_request', 'Unknown file request.');
    if (Object.keys(rest).some((key) => key !== 'path') || typeof rest.path !== 'string' || !path.isAbsolute(rest.path)) throw new WorkforceError('bad_request', 'A stored file needs its absolute path.');
    const ref = await this.s.files.putPath(rest.path);
    return { ref, item: this.rows.fileItem(ref.id) };
  }

  /** This PC's gate for a linked PC's file request (see the header); throws 'forbidden' with the refusal's text. */
  private async gate(op: unknown, rest: Obj, by: unknown, from: string): Promise<void> {
    const security = this.s.security;
    const target = typeof rest.path === 'string' ? rest.path : undefined;
    const caller = (plain(by) ? by : {}) as { person?: unknown; agentId?: unknown; agentName?: unknown };
    if (caller.person === true) return;
    const capability: SecuritySwitch = op === 'write' ? 'write' : 'read';
    const fingerprint = fingerprintOf(`files.path.${String(op)}`, { path: target ?? null });
    const pc = new DevicesRepo(this.s.db).get(from)?.name ?? 'a linked PC';
    const agentId = typeof caller.agentId === 'string' && caller.agentId ? caller.agentId : undefined;
    const named = typeof caller.agentName === 'string' ? caller.agentName.slice(0, 60) : undefined;
    await gateOtherPcs(this.s, { // Umzug H1: what calls from agents on other PCs get here
      agentId, agentName: named ? `${named} (${pc})` : undefined, fingerprint: `${fingerprint}:otherPcs`,
      summary: op === 'root' ? 'Look at its folders' : `${capability === 'write' ? 'Change' : 'Read'} ${target ?? 'a file'}`,
    }, pc);
    if (!security || op === 'root' || !target) return; // a request without a path is refused by its operation
    if (agentId && agentId !== HUMAN_ID && agentId !== SYSTEM_ID) {
      let known: string | undefined;
      try { known = this.s.org.get(agentId)?.name; } catch { known = undefined; }
      const result = await security.gate({
        agentId, capability, path: target, fingerprint, summary: `${capability === 'write' ? 'Change' : 'Read'} ${target} (from ${pc})`,
        ...(known ? {} : { agentName: named ? `${named} (${pc})` : `Agent from ${pc}` }),
      });
      if (!result.ok) throw new WorkforceError('forbidden', result.text);
      return;
    }
    if (security.check({ agentId: '', capability, path: target, fingerprint }) === 'open') return;
    throw new WorkforceError('forbidden', `${SECURITY_LABELS[capability]} is closed on ${this.selfName()} for this file, and the call from ${pc} names no agent (a script, or a PC on an older Autark – updating it helps): there is nobody the app could ask. The person opens the file in Autark.`);
  }

  /** The absolute path, resolved here (no '..' out of a shared folder), when it is shared with the caller's person; else 'forbidden'. */
  private sharedPath(op: unknown, value: unknown, from: string, forPerson: unknown): string {
    if (op === 'root' || typeof value !== 'string' || !path.isAbsolute(value)) throw new WorkforceError('forbidden', 'That is not shared with you.');
    const resolved = path.resolve(value);
    reach(this.s, from, `path:${resolved}`, forPerson);
    const real = realPath(resolved);
    if (real !== resolved) reach(this.s, from, `path:${real}`, forPerson); // a link inside a shared folder that leads out of it
    return resolved;
  }

  private selfName(): string {
    try { return this.s.devices.self().name; } catch { return 'this PC'; }
  }

  /** 'root': this PC's <data>, its workspace and its map (written when missing), as system.root says them here. */
  private root(): RootInfo {
    this.s.rootMaps?.writeRoot();
    const { data, workspace } = this.s.paths;
    return { path: data, workspace, readme: path.join(data, ROOT_README) };
  }
}

/** Where `target` really is (links followed) – for a path not there yet, its nearest existing parent's real place. */
function realPath(target: string): string {
  try { return realpathSync.native(target); } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(realPath(parent), path.basename(target));
  }
}

const hubs = new WeakMap<object, RemotePaths>();

/** This runtime's forwarding (made by the sync, devices/sync/service.ts). */
export function remotePathsOf(s: object): RemotePaths {
  const hub = hubs.get(s);
  if (!hub) throw new WorkforceError('unavailable', 'Linked PCs are not available in this runtime.');
  return hub;
}
