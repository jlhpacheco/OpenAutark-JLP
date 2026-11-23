// RPC handlers of the team side of feedback (B-055 Q2/Q3): the inbox on the PC holding the team's key and
// `wf feedback setup`. The inbox (other people's reports) is the owner's: the desktop window, the local wf CLI with the
// launch token and, 16.11.2026, the owner's own phone with 'settings' on a secure transport (Settings › Feedback on the
// phone) – never a person of the organisation, a linked PC or an agent. Setup (it writes keys from a service-account file
// of this PC) stays with the owner.
// Owns: param checks. Never: the inbox or setup behaviour (runtime/feedback/inbox.ts, setup.ts).

import { WorkforceError } from '../../../shared/errors.ts';
import { DOCUMENT_ID } from '../../feedback/drop.ts';
import type { FeedbackApi } from '../extras.ts';
import { bad, input, num, onlyKeys, optBool, text, type Obj } from '../params.ts';
import { FEEDBACK_IMAGES_MAX } from '../../../shared/model/feedback-delivery.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const SECURE_SETTINGS = { capability: 'settings', secure: true } as const;

function inbox(ctx: HandlerContext): NonNullable<FeedbackApi['inbox']> {
  const api = ctx.extras.feedback.inbox;
  if (!api) throw new WorkforceError('unavailable', 'The feedback inbox is not available.');
  return api;
}

function reportId(o: Obj): string {
  const id = text(o, 'id', { max: 64 });
  if (!DOCUMENT_ID.test(id)) bad('id', 'a report id');
  return id;
}

export function register(table: HandlerTable): void {
  table.add('feedback.inboxList', (params, ctx) => {
    onlyKeys(input(params), []);
    return inbox(ctx).list();
  }, SECURE_SETTINGS);
  table.add('feedback.inboxFetch', (params, ctx) => {
    onlyKeys(input(params), []);
    return inbox(ctx).fetch();
  }, SECURE_SETTINGS);
  table.add('feedback.inboxRemove', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return inbox(ctx).remove(reportId(o));
  }, SECURE_SETTINGS);
  table.add('feedback.inboxMark', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'as']);
    const as = o.as;
    if (as !== null && as !== 'done' && as !== 'irrelevant') bad('as', '"done", "irrelevant" or null');
    return inbox(ctx).mark(reportId(o), as as 'done' | 'irrelevant' | null);
  }, SECURE_SETTINGS);
  table.add('feedback.inboxImage', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'index']);
    return inbox(ctx).image(reportId(o), num(o, 'index', { integer: true, min: 0, max: FEEDBACK_IMAGES_MAX - 1 }));
  }, SECURE_SETTINGS);
  table.add('feedback.setup', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['project', 'apiKey', 'serviceAccountPath', 'rotate']);
    const setup = ctx.extras.feedback.setup;
    if (!setup) throw new WorkforceError('unavailable', 'Feedback setup is not available.');
    return setup.call(ctx.extras.feedback, {
      project: text(o, 'project', { max: 30 }),
      apiKey: text(o, 'apiKey', { max: 100 }),
      serviceAccountPath: text(o, 'serviceAccountPath', { max: 1024 }),
      rotate: optBool(o, 'rotate'),
    });
  });
}
