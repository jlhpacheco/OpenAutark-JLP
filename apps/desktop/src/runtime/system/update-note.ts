// The update note (owner 22.11.2026: "dass das halt nicht das Ganze dann veraltet bleibt, sondern … sich auf die jeweilige
// Situation von einem PC … mit der KI richtig eben repariert"): code fixes what goes wrong from its version on; what an
// older version already left in a company's data, the AI heals – no code per old mistake. resources/updates.md holds one
// section per released version, newest first ("## 0.3.17", then short paragraphs: what changed, and for each leftover an
// older install may carry how it shows, how I check for it and how I fix it). At runtime start (main.ts, right before
// recordStart stores this start's version as kv system/version – tasks/recover-notes.ts), when this data folder last ran
// an older version, the person's personal manager (shared/text/manager-chat.ts managerAgent) gets ONE wake – only on the
// PC that is its home (devices/sync/home.ts homeElsewhere) – whose note is a lead in its own voice plus every section newer
// than that version up to this one. A folder whose first run is not done (devices/connect.ts isSetUp: a fresh install, a
// company still joining) gets none; one that ran before without a known version gets this version's section alone.
// Versions follow semver order: a local build (0.3.18-local.2) comes before its release, so a release's section reaches
// a PC once, also after local builds of it. No bridge: this step stays in the code for every release.
// Owns: reading updates.md, the version order, the lead's words and that wake. Never: changes data itself, writes the
// version mark (recordStart does), or wakes an archived agent or one at home on another PC.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import { managerAgent } from '../../shared/text/manager-chat.ts';
import { KvRepo } from '../store/kv.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { isSetUp } from '../devices/connect.ts';

/** The shipped update notes, in the resources folder. */
export const UPDATES_FILE = 'updates.md';
/** The version this data folder ran last: recordStart (tasks/recover-notes.ts) stores it at every start, after this step read it. */
const RAN = { ns: 'system', key: 'version' } as const;

export type NoteServices = Pick<RuntimeServices, 'db' | 'org' | 'wakes' | 'paths' | 'settings' | 'log'>;

/** One version's section of updates.md: its version and its whole text, heading included. */
export interface UpdateSection { version: string; text: string }

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const HEADING = /^## +v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]*$/m;

/**
 * The order of two versions as semver sets it: negative when `a` comes first, 0 when equal; a pre-release comes before its
 * release (0.3.18-local.2 < 0.3.18), pre-releases among themselves by their parts (local.2 < local.10). Undefined when
 * either is no version.
 */
export function versionOrder(a: string, b: string): number | undefined {
  const x = VERSION.exec(a.trim());
  const y = VERSION.exec(b.trim());
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Math.sign(Number(x[i]) - Number(y[i]));
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return Math.sign(x[4].localeCompare(y[4], 'en', { numeric: true }));
}

/** updates.md as its sections in file order: each "## <version>" heading with what stands below it (text above the first is the file's own intro). */
export function parseUpdates(text: string): UpdateSection[] {
  const out: UpdateSection[] = [];
  for (const part of text.replace(/\r\n?/g, '\n').split(/^(?=## )/m)) {
    const version = HEADING.exec(part.split('\n', 1)[0]!)?.[1];
    if (version) out.push({ version, text: part.trim() });
  }
  return out;
}

/** The shipped sections; none when the file is missing (a test profile without resources). */
export function readUpdates(resources: string): UpdateSection[] {
  try { return parseUpdates(readFileSync(path.join(resources, UPDATES_FILE), 'utf8')); } catch { return []; }
}

/**
 * What a folder that last ran `previous` reads on `version`, newest first: every section after `previous` up to `version`;
 * without a known `previous`, `version`'s own section alone; nothing for the same, an older or a pre-release version.
 */
export function sectionsFor(sections: readonly UpdateSection[], previous: string | undefined, version: string): UpdateSection[] {
  const known = previous !== undefined && versionOrder(previous, previous) === 0 ? previous : undefined;
  return sections
    .filter((section) => {
      const upTo = versionOrder(section.version, version);
      if (upTo === undefined || upTo > 0) return false;
      return known === undefined ? upTo === 0 : (versionOrder(section.version, known) ?? 0) > 0;
    })
    .sort((a, b) => versionOrder(b.version, a.version) ?? 0);
}

/** The lead above the sections, in the personal manager's own voice (`person`: whom it asks, by name when known). */
export function updateLead(input: { previous?: string; version: string; person?: string }): string {
  const moved = input.previous ? `Autark on this PC moved from ${input.previous} to ${input.version}.` : `Autark on this PC runs ${input.version} now.`;
  const who = input.person?.trim() || 'the person';
  return `${moved} The new code handles what comes from now on; what an older version already left in our company – data it got wrong, and what we set up to work around its faults – stays until I put it right. `
    + 'Each point below says how such a leftover shows, how I check for it and how I fix it. '
    + `I check our company for each with my own tools and set right what I find – what is already right I leave as it is, and where only ${who} can tell what was meant, I ask in one line.`;
}

/** The start step (main.ts, before recordStart): the personal manager's one wake when this folder last ran an older version; true when it woke. */
export function sendUpdateNote(s: NoteServices, version: string): boolean {
  try {
    const previous = new KvRepo(s.db).get<string>(RAN.ns, RAN.key);
    if (previous === version || !isSetUp(s)) return false; // the same version again, a fresh install or a company still joining
    const sections = sectionsFor(readUpdates(s.paths.resources), previous, version);
    const manager = sections.length ? managerAgent(s.org.list()) : undefined;
    if (!manager || homeElsewhere(s, manager.id)) return false; // its home PC sends it when that PC runs this version
    const lead = updateLead({ previous, version, person: s.settings.get().profile?.name });
    s.wakes.wake({
      agentId: manager.id, reason: 'event', coalesceKey: `update-note:${version}`,
      origin: { source: ORIGINS.system.source, label: `Update to ${version}` },
      note: [lead, ...sections.map((section) => section.text)].join('\n\n'),
    });
    s.log.info('update note: personal manager woken', { agentId: manager.id, from: previous ?? null, to: version, sections: sections.length });
    return true;
  } catch (error) {
    s.log.warn('update note not sent', { error: String(error) });
    return false;
  }
}
