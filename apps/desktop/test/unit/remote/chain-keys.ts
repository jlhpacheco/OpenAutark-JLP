// Eine-ID 22.11.2026 test helper: deterministic Ed25519 keys and one-link chains in the remote/code.ts wire format
// ("wf-code-v1|<member fingerprint>" signed by the previous key).
// Owns: these helpers only.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { fingerprintOf } from '../../../src/runtime/devices/keys.ts';

export function keyOf(seed: number) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { pub: raw.toString('base64url'), fingerprint: fingerprintOf(raw), sign: (text: string) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url') };
}
export type Key = ReturnType<typeof keyOf>;
export const chainTo = (root: Key, member: Key) => ({ root: root.pub, links: [{ pub: member.pub, sig: root.sign(`wf-code-v1|${member.fingerprint}`) }] });
