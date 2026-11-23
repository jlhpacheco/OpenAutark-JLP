// The runtime side of the first-run layer (ui/onboarding/FirstRun.tsx). The layer shows while
// settings.onboarding.step is not 'done'; its cards make their own choices through the existing methods
// (accounts, settings). start() ends the layer: step 'done' and completed, the Manager's first chat
// (shared/text/manager-chat.ts; when there is none, the owner's default 1:1 with it, chat/direct.ts) and its two opening
// lines (brief.ts) in one transaction: F07 (owner 15.11.2026: "Standardprompt direkt gesendet … und dann direkt diese
// Antwort drauf") the start line as the person's own, delivered to nobody, then the Manager's first message as the
// Manager's own line right below it. B-090 (owner 13.11.2026: "ein gestellter erster Aufbau", "der User kann sich dann
// auch entscheiden, dass die KI nicht direkt anfängt"): the app writes both lines, so no model runs and no agent wakes
// at Start; the person's answer is an ordinary message and the Manager's first turn (one 'message' wake, the route of a
// person's request), which reads all three lines. reset() ("Set up team again", owner): not completed, step 'ai' – the
// layer returns until the next start().
// The security mode (owner 19.11.2026) needs no line in the Manager's SYSTEM.md: the stable prompt carries it
// (security/agreements.ts), and the first setup question follows it (brief.ts).
// Owns: these state changes and posting those two lines. Never: writes as the person anything but
// the start line, writes as the Manager anything but its first message, wakes anyone, invents profile facts, changes
// accounts or a SYSTEM.md.

import type { RuntimeServices } from '../contracts.ts';
import '../../shared/model/onboarding.ts'; // the first-run methods (module augmentation)
import { HUMAN_ID } from '../../shared/ids.ts';
import { managerAgent, managerFirstChat } from '../../shared/text/manager-chat.ts';
import { findOrCreateDirect } from '../chat/direct.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { setupLines } from './brief.ts';

export interface OnboardingDeps {
  services: () => RuntimeServices;
}

export class Onboarding {
  private readonly deps: OnboardingDeps;

  constructor(deps: OnboardingDeps) {
    this.deps = deps;
  }

  /** "Set up team again": the first-run layer from its first card. */
  reset(): void {
    this.deps.services().settings.update({ onboarding: { completed: false, step: 'ai' } });
  }

  /**
   * The layer is through: onboarding done, the Manager's first chat and its two opening lines there – the start line as
   * the person's, the Manager's first message below it (once, also when asked twice: the chat ends with that message
   * already); nobody wakes.
   */
  start(): { conversationId: string } {
    const s = this.deps.services();
    const manager = managerAgent(s.org.list());
    if (!manager) throw new WorkforceError('not_found', 'There is no Manager on the team.');
    const conversationId = managerFirstChat(s.chats.list(), manager.id)?.id ?? findOrCreateDirect(s, HUMAN_ID, manager.id, { createdBy: HUMAN_ID });
    const { start, answer } = setupLines(s);
    const last = s.chats.messages(conversationId, { limit: 1 }).at(-1);
    if (answer && !(last?.authorId === manager.id && last.body === answer)) {
      // one transaction: a crash between the two never leaves the start line as an unanswered request (chat/delivery-recovery.ts)
      s.db.tx(() => {
        if (start) s.chats.send({ conversationId, body: start, authorId: HUMAN_ID, authorKind: 'human', deliver: false });
        s.chats.send({ conversationId, body: answer, authorId: manager.id, authorKind: 'agent' });
      });
    }
    s.settings.update({ onboarding: { completed: true, step: 'done' } });
    s.log.info('first run done', { managerId: manager.id, conversationId });
    return { conversationId };
  }
}
