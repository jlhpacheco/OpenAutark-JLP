// The member's personal assistant (B-041): the active agent hired as 'secretary' or 'ceo-assistant' that works for that
// member (the first person up its chain of command – the owner 'human' at the top; the shallowest, then the oldest
// when there are several), else – for the owner – the responsible manager of the private space (or of everything,
// without one), else none. wakeAssistant tells it once about the person's new line (Quests round 20.11.2026, the one
// intake tasks/quick.ts – one wake, coalesced; origin 'news'): the to-do it became, the times its words name that the
// person did not confirm (shared/text/when.ts findTimes – which one is meant is the assistant's call), the open work it is
// about (tasks/related.ts) and the sorting text (requestLine); a line can be a request to it about the page itself
// (feedback fdfdb52a), which it carries out on the items in place; the note lists the person's other open to-dos
// (dayItemLines) – "Only me" ones marked: they stay the person's, I help around them – never finished to-dos.
// Owns: who the assistant is, those lines and that wake. Never: writes a to-do or picks a colleague's agent for the owner.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Agent } from '../../shared/model/org.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { UNFINISHED, type Task } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { findTimes, wallOf } from '../../shared/text/when.ts';
import type { RuntimeServices } from '../contracts.ts';
import { responsibleManager } from '../tasks/owners.ts';
import { nameOf } from '../tasks/give.ts';
import { relatedWork } from '../tasks/related.ts';
import { dueText } from '../context/time.ts';
import { dayZone } from './clock.ts';

export const ASSISTANT_TEMPLATES: readonly string[] = ['secretary', 'ceo-assistant'];

/** The member's name, when there is one. */
function memberName(s: Partial<Pick<RuntimeServices, 'settings' | 'people'>>, ownerId: string): string | undefined {
  let name: string | undefined;
  try { name = ownerId === HUMAN_ID ? s.settings?.get().profile.name : s.people?.nameOf(ownerId); } catch { name = undefined; }
  return name?.trim() || undefined;
}

/** The wake's note, above the new line ("The person" without a name). */
export function prepareNote(s: Partial<Pick<RuntimeServices, 'settings' | 'people'>>, ownerId: string): string {
  return `${memberName(s, ownerId) ?? 'The person'} wrote a line on the Tasks page; it stands as their own to-do:`;
}

/**
 * How I sort a person's line, in my words (Quests round 20.11.2026; feedback fdfdb52a: the line is also where the person
 * tells me what to change on the page).
 */
export function requestLine(name: string): string {
  return `A line about the Tasks page itself is ${name}'s request to me: I carry it out on the items there and finish that to-do with what I changed. `
    + `Any other line is ${name}'s ask: I sort it the way it serves them – what an agent can do becomes that agent's to-do and what only ${name} can do stays theirs, `
    + `in the quest it belongs to, with a time only where the words make clear which one – and every change stands in the to-do's thread.`;
}

/** The bundled wake's key and delay (lines sent in a quick row join one wake; a request on the page is not kept waiting). */
const WAKE_KEY = 'assistant:todos';
const WAKE_DELAY_MS = 15_000;
/** How many open to-dos one wake names at most. */
const MAX_LINES = 30;

export type AssistantDeps = Pick<RuntimeServices, 'org' | 'tasks' | 'wakes' | 'clock'> & Partial<Pick<RuntimeServices, 'log' | 'settings' | 'people' | 'db'>>;

const isAssistant = (agent: Agent) => ASSISTANT_TEMPLATES.includes(agent.template ?? '') || ASSISTANT_TEMPLATES.includes(agent.mode);
const isManager = (agent: Agent) => agent.mode === 'manager' || agent.template === 'manager';

/** The member an agent works for: the first person up its chain ('human' at the top). */
function memberOf(org: Pick<RuntimeServices['org'], 'get'>, agent: Agent): string {
  let current: Agent | undefined = agent;
  for (let hops = 0; current && hops < 20; hops++) {
    const boss = current.managerId;
    if (!boss) return HUMAN_ID;
    if (boss === HUMAN_ID || isPersonId(boss)) return boss;
    current = org.get(boss);
  }
  return HUMAN_ID;
}

/** The assistant of `ownerId` ('human' or a per_… id), or none. */
export function personalAssistant(s: Pick<RuntimeServices, 'org'>, ownerId: string): Agent | undefined {
  let agents: Agent[];
  try { agents = s.org.list().filter((agent) => agent.archivedAt === undefined); } catch { return undefined; }
  const depth = (agent: Agent) => { try { return s.org.managers(agent.id).length; } catch { return 0; } };
  const own = agents.filter((agent) => isAssistant(agent) && memberOf(s.org, agent) === ownerId)
    .sort((a, b) => depth(a) - depth(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (own[0]) return own[0];
  if (ownerId !== HUMAN_ID) return undefined; // a colleague's own space comes later (contract §7)
  let privateSpace: string | undefined;
  try {
    privateSpace = s.org.spaces().filter((space) => space.kind === 'private' && space.archivedAt === undefined)
      .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)[0]?.id;
  } catch { privateSpace = undefined; }
  const manager = responsibleManager(s.org, privateSpace);
  return manager && isManager(manager) && memberOf(s.org, manager) === HUMAN_ID ? manager : undefined;
}

/** The member's open to-dos and asks (theirs – the owner's: 'human' or none – "Only me" ones too), oldest first. */
export function dayItems(s: Pick<RuntimeServices, 'tasks'>, ownerId: string): Task[] {
  let open: Task[];
  try { open = s.tasks.list({ assigneeKind: 'human', status: [...UNFINISHED], includeSteps: true, limit: 500 }); } catch { return []; }
  return open.filter((task) => (task.assigneeId ?? HUMAN_ID) === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** One item as a wake line: "- tsk_1: title · from Lukas · since 2026-11-16" ("theirs" for the member's own; "only me" marked). */
export function itemLine(s: Partial<Pick<RuntimeServices, 'org' | 'settings' | 'people'>>, task: Task, ownerId: string, tz: string): string {
  const from = task.createdBy === ownerId ? 'theirs' : `from ${nameOf(s, task.createdBy)}`;
  return `- ${task.id}: ${excerpt(task.title, 100)} · ${from}${task.private ? ' · only me' : ''} · since ${wallOf(task.createdAt, tz).date}${task.parentId ? ` · in ${task.parentId}` : ''}`;
}

/** The lines of the member's open to-dos now, `skip` left out; a last line counts what did not fit. */
export function dayItemLines(s: AssistantDeps, ownerId: string, skip: ReadonlySet<string> = new Set()): string[] {
  const items = dayItems(s, ownerId).filter((task) => !skip.has(task.id));
  const tz = dayZone(s);
  const lines = items.slice(0, MAX_LINES).map((task) => itemLine(s, task, ownerId, tz));
  if (items.length > MAX_LINES) lines.push(`- … and ${items.length - MAX_LINES} more (tasks.list who person has all)`);
  return lines;
}

/** A new line: the to-do it became, the words the person wrote, whether they confirmed its time. */
export interface NewLine { taskId: string; text: string; timed: boolean }

/** The note lines of one new line: the to-do, the times its words name (unconfirmed), the open work it is about. */
function newLineNotes(s: AssistantDeps, line: NewLine, task: Task, tz: string): string[] {
  const now = s.clock.now();
  const out = [`- ${task.id}: ${excerpt(task.title, 120)}${task.at !== undefined ? ` · at ${dueText(task.at, tz, now)} (they chose it)` : ''}${task.parentId ? ` · in ${task.parentId}` : ''}`];
  if (task.private) out.push('  only me: it needs them – I put it in a quest or give it a time, and it stays theirs');
  const times = line.timed ? [] : findTimes(line.text, now, tz);
  if (times.length) out.push(`  times in their words, none chosen: ${times.map((time) => `"${time.text}" = ${time.allDay ? wallOf(time.at, tz).date : dueText(time.at, tz, now)}`).join(', ')}`);
  const related = s.db ? relatedWork({ db: s.db, tasks: s.tasks }, line.text, 3, (row) => row.id === task.id) : [];
  if (related.length) out.push(`  open work it is about: ${related.map((hit) => `${hit.id} "${excerpt(hit.title, 60)}" (${hit.kind} of ${nameOf(s, hit.assigneeKind === 'agent' ? hit.assigneeId ?? '' : hit.assigneeId ?? HUMAN_ID)})`).join(', ')}`);
  return out;
}

/**
 * Tells the member's assistant about their new line in one wake: the to-do it became with the times its words name and the
 * open work it is about, how I sort it (requestLine) and their other open to-dos now. Returns the woken agent's id.
 */
export function wakeAssistant(s: AssistantDeps, ownerId: string, lines: readonly NewLine[], source: string): string | undefined {
  const agent = personalAssistant(s, ownerId);
  if (!agent) return undefined;
  const tz = dayZone(s);
  const notes: string[] = [];
  const ids = new Set<string>();
  for (const line of lines) {
    const task = s.tasks.get(line.taskId);
    if (!task || task.status === 'done' || task.status === 'dropped') continue; // "Only me" too: it stays theirs (newLineNotes)
    ids.add(task.id);
    notes.push(...newLineNotes(s, line, task, tz));
  }
  if (!notes.length) return undefined;
  const name = memberName(s, ownerId) ?? 'the person';
  const standing = dayItemLines(s, ownerId, ids);
  const note = [prepareNote(s, ownerId), ...notes, requestLine(name), ...(standing.length ? ['Their other open to-dos now:', ...standing] : [])].join('\n');
  s.wakes.wake({ agentId: agent.id, reason: 'task', coalesceKey: WAKE_KEY, dueAt: s.clock.now() + WAKE_DELAY_MS, note, origin: ORIGINS.news });
  s.log?.info('assistant told about a new line', { agentId: agent.id, count: ids.size, source });
  return agent.id;
}
