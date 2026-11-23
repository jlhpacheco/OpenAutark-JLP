// An approval request answered on another of the person's PCs (Umzug 21.11.2026, PCSEC H2): the request lives on the
// PC whose rules asked (security/service.ts, kept in its kv), its to-do travels to every CEO PC with its client id
// apr:<id> (devices/sync/tables.ts). An answer to that to-do on a PC that does not hold the request goes to the online
// CEO PCs as the peer method 'security.answer'; the one that holds it applies it like an answer given there (the
// change of a switch, the to-do closed – which travels back –, the asking agent woken) and the others say not_found.
// The first answer wins, as for an answer given twice on one PC. With linked CEO PCs but none online the answer is
// refused with that reason and the to-do stays open; when no PC holds it any more the to-do is dropped here.
// Owns: forwarding the answer and the receiving method. Never: answers for the person (the answering PC took the
// person's answer, tasks/human.ts), or answers a PC that is no 'ceo' link.

import type { RuntimeServices } from '../contracts.ts';
import type { ApprovalAnswer } from '../../shared/model/security-settings.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { isCeoPc, links } from '../devices/sync/home.ts';

export const ANSWER_METHOD = 'security.answer';
const ANSWERS: readonly ApprovalAnswer[] = ['once', 'setting', 'place', 'decline'];
/** How long an online PC gets to say whether it holds the request. */
const ASK_MS = 15_000;

/**
 * Sends the answer to the online CEO PCs: 'sent' (one of them will apply it; `gone` runs when none holds it),
 * 'offline' (linked CEO PCs, none online now), 'none' (no CEO PC is linked: the request is gone).
 */
export function relayAnswer(s: RuntimeServices, requestId: string, answer: ApprovalAnswer, gone: () => void): 'sent' | 'offline' | 'none' {
  let ceo: string[] = [];
  try { ceo = links(s.db).filter(({ link }) => link.kind === 'ceo').map(({ record }) => record.id); } catch { ceo = []; }
  if (!ceo.length) return 'none';
  const online = ceo.filter((id) => { try { return s.devices.online(id); } catch { return false; } });
  if (!online.length) return 'offline';
  void Promise.allSettled(online.map((id) => s.devices.call(id, ANSWER_METHOD, { id: requestId, answer }, undefined, ASK_MS))).then((results) => {
    if (results.some((result) => result.status === 'fulfilled')) return;
    const notHeld = results.every((result) => result.status === 'rejected' && (result.reason as { code?: string })?.code === 'not_found');
    if (notHeld) gone();
    else s.log.warn('security answer not delivered', { id: requestId });
  });
  return 'sent';
}

/** The peer method on the PC that holds the request: applies the answer given on a linked CEO PC. */
export async function serveAnswer(s: RuntimeServices, params: unknown, from: string): Promise<{ ok: true }> {
  if (!isCeoPc(s.db, from)) throw new WorkforceError('forbidden', 'Security requests are answered only from the person\'s own PCs.');
  const p = (params ?? {}) as { id?: unknown; answer?: unknown };
  const answer = ANSWERS.find((one) => one === p.answer);
  if (typeof p.id !== 'string' || !p.id || p.id.length > 100 || !answer) throw new WorkforceError('bad_request', 'An answer names its request and one of its options.');
  s.security.answer(p.id, answer); // not_found when this PC does not hold it
  return { ok: true };
}
