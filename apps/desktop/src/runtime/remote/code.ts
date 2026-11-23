// The two IDs of a PC (B-084 person code; Eine-ID 22.11.2026, owner: "eine Firmen-ID … pro Firma … und dann gibt es pro
// User noch den Code … nur für einen selber"). Each is a tree of PCs under one root key; the ID is the Remote ID of that
// root's key. A member proves it belongs with a chain of signatures from the root to its key: at most MAX_LINKS links,
// each the previous key's Ed25519 signature over "wf-code-v1|<member fingerprint hex>" (wire format:
// .local/b084/notes/W4-format.md; Android relay/CodeChain.java, the iPhone's hosted/crypto.ts and the meeting server's
// protocol.ts check the same bytes). I keep each tree – every member with the fingerprint of the key that signed it:
// - the company tree (Company ID, kv 'remote.code', codeFor): its root is the company's first PC (a lone PC is its own
//   root, so the first PC keeps the ID it shows). On the company's own PCs (no employer link) it travels in the roster
//   between them; a new member's PC is signed in by a company PC, which hands it its chain in the 'company.facts'
//   answer – on an employee's PC this tree is only what its company told it (adoptChain), it signs nobody into it;
// - the me tree (My ID, kv 'remote.me', meFor): its root is a fresh key made once, on first use (never at open – nothing
//   is fixed before the company exists, owner 22.11.2026), that signs this PC as the first member; its private half is
//   never stored. It travels in the roster over 'ceo' links (my own devices).
// Merging (roster.ts, both trees): same root merges; a tree that outranks mine (one with several PCs before one PC alone,
// then the smaller root fingerprint) brings me its ID once I am in it; a PC whose tree I outrank gets my signature; my
// own PCs missing from my tree (their signer was removed) are signed again – one PC alone signs only through that rank
// rule, so a PC that just joined takes the ID of the PC that signed it. A removed PC's entry drops out of both trees.
// Phones never answer for an ID, so they need no chain. The part that holds my key and database opens both trees (rendezvous/service.ts); the
// others find them by my fingerprint (codeFor, meFor).
// Owns: the chain format, its check, both trees in kv and their merge rule. Never: signs a device that is not a member,
// signs into the company tree of a PC with an employer, stores the me root's private key, or trusts an unverified chain.

import type { Db } from '../db/database.ts';
import { DevicesRepo, type DeviceRecord } from '../devices/repo.ts';
import { b64url, fingerprintOf, fromB64url, generateEd25519, rawPublic, signEd25519, verifyEd25519 } from '../devices/keys.ts';
import { KvRepo } from '../store/kv.ts';
import { remoteIdOf } from './id.ts';

export const MAX_LINKS = 8;
const MAX_TREE = 64;
const FP = /^[0-9a-f]{64}$/;
/** kv namespace of each tree. */
const NS = { company: 'remote.code', me: 'remote.me' } as const;
export type TreeKind = keyof typeof NS;

export interface Link { pub: string; sig: string }
/** root -> member, as it travels with an answer. */
export interface Chain { root: string; links: Link[] }
/** Every member with the fingerprint of the key that signed it. */
export interface Tree { root: string; links: Array<Link & { by: string }> }
export interface CodeKey { fingerprint: string; publicKey: Uint8Array; sign(data: Uint8Array): Buffer }

const signedBytes = (fp: string) => Buffer.from(`wf-code-v1|${fp}`, 'utf8');
const raw = (value: unknown, size = 32): Buffer | undefined => {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = fromB64url(value);
  return bytes.length === size ? bytes : undefined;
};
const fpOf = (pub: string) => fingerprintOf(fromB64url(pub));
/** One PC alone: a company root with no members, a me tree with only its first member (its root is no PC). */
const alone = (tree: Tree, kind: TreeKind) => tree.links.length <= (kind === 'me' ? 1 : 0);
/** True when `a` outranks `b`: several PCs before one alone, then the smaller root fingerprint. */
const outranks = (a: Tree, b: Tree, kind: TreeKind) => (alone(a, kind) !== alone(b, kind) ? !alone(a, kind) : fpOf(a.root) < fpOf(b.root));

/** The fingerprint a valid chain ends at (for the code `remoteId` when given), else undefined. */
export function chainEnd(chain: unknown, remoteId?: string): string | undefined {
  const c = chain as Chain | null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.links) || c.links.length > MAX_LINKS) return undefined;
  let prev = raw(c.root);
  if (!prev || (remoteId !== undefined && remoteIdOf(fingerprintOf(prev)) !== remoteId)) return undefined;
  for (const link of c.links) {
    const pub = raw(link?.pub);
    const sig = raw(link?.sig, 64);
    if (!pub || !sig || !verifyEd25519(prev, signedBytes(fingerprintOf(pub)), sig)) return undefined;
    prev = pub;
  }
  return fingerprintOf(prev);
}

/** The key `fp` may answer for `remoteId`: its own ID, or a chain from the code's root to it. */
export function belongs(remoteId: string, fp: string, chain?: unknown): boolean {
  if (remoteIdOf(fp) === remoteId) return true;
  return chain !== undefined && chain !== null && chainEnd(chain, remoteId) === fp.toLowerCase();
}

/** The ID a verified chain ending at `fp` proves (its root's Remote ID), else undefined. */
export function chainCode(chain: unknown, fp: string): string | undefined {
  return chain !== undefined && chain !== null && chainEnd(chain) === fp ? remoteIdOf(fpOf((chain as Chain).root)) : undefined;
}

/** Only the members whose signature verifies from the root, once each, at most MAX_LINKS deep; `drop`: removed PCs. */
function resolved(tree: Tree, drop: (fp: string) => boolean = () => false): Tree {
  const rootFp = fpOf(tree.root);
  const reached = new Map<string, { pub: Buffer; depth: number }>([[rootFp, { pub: fromB64url(tree.root), depth: 0 }]]);
  const kept: Tree['links'] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const link of tree.links) {
      const fp = fpOf(link.pub);
      const by = reached.get(link.by);
      if (reached.has(fp) || drop(fp) || !by || by.depth >= MAX_LINKS || !verifyEd25519(by.pub, signedBytes(fp), fromB64url(link.sig))) continue;
      reached.set(fp, { pub: fromB64url(link.pub), depth: by.depth + 1 });
      kept.push({ pub: link.pub, sig: link.sig, by: link.by });
      grew = true;
    }
  }
  return { root: tree.root, links: kept };
}

/** A tree from the network: well-formed entries only, then resolved. */
export function parseTree(value: unknown, drop?: (fp: string) => boolean): Tree | undefined {
  const tree = value as Tree | null;
  if (!tree || typeof tree !== 'object' || !raw(tree.root) || !Array.isArray(tree.links)) return undefined;
  const links = tree.links.slice(0, MAX_TREE).filter((link) => raw(link?.pub) && raw(link.sig, 64) && typeof link.by === 'string' && FP.test(link.by));
  return resolved({ root: tree.root, links }, drop);
}

/** The chain from the root to `fp` inside a resolved tree, else undefined. */
export function chainIn(tree: Tree, fp: string): Chain | undefined {
  const rootFp = fpOf(tree.root);
  const links: Link[] = [];
  for (let at = fp; at !== rootFp;) {
    const entry = tree.links.find((link) => fpOf(link.pub) === at);
    if (!entry || links.length >= MAX_LINKS) return undefined;
    links.unshift({ pub: entry.pub, sig: entry.sig });
    at = entry.by;
  }
  return { root: tree.root, links };
}

/** The company PC this PC joined as an employee (its employer link), when there is one. */
export function employerPc(db: Db): DeviceRecord | undefined {
  return new DevicesRepo(db).list({ kinds: ['pc'] }).find((device) => !device.self && device.joinedAs === 'employee' && device.status !== 'revoked');
}

const opened = new Map<string, { company: CodeTree; me: CodeTree }>();
const watchers = new Map<string, Set<() => void>>();

/** My company tree (Company ID), once the part with my key and database opened it (rendezvous/service.ts); undefined before. */
export function codeFor(fingerprint: string): CodeTree | undefined { return opened.get(fingerprint)?.company; }

/** My me tree (My ID), opened with the company tree; its root is made on first use. */
export function meFor(fingerprint: string): CodeTree | undefined { return opened.get(fingerprint)?.me; }

/**
 * My chains for the LAN hello and wellKnown: `chain` my company chain when I am not its root (a root answers with its own
 * ID), `me` my chain in the me tree. Read while findable only – it starts the me tree.
 */
export function chainsOf(fingerprint: string): { chain?: Chain; me?: Chain } {
  const company = codeFor(fingerprint)?.chain();
  const me = meFor(fingerprint)?.chain();
  return { ...(company?.links.length ? { chain: company } : {}), ...(me?.links.length ? { me } : {}) };
}

/** Calls `fn` whenever either tree of `fingerprint` changes; returns the off switch. */
export function watchCode(fingerprint: string, fn: () => void): () => void {
  const set = watchers.get(fingerprint) ?? new Set();
  set.add(fn);
  watchers.set(fingerprint, set);
  return () => { set.delete(fn); };
}

/** Opens both trees of this PC (nothing is made yet). */
export function openCodes(db: Db, key: CodeKey, now: () => number): { company: CodeTree; me: CodeTree } {
  const both = { company: new CodeTree(db, key, now, 'company'), me: new CodeTree(db, key, now, 'me') };
  opened.set(key.fingerprint, both);
  return both;
}

export class CodeTree {
  private readonly db: Db;
  private readonly key: CodeKey;
  private readonly now: () => number;
  readonly kind: TreeKind;
  private cached?: Tree;

  constructor(db: Db, key: CodeKey, now: () => number, kind: TreeKind) {
    this.db = db;
    this.key = key;
    this.now = now;
    this.kind = kind;
  }

  /** My tree (stored, verified, with me in it), else a start: the company tree me alone as the root, the me tree a fresh root. */
  tree(): Tree {
    if (!this.cached) this.cached = this.load() ?? this.start();
    return this.cached;
  }

  /** The ID I answer for with this tree. */
  code(): string { return remoteIdOf(fpOf(this.tree().root)); }

  /** My chain from the root; an empty one when I am the root. */
  chain(): Chain { return chainIn(this.tree(), this.key.fingerprint) ?? { root: b64url(this.key.publicKey), links: [] }; }

  /** Signs a PC into this tree; false when it is in already, my chain is at MAX_LINKS or (company tree) I have an employer. */
  sign(memberPub: string): boolean {
    const key = raw(memberPub);
    if (!key || this.employed()) return false;
    const fp = fingerprintOf(key);
    const tree = this.tree();
    if (fpOf(tree.root) === fp || tree.links.some((link) => fpOf(link.pub) === fp) || this.chain().links.length >= MAX_LINKS) return false;
    return this.save({ root: tree.root, links: [...tree.links, { pub: memberPub, by: this.key.fingerprint, sig: b64url(this.key.sign(signedBytes(fp))) }] });
  }

  /** My own PCs missing from my tree get my signature (one PC alone signs only through take()). */
  signMissing(pubs: readonly string[]): boolean {
    if (this.employed() || alone(this.tree(), this.kind)) return false;
    let changed = false;
    for (const pub of pubs) changed = this.sign(pub) || changed;
    return changed;
  }

  /** The tree one of my own PCs (`senderPub`) sent: same root merges, an outranking one with me in it is adopted, else the sender gets my signature. */
  take(value: unknown, senderPub: string | undefined): boolean {
    const theirs = parseTree(value, this.removed);
    if (!theirs || this.employed()) return false;
    // A me tree not started yet joins theirs without making a root of its own (the ID my other PC shows stays).
    if (!this.cached && !this.load() && this.kind === 'me' && chainIn(theirs, this.key.fingerprint)) return this.keep(theirs);
    const mine = this.tree();
    if (theirs.root === mine.root) return this.save({ root: mine.root, links: [...mine.links, ...theirs.links] });
    if (outranks(theirs, mine, this.kind)) return chainIn(theirs, this.key.fingerprint) ? this.save({ root: theirs.root, links: [...theirs.links, ...mine.links] }) : false;
    return senderPub ? this.sign(senderPub) : false;
  }

  /** Company tree of an employee's PC: the chain its company handed it, kept when it verifies and ends at this PC. */
  adoptChain(value: unknown): boolean {
    if (this.kind !== 'company' || chainEnd(value) !== this.key.fingerprint) return false;
    const chain = value as Chain;
    let by = fpOf(chain.root);
    const links = chain.links.map((link) => { const entry = { pub: link.pub, sig: link.sig, by }; by = fpOf(link.pub); return entry; });
    const tree = resolved({ root: chain.root, links }, this.removed);
    if (JSON.stringify(tree) === JSON.stringify(this.tree()) || !chainIn(tree, this.key.fingerprint)) return false;
    return this.keep(tree);
  }

  /** Forgets the stored tree (the last employer link went: this PC is its own company again). */
  clear(): boolean {
    if (!new KvRepo(this.db).delete(NS[this.kind], 'tree')) return false;
    this.cached = undefined;
    this.notify();
    return true;
  }

  /** Reads the tree again (a PC was removed, or a bridge moved it); tells the watchers when it changed. */
  refresh(): void {
    const before = this.cached;
    this.cached = undefined;
    if (before && JSON.stringify(this.tree()) !== JSON.stringify(before)) this.notify();
  }

  /** A PC removed here (a revoked row and no live one). */
  private readonly removed = (fp: string): boolean =>
    !new DevicesRepo(this.db).byFingerprint(fp) && Boolean(this.db.get('SELECT 1 FROM devices WHERE fingerprint = ? AND revoked_at IS NOT NULL', [fp]));

  /** The company tree of a PC with an employer is only what its company told it. */
  private employed(): boolean { return this.kind === 'company' && Boolean(employerPc(this.db)); }

  private load(): Tree | undefined {
    const stored = parseTree(new KvRepo(this.db).get(NS[this.kind], 'tree'), this.removed);
    return stored && chainIn(stored, this.key.fingerprint) ? stored : undefined;
  }

  /** The start: company – me alone as the root (not stored); me – a fresh root signs me, stored at once, its private key dropped. */
  private start(): Tree {
    const mine = b64url(this.key.publicKey);
    if (this.kind === 'company') return { root: mine, links: [] };
    const { privateKey, publicKey } = generateEd25519();
    const root = rawPublic(publicKey);
    const tree: Tree = { root: b64url(root), links: [{ pub: mine, by: fingerprintOf(root), sig: b64url(signEd25519(privateKey, signedBytes(this.key.fingerprint))) }] };
    new KvRepo(this.db).set(NS.me, 'tree', tree, this.now());
    return tree;
  }

  private save(next: Tree): boolean {
    const tree = resolved(next, this.removed);
    if (JSON.stringify(tree) === JSON.stringify(this.tree()) || !chainIn(tree, this.key.fingerprint)) return false;
    return this.keep(tree);
  }

  private keep(tree: Tree): boolean {
    this.cached = tree;
    new KvRepo(this.db).set(NS[this.kind], 'tree', tree, this.now());
    this.notify();
    return true;
  }

  private notify(): void {
    for (const fn of [...(watchers.get(this.key.fingerprint) ?? [])]) { try { fn(); } catch { /* a listener's failure stays its own */ } }
  }
}
