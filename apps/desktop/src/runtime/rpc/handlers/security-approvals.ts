// RPC handlers of the security requests (Sicher-Runde 19.11.2026): the waiting requests, the person's answer and the apps
// with a window on this PC (for the computer-use list). The requests are also to-dos, so the 'todo' tier sees and answers
// them like the to-do (FX1 H1): 'once'/'decline' from any of the person's sessions, 'setting'/'place' – they open a switch –
// only with the 'settings' tier, else they count as 'once' (security/rpc-guard.ts answerAs). Never an agent's `wf` or a
// runtime.json token (rpc-guard.ts PERSON_ONLY; the service checks its caller again).
// Owns: param checks and scope rules. Never: decides or applies an answer (security/service.ts).

import type { ApprovalAnswer } from '../../../shared/model/security-settings.ts';
import { id, input, oneOf, onlyKeys } from '../params.ts';
import type { HandlerTable } from '../table.ts';
import { windowApps } from '../../security/apps.ts';
import { answerAs } from '../../security/rpc-guard.ts';

const ANSWERS: readonly ApprovalAnswer[] = ['once', 'setting', 'place', 'decline'];

export function register(table: HandlerTable): void {
  table.add('security.requests', (_params, ctx) => ctx.services.security.requests(), { capability: 'todo' });
  table.add('security.answer', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'answer']);
    ctx.services.security.answer(id(o), answerAs(ctx.scope, oneOf(o, 'answer', ANSWERS)));
    return { ok: true as const };
  }, { capability: 'todo' });
  table.add('security.apps', (_params, ctx) => windowApps(ctx.services), { capability: 'settings' });
}
