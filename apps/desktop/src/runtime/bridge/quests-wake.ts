// bridge 0.3.16 of the Quests round 20.11.2026 (twenty task, schedule and calendar tools became tasks.add, tasks.update,
// tasks.list, tasks.remind, calendar.list and calendar.connect), at runtime start beside the other bridges
// (runtime/main.ts), each part once:
// - tool names (kv mark 'names'): the tools an agent learned to hold directly (tools/learned.ts) and every such name in
//   the SYSTEM.md of an agent at home here take the tool that does that work now (RENAMED) – a tool's name is a fact, not
//   the agent's voice;
// - one wake per active agent at home here that holds open work (quests it owns, holds an open to-do in or gave, and its
//   lone to-dos – context/quest-text.ts myWork): it sorts that work into quests, sets one next note per quest and closes
//   what no longer holds; the note lists the work as "## My quests" shows it (kv mark per agent – an agent without open
//   work is marked too; one at home on another PC is woken there). Only where migration 110 converted existing task rows
//   (its kv mark quests/converted) and only agents hired before that – never on a fresh install or for a new hire (R1.11).
// This file is deleted in the version after the bridge.
// Owns: those conversions, that wake, its words and its marks. Never: changes a task or a schedule itself, a SYSTEM.md
// beyond the tool names, or wakes an archived agent.

import type { RuntimeServices } from '../contracts.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import { KvRepo } from '../store/kv.ts';
import { LEARNED_NS } from '../tools/learned.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { myQuestsSection, myWork } from '../context/quest-text.ts';
import { profileZone } from '../context/time.ts';

const KV = 'bridge.quests-2011';

/** The old tool names → the tool that does that work now. */
export const RENAMED: Readonly<Record<string, string>> = {
  'tasks.create': 'tasks.add', 'tasks.give': 'tasks.update', 'tasks.finish': 'tasks.update', 'tasks.get': 'tasks.list',
  'todos.prepare': 'tasks.update', 'schedules.message': 'tasks.remind', 'schedules.remind': 'tasks.remind',
  'schedules.routine': 'tasks.remind', 'schedules.update': 'tasks.remind', 'schedules.list': 'tasks.remind',
  'schedules.cancel': 'tasks.remind', 'calendar.find_free': 'calendar.list', 'calendar.add': 'tasks.add',
  'calendar.place_task': 'tasks.update', 'calendar.move': 'tasks.update', 'calendar.remove': 'tasks.update',
};

/** The wake's note above my work as it stands (in my own voice). */
export const QUESTS_WAKE_NOTE = 'Autark keeps work as quests now: a goal with its done-when, holding the to-dos of me, my colleagues and the person, '
  + 'each with its own thread. My open work from before stands below. I sort it now – every piece into the quest it belongs to, '
  + 'one next note per quest – and what no longer holds I change or close at once, because the person acts on what it says.';

const OLD_NAME = new RegExp(`(?<![\\w.])(${Object.keys(RENAMED).map((name) => name.replace(/\./g, '\\.')).join('|')})(?![\\w])`, 'g');

/** A text with every old tool name as the tool that does it now. */
export function withQuestTools(text: string): string {
  return text.replace(OLD_NAME, (name) => RENAMED[name] ?? name);
}

/** The learned tools and the SYSTEM.md texts under today's names; returns how many agents changed. */
export function renameQuestTools(s: Pick<RuntimeServices, 'db' | 'clock' | 'org'>): number {
  const kv = new KvRepo(s.db);
  const now = (names: unknown) => (Array.isArray(names) ? [...new Set(names.map((name) => (typeof name === 'string' ? RENAMED[name] ?? name : name)))] : names);
  let changed = 0;
  for (const { key, value } of kv.list<{ core?: unknown; used?: unknown }>(LEARNED_NS)) {
    const next = { ...value, core: now(value?.core), used: now(value?.used) };
    if (JSON.stringify(next) === JSON.stringify(value)) continue;
    kv.set(LEARNED_NS, key, next, s.clock.now());
    changed++;
  }
  for (const agent of s.org.list({ includeArchived: true })) {
    if (homeElsewhere(s, agent.id)) continue;
    const next = withQuestTools(agent.instructions);
    if (next === agent.instructions) continue;
    s.org.update(agent.id, { instructions: next }, { by: HUMAN_ID, reason: 'Tool names of the Quests round: the tool that does it now.' });
    changed++;
  }
  return changed;
}

/** The mark migration 110 writes when it converted existing task rows (kv quests/converted): when it did, else undefined. */
export const CONVERTED = { ns: 'quests', key: 'converted' } as const;
function convertedAt(kv: KvRepo): number | undefined {
  return kv.list<unknown>(CONVERTED.ns, CONVERTED.key).find((row) => row.key === CONVERTED.key)?.updatedAt;
}

/** Wakes each agent with open work from before the update once (R1.11: only where 110 converted data); returns how many were woken. */
export function wakeForQuests(s: RuntimeServices): number {
  const kv = new KvRepo(s.db);
  const since = convertedAt(kv);
  if (since === undefined) return 0; // a fresh install, or nothing was converted: there is no work from before
  const zone = profileZone(s);
  let woken = 0;
  let agents: ReturnType<RuntimeServices['org']['list']> = [];
  try { agents = s.org.list().filter((agent) => agent.archivedAt === undefined); } catch { return 0; }
  for (const agent of agents) {
    if (kv.get<boolean>(KV, agent.id) || homeElsewhere(s, agent.id) || agent.createdAt > since) continue; // hired after the update: nothing from before
    try {
      const { quests, other } = myWork(s, agent.id);
      if (quests.length || other.length) {
        const lines = myQuestsSection(s, agent.id, zone).split('\n').slice(1);
        s.wakes.wake({ agentId: agent.id, reason: 'schedule', note: [QUESTS_WAKE_NOTE, ...lines].join('\n'), coalesceKey: 'quests-bridge', origin: ORIGINS.system });
        woken++;
      }
      kv.set(KV, agent.id, true, s.clock.now());
    } catch (error) {
      s.log.warn('quests bridge: an agent was not woken', { agentId: agent.id, error: String(error) });
    }
  }
  return woken;
}

/** Both parts, each once (see the header). */
export function runQuestsWake(s: RuntimeServices): void {
  const kv = new KvRepo(s.db);
  if (!kv.get<boolean>(KV, 'names')) {
    try {
      const renamed = renameQuestTools(s);
      kv.set(KV, 'names', true, s.clock.now());
      if (renamed) s.log.info('quests bridge: tool names now', { agents: renamed });
    } catch (error) { s.log.warn('quests bridge: tool names not converted', { error: String(error) }); }
  }
  const woken = wakeForQuests(s);
  if (woken) s.log.info('quests bridge: agents woken to sort their work', { woken });
}
