// Remote IDs: the 9 digits a person types to reach another PC ("482 913 071"). Eight digits come
// from the PC's public key fingerprint, the ninth is a Luhn check digit, so a typo is caught
// before anything is sent and an answering PC whose key does not give the typed ID is ignored.
// The ID is an address, not a secret or a proof: who answered is proven by the request's
// signatures and the match code the two people compare (remote/sas.ts).
// The check digit rule is shared with the iPhone web app (shared/model/remote.ts luhnDigit/validRemoteId).
// Owns: deriving, formatting and parsing Remote IDs and the typed target (Remote ID or address).
// Never: network, storage or trust decisions.

import { createHash } from 'node:crypto';
import { luhnDigit, validRemoteId } from '../../shared/model/remote.ts';

export const REMOTE_ID_LENGTH = 9;

/** The Remote ID of a PC from its fingerprint (sha256 hex of its Ed25519 public key). */
export function remoteIdOf(fingerprint: string): string {
  const digest = createHash('sha256').update(`wf-remote-id-v1|${fingerprint.toLowerCase()}`).digest();
  const payload = String(digest.readUInt32BE(0) * 4 + (digest[4] & 3)).padStart(10, '0').slice(-8);
  return payload + luhnDigit(payload);
}

/** "482 913 071". */
export function formatRemoteId(id: string): string {
  return id.length === REMOTE_ID_LENGTH ? `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}` : id;
}

/** Default port of the peer listener other PCs are dialed on (http/peer-server.ts). */
export const PEER_PORT = 47812;

export type RemoteTarget = { remoteId: string } | { address: string };

/**
 * What the person typed into "Connect": a Remote ID (spaces and dashes allowed) or an address of a
 * PC that is reachable directly ("203.0.113.5", "pc.example.org:47812", "http://…"; the peer port
 * when none is given). Throws a plain Error with a short message for a mistyped ID or address.
 */
export function parseTarget(input: string): RemoteTarget {
  const text = input.trim();
  const compact = text.replace(/[\s-]/g, '');
  if (/^\d+$/.test(compact)) {
    if (compact.length !== REMOTE_ID_LENGTH) throw new Error('A Remote ID has 9 digits.');
    if (!validRemoteId(compact)) throw new Error('This Remote ID has a typo. Check the digits.');
    return { remoteId: compact };
  }
  if (!text || text.length > 200) throw new Error('Enter the Remote ID or the address of the other PC.');
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text.includes(':') && !text.includes('.') && !text.startsWith('[') ? `[${text}]` : text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { throw new Error('Enter the Remote ID or an address such as 203.0.113.5.'); }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Enter the Remote ID or an address such as 203.0.113.5.');
  if (!url.port) url.port = String(PEER_PORT);
  return { address: `${url.protocol}//${url.host}` };
}
