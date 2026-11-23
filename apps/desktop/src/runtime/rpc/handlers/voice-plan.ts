// RPC voice.planLogin (STIMME 21.11.2026, owner: "transcribing via Codex does not have to go over the PC"): the person's
// own Android phone hears a dictation itself at their ChatGPT plan (the app posts the take to the plan's endpoint,
// apps/android phoneuse/PlanHearing.java) and gets the plan login for it here – the access token, the account id, the
// token's expiry, and the language hint this PC would send (voice/local/service.ts serviceLanguage, as transcribe.ts).
// Who gets it (review 21.11.2026): a device token alone is not enough – the app's page holds the same token (and any
// script in it), so do a desktop browser and the iPhone web app. The call carries `proof`: the app's native side signs
// planProofText(deviceId, at) with the phone's own Ed25519 device key (the pairing key, which never leaves the app's
// storage), and it is checked against the key of that device's paired phone record (rendezvous/phone.ts relayPhone; not
// an employee's). `at` lies within PROOF_WINDOW_MS of this PC's clock and rises with every call of a device (no replay).
// Besides: device scope with 'chat' on a secure transport; an owner session (an agent's wf, the window), a person's or an
// external agent's scope never. While dictation here goes to another choice than the plan (routing.stt "local" or a
// service) the phone keeps the PC's way. Registered from handlers/index.ts.
// Owns: who gets the login, the proof check and the param check. Never: logs the token or the account id, reads the
// login itself (voice/plan-transcribe.ts phoneLogin does), or hands it to anyone but the proven phone.

import '../../../shared/api/methods-voice-plan.ts'; // the method shape (module augmentation)
import { WorkforceError } from '../../../shared/errors.ts';
import { planHears } from '../../../shared/model/models-uses.ts';
import { fromB64url, verifyEd25519 } from '../../devices/keys.ts';
import { relayPhone } from '../../devices/rendezvous/phone.ts';
import { DevicesRepo } from '../../devices/repo.ts';
import { systemEnvironment } from '../../settings/defaults.ts';
import { serviceLanguage } from '../../voice/local/service.ts';
import { phoneLogin } from '../../voice/plan-transcribe.ts';
import { bad, input, num, onlyKeys, optText, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

/** How far the phone's `at` may lie from this PC's clock. */
export const PROOF_WINDOW_MS = 5 * 60_000;
/** The newest accepted `at` per device: a proof counts once. */
const lastAt = new Map<string, number>();

/** What the phone's device key signs (PlanHearing.java proofText writes the same). */
export function planProofText(deviceId: string, at: number): string {
  return `autark-plan-login\n${deviceId}\n${at}`;
}

/** The person's own paired Android phone, proven by its device key: true when the login may go to this call. */
export function mayHaveLogin(ctx: Pick<HandlerContext, 'scope' | 'secure' | 'services'>, at: number, proof: string): boolean {
  const scope = ctx.scope;
  if (scope?.kind !== 'device' || ctx.secure !== true || !scope.capabilities.includes('chat')) return false;
  const now = ctx.services.clock.now();
  if (Math.abs(now - at) > PROOF_WINDOW_MS || at <= (lastAt.get(scope.deviceId) ?? 0)) return false;
  let record;
  try { record = new DevicesRepo(ctx.services.db).get(scope.deviceId); } catch { return false; }
  if (!relayPhone(record) || record.personId || !record.publicKey) return false;
  const key = record.publicKey;
  let ok = false;
  try { ok = verifyEd25519(fromB64url(key), Buffer.from(planProofText(scope.deviceId, at), 'utf8'), fromB64url(proof)); } catch { ok = false; }
  if (ok) lastAt.set(scope.deviceId, at);
  return ok;
}

export function register(table: HandlerTable): void {
  table.add('voice.planLogin', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['language', 'fresh', 'at', 'proof']);
    const language = optText(o, 'language', { max: 16 });
    if (language !== undefined && !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) bad('language', 'a language code like "de" or "en-US"');
    if (o.fresh !== undefined && o.fresh !== true) bad('fresh', 'true or left out');
    const at = num(o, 'at', { integer: true, min: 0 });
    const proof = text(o, 'proof', { max: 200 });
    if (!mayHaveLogin(ctx, at, proof)) throw new WorkforceError('forbidden', 'The ChatGPT plan login goes only to the person\'s own Android phone, proven by its device key.');
    const s = ctx.services;
    let routing: unknown;
    try { routing = s.settings.get().routing; } catch { routing = undefined; }
    if (!planHears(routing)) throw new WorkforceError('unavailable', 'Dictation on this PC goes to another choice than the ChatGPT plan (routing.stt).');
    const login = await phoneLogin(s, o.fresh === true, s.clock.now());
    let locale: string | undefined;
    try { locale = systemEnvironment().locale; } catch { locale = undefined; }
    const hint = serviceLanguage(language, locale);
    s.log.info('plan login to phone', { fresh: o.fresh === true }); // never the token or the account id
    return { ...login, ...(hint ? { language: hint } : {}) };
  }, { capability: 'chat', secure: true });
}
