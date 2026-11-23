// RPC handlers: the security mode's topic texts (owner 19.11.2026, Settings › Security). security.topics lists a mode's
// texts (each file, or the default with the person's name) – also for the person's phone with 'settings', to read;
// security.saveTopic writes one (null: back to the default) for the person only: an owner session marked `person` (the
// desktop window, main's own link, the person token) and the person's own phone on a secure transport (FX1: never the
// runtime.json token). An agent – its `wf` (owner scope with its name), an MCP lease, an
// external agent – hears that the texts are the person's: in Trust AI mode it changes the file itself, in Secure mode the
// app keeps them closed (runtime/security/topics.ts). The approvals (security.requests/answer/apps) live in
// security-approvals.ts.
// Owns: param checks and the person-only rule of these two methods. Never: reads or writes the files itself (topics.ts).

import { WorkforceError } from '../../../shared/errors.ts';
import { MAX_TOPIC_TEXT, SECURITY_MODES, SECURITY_TOPICS, TRUST_TOPICS } from '../../../shared/model/security-settings.ts';
import { input, oneOf, onlyKeys, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';
import { securityTopics } from '../../security/topics.ts';
import { actorOf } from '../../settings/security-log.ts';
import { isPersonScope, requireTrustAgreementActor } from '../../security/rpc-guard.ts';

const SETTINGS = { capability: 'settings' } as const;
const SECURE_SETTINGS = { capability: 'settings', secure: true } as const;

/** The answer an agent's call of security.saveTopic gets, in its own voice. */
export const SAVE_TOPIC_PERSON_ONLY = 'security.saveTopic is the person\'s own save from Settings › Security. '
  + 'In Trust AI mode I change a text by editing its file in <data>/security/trust/ when the person clearly wants the change; '
  + 'in Secure mode the texts are theirs and the app keeps them closed to me.';

export function register(table: HandlerTable): void {
  table.add('security.topics', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['mode']);
    return securityTopics(ctx.services).list(oneOf(o, 'mode', SECURITY_MODES));
  }, SETTINGS);

  table.add('security.saveTopic', (params, ctx) => {
    if (!isPersonScope(ctx.scope)) throw new WorkforceError('forbidden', SAVE_TOPIC_PERSON_ONLY);
    const o = input(params);
    onlyKeys(o, ['mode', 'topic', 'text']);
    const mode = oneOf(o, 'mode', SECURITY_MODES);
    const topic = oneOf(o, 'topic', SECURITY_TOPICS);
    const value = o.text === null ? null : text(o, 'text', { max: MAX_TOPIC_TEXT, allowEmpty: true, multiline: true });
    const { services } = ctx;
    const by = actorOf(ctx.scope, { person: () => services.settings.get().profile.name || 'The owner', agent: (agentId) => services.org.get(agentId)?.name });
    return securityTopics(services).save(mode, topic, value, by);
  }, SECURE_SETTINGS);

  table.add('security.saveTrustAgreement', (params, ctx) => {
    requireTrustAgreementActor(ctx);
    const o = input(params);
    onlyKeys(o, ['topic', 'text']);
    const topic = oneOf(o, 'topic', TRUST_TOPICS);
    const value = o.text === null ? null : text(o, 'text', { max: MAX_TOPIC_TEXT, multiline: true });
    return securityTopics(ctx.services).save('trust', topic, value, () => requireTrustAgreementActor(ctx));
  });
}
