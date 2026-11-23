// Runde „Halb“ 21.11.2026: the input of the chat groups that ride along in a turn (TurnRequest.riders, dispatch-groups.ts
// ridersOf) – what each would have shown in a turn of its own: its notes under one label naming its chat, then its unseen
// lines as the delta renders them (each line's label names its chat). The lines reach as far as the turn's folds of that chat
// do (control.others), so the done finish moves that chat's read cursor over them (agents/turn-finish.ts) and a fold of a line
// arriving later starts after them (dispatch-steer.ts steerOther). A rider in the turn's own chat brings only its notes: the
// turn's delta has its lines already.
// Owns: that input. Never: claims or settles wakes, moves a cursor, or decides which groups ride.

import type { RuntimeServices } from '../contracts.ts';
import type { DeltaResult } from '../context/delta.ts';
import { quoteHeaders } from '../context/projection.ts';
import type { TurnPlan, TurnRequest } from './turn-types.ts';
import { chatSubject, noteLabel } from './note-label.ts';

/** The riders' text blocks and images, in the order they came; nothing when the turn has none. */
export async function riderInput(services: RuntimeServices, plan: Pick<TurnPlan, 'agent' | 'conversationId'>, request: Pick<TurnRequest, 'riders' | 'control'>, timezone: string | undefined): Promise<{ lines: string[]; images: DeltaResult['images'] }> {
  const lines: string[] = [];
  const images: DeltaResult['images'] = [];
  for (const rider of request.riders ?? []) {
    const id = rider.conversationId;
    const subject = chatSubject(id, services.chats.get(id)?.title);
    lines.push(...rider.notes.map((note) => quoteHeaders(`${noteLabel(note.at, timezone, subject)} ${note.text}`)));
    if (id === plan.conversationId) continue;
    let sinceSeq: number;
    try {
      const member = services.chats.members(id).find((item) => item.memberId === plan.agent.id && !item.leftAt);
      if (!member) continue; // no longer a member there: its lines are not mine to read
      sinceSeq = member.readSeq;
    } catch { continue; }
    try { await services.context.prepare?.({ agentId: plan.agent.id, conversationId: id, sinceSeq }); } catch (error) {
      services.log.warn('attachment extraction failed; the delta only names the files', { agentId: plan.agent.id, error: String(error) });
    }
    const delta = services.context.delta({ agent: plan.agent, conversationId: id, sinceSeq });
    if (delta.text.trim()) lines.push(delta.text);
    images.push(...delta.images);
    if (delta.lastSeq > sinceSeq) {
      const others = (request.control.others ??= new Map());
      const seen = others.get(id);
      others.set(id, { ...seen, seq: Math.max(seen?.seq ?? 0, delta.lastSeq) });
    }
  }
  return { lines, images };
}
