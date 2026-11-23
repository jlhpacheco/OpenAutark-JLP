// bridge 0.3.17 of the Halb round 21.11.2026 (Trust AI acts, Secure checks: new shipped texts security/<mode>/general.md), at
// runtime start beside the other bridges (runtime/main.ts), idempotent: the 19.11. bridge (sicher-1119.ts appendGeneral)
// wrote security/trust/general.md and security/secure/general.md as the then shipped general text with the person's name
// filled in, plus the person's own old lines below it – so those companies kept the old text although nobody chose it.
// Where such a file still begins with that paragraph exactly as written then (any name), the paragraph is taken out and
// the person's own lines stay; a file left empty is removed, so the shipped default shows. A file whose first paragraph
// was changed is left alone. Through the topics' own save (runtime/security/topics.ts), so the accepted text, file sync
// and the change log stay true. This file is deleted in the version after the bridge.
// Owns: that conversion and the old paragraph's words. Never: another topic file, or a file that does not begin with them.

import type { RuntimeServices } from '../contracts.ts';
import { SECURITY_MODES, type SecurityMode } from '../../shared/model/security-settings.ts';
import type { SecurityActor } from '../../shared/model/security-log.ts';
import { securityTopics, type SecurityTopics } from '../security/topics.ts';

/** The general text both modes shipped from 19.11. to 21.11.2026 (`{{name}}`: the person's name as filled in then). */
export const OLD_GENERAL = 'How I decide between going ahead and checking with {{name}} first: I picture {{name}} watching me take the step. If they would nod, I go ahead – the step follows from what they asked, I have something solid behind it (their own earlier choice, a source I checked, a result I can see), or it is easy to undo. I stop and ask when the step is hard to undo or speaks for {{name}} to others, and all I have for it is a guess – about their taste, their money, a relationship, a promise. Then one short question with my proposal saves them far more than it costs. A question whose answer I already know only takes their attention; there I decide and say what I did.';

const BRIDGE: SecurityActor = { kind: 'other', name: 'The update of 21.11.2026 (the old shipped text taken out)' };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The old paragraph at the file's start, as a whole paragraph: the end of the file or a blank line follows it. */
const OLD_START = new RegExp(`^${OLD_GENERAL.split('{{name}}').map(escaped).join('[^\\n]+?')}(?:\\n[ \\t]*\\n|[ \\t]*$)`);

/** What stays of a general text: the person's own lines (null: nothing – the default shows), or undefined to leave it. */
export function withoutOldGeneral(text: string): string | null | undefined {
  const normal = text.replace(/\r\n?/g, '\n').trim();
  const match = OLD_START.exec(normal);
  if (!match) return undefined;
  const rest = normal.slice(match[0].length).trim();
  return rest || null;
}

/** The conversion for one runtime's topics; returns the modes whose file changed. */
export function generalPart(topics: Pick<SecurityTopics, 'fileText' | 'save'>): SecurityMode[] {
  const changed: SecurityMode[] = [];
  for (const mode of SECURITY_MODES) {
    const own = topics.fileText(mode, 'general');
    if (own === null) continue;
    const next = withoutOldGeneral(own);
    if (next === undefined) continue;
    topics.save(mode, 'general', next, BRIDGE);
    changed.push(mode);
  }
  return changed;
}

/** The bridge (see the header); a failure is logged and tried again at the next start. */
export function runGeneral1121(s: RuntimeServices): void {
  try {
    const changed = generalPart(securityTopics(s));
    if (changed.length) s.log.info('general-1121 bridge', { changed });
  } catch (error) {
    s.log.warn('general-1121 bridge failed', { error: String((error as Error)?.message ?? error) });
  }
}
