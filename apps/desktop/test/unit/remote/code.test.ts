// B-084 person code, since Eine-ID 22.11.2026 the company tree (remote/code.ts): the fixed test vector of
// .local/b084/notes/W4-format.md (Android's CodeChain.java checks the same one), signing and verifying, a lone PC adopting
// the code of the PC that accepted it, two codes converging to the smaller root, the 8-link cap, foreign and forged
// chains refused, a removed signer re-signed.
// Owns: these assertions only. Never: a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { b64url, fingerprintOf } from '../../../src/runtime/devices/keys.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { belongs, chainEnd, codeFor, openCodes, parseTree, type CodeKey, type Tree } from '../../../src/runtime/remote/code.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { memoryDb } from '../devices/fakes.ts';

function keyOf(seed: number): CodeKey & { pub: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(der.subarray(der.length - 32));
  return { publicKey, fingerprint: fingerprintOf(publicKey), pub: b64url(publicKey), sign: (data) => sign(null, data, privateKey) };
}
const link = (by: CodeKey, member: { pub: string; fingerprint: string }) => ({ pub: member.pub, sig: b64url(by.sign(Buffer.from(`wf-code-v1|${member.fingerprint}`, 'utf8'))) });
const open = (key: CodeKey) => openCodes(memoryDb(), key, () => 1).company;

const ROOT = keyOf(1);
const A = keyOf(2);
const B = keyOf(3);
const F = keyOf(4);
const CODE = '133687038';
const CHAIN_B = {
  root: 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w',
  links: [
    { pub: 'gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q', sig: 'O576_zzndF29qmqcm5jrRZgKhpXtem-hmw7IQPyEEaL4-DG0nR0wIotGJY_rAKg7c6dxYryLPqFfi8gDud6-Bw' },
    { pub: '7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E', sig: 'i5ka_Tv1qlsFzO1H8awBRr1o0e7BNN-UaRNst_2pmNZOuHmiSDfsbecjHzrRgYExfT9WNGrEyEbsL5aIwYLdBw' },
  ],
};

test('the W4-format test vector: the same bytes as Android and the meeting server', () => {
  assert.equal(ROOT.pub, CHAIN_B.root);
  assert.equal(remoteIdOf(ROOT.fingerprint), CODE);
  assert.deepEqual(CHAIN_B.links, [link(ROOT, A), link(A, B)], 'deterministic Ed25519 over "wf-code-v1|<fp>"');
  assert.equal(belongs(CODE, B.fingerprint, CHAIN_B), true);
  assert.equal(belongs(CODE, A.fingerprint, CHAIN_B), false, 'the chain ends at B');
  assert.equal(belongs(CODE, A.fingerprint, { root: CHAIN_B.root, links: CHAIN_B.links.slice(0, 1) }), true);
  assert.equal(belongs(CODE, ROOT.fingerprint, { root: CHAIN_B.root, links: [] }), true);
  assert.equal(belongs(CODE, ROOT.fingerprint, undefined), true, 'the root answers with its own ID');
  assert.equal(belongs(remoteIdOf(B.fingerprint), B.fingerprint, undefined), true, 'own ID: the old path');
  assert.equal(belongs(CODE, B.fingerprint, undefined), false);
  assert.equal(belongs(CODE, F.fingerprint, CHAIN_B), false, 'a foreign key');
  assert.equal(belongs(CODE, B.fingerprint, { root: CHAIN_B.root, links: [link(F, B)] }), false, 'B signed by a stranger');
  assert.equal(belongs('133687039', B.fingerprint, CHAIN_B), false, 'another code');
  assert.equal(belongs(CODE, B.fingerprint, { root: 'x', links: 'no' }), false);
});

test('at most 8 links: a 9th is refused, and a PC 8 links deep signs nobody', () => {
  const keys = Array.from({ length: 10 }, (_, index) => keyOf(10 + index));
  const links = keys.slice(1).map((member, index) => link(keys[index], member));
  const code = remoteIdOf(keys[0].fingerprint);
  assert.equal(chainEnd({ root: keys[0].pub, links: links.slice(0, 8) }, code), keys[8].fingerprint);
  assert.equal(belongs(code, keys[9].fingerprint, { root: keys[0].pub, links }), false, '9 links');
  const tree: Tree = { root: keys[0].pub, links: keys.slice(1).map((member, index) => ({ ...link(keys[index], member), by: keys[index].fingerprint })) };
  assert.equal(parseTree(tree)?.links.length, 8, 'the member 9 links deep drops out of the tree');
  const deep = open(keys[8]);
  assert.equal(deep.take(tree, undefined), true, 'the 8th member adopts the code');
  assert.equal(deep.code(), code);
  assert.equal(deep.sign(keyOf(30).pub), false, 'its newcomer would be 9 deep');
});

test('a PC I accept gets my signature; it adopts my code and answers for it', () => {
  const root = open(ROOT);
  assert.equal(root.code(), CODE, 'the first PC keeps its own ID');
  assert.equal(root.sign(A.pub), true);
  assert.equal(root.sign(A.pub), false, 'once');
  const a = open(A);
  assert.equal(a.code(), remoteIdOf(A.fingerprint), 'alone it shows its own ID');
  assert.equal(a.take(root.tree(), ROOT.pub), true);
  assert.equal(a.code(), CODE);
  assert.equal(belongs(CODE, A.fingerprint, a.chain()), true);
  assert.equal(codeFor(A.fingerprint), a, 'found by my fingerprint');
  assert.equal(a.sign(B.pub), true, 'A accepts B: B joins the same code through A');
  const b = open(B);
  b.take(a.tree(), A.pub);
  assert.equal(b.code(), CODE);
  assert.deepEqual(b.chain(), CHAIN_B, 'root -> A -> B, as the vector');
  assert.equal(root.take(b.tree(), B.pub), true, 'the root learns B through the roster');
  assert.equal(root.tree().links.length, 2);
});

test('two codes converge: a lone PC joins one with members, two lone roots meet at the smaller fingerprint', () => {
  const [small, large] = [keyOf(40), keyOf(41)].sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1));
  const s = open(small);
  const l = open(large);
  assert.equal(l.take(s.tree(), small.pub), false, 'the larger cannot adopt a tree without it');
  assert.equal(s.take(l.tree(), large.pub), true, 'the smaller root signs the larger one');
  assert.equal(l.take(s.tree(), small.pub), true, 'the larger adopts');
  assert.equal(l.code(), s.code());
  assert.equal(l.code(), remoteIdOf(small.fingerprint));

  // A lone newcomer with a smaller key than the root still takes the code of the PC that accepted it.
  const keys = [keyOf(50), keyOf(51), keyOf(52), keyOf(53)].sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1));
  const [newcomer, root, member] = [keys[0], keys[3], keys[2]];
  const r = open(root);
  r.sign(member.pub);
  const m = open(member);
  m.take(r.tree(), root.pub);
  m.sign(newcomer.pub);
  const n = open(newcomer);
  assert.equal(m.take(n.tree(), newcomer.pub), false, 'a lone tree never outranks one with members');
  assert.equal(n.take(m.tree(), member.pub), true);
  assert.equal(n.code(), remoteIdOf(root.fingerprint), 'the owner\'s code stays');
});

test('a forged member entry drops out, a removed signer drops its members, and my own PCs are signed again', () => {
  const db = memoryDb();
  const root = open(ROOT);
  root.sign(A.pub);
  const a = open(A);
  a.take(root.tree(), ROOT.pub);
  a.sign(B.pub);
  const forged = { root: ROOT.pub, links: [...a.tree().links, { ...link(F, keyOf(5)), by: F.fingerprint }] };
  assert.equal(parseTree(forged)?.links.length, 2, 'signed by a key outside the tree');
  assert.equal(parseTree({ root: ROOT.pub, links: [{ ...link(F, A), by: ROOT.fingerprint }] })?.links.length, 0, 'a signature by the wrong key');

  // My root removed A: B's entry (signed by A) drops; B is my own PC, so I sign it again.
  const repo = new DevicesRepo(db);
  const mine = openCodes(db, ROOT, () => 1).company;
  mine.sign(A.pub);
  mine.take(a.tree(), A.pub);
  assert.equal(mine.tree().links.length, 2);
  repo.upsert({ id: 'dev_aaaaaaaaaaaa', name: 'A', kind: 'pc', role: 'home', fingerprint: A.fingerprint, publicKey: A.pub, addresses: [], caps: {}, status: 'revoked', self: false, pairedAt: 1, revokedAt: 2 });
  mine.refresh();
  assert.equal(mine.tree().links.length, 0, 'A and the members only A signed drop out');
  assert.equal(mine.signMissing([B.pub]), false, 'a lone root signs only through the roster rule');
  assert.equal(mine.take({ root: ROOT.pub, links: [] }, B.pub), false, 'the same lone root: nothing to merge');
  assert.equal(mine.sign(B.pub), true);
  assert.equal(belongs(CODE, B.fingerprint, chainOfB(mine.tree())), true);
});

const chainOfB = (tree: Tree) => ({ root: tree.root, links: tree.links.filter((entry) => entry.pub === B.pub).map(({ pub, sig }) => ({ pub, sig })) });
