// The LIVE part of the prompt (the first block of the turn input, never the system prompt): what changes between turns,
// each section under a fixed name (a resumed native session gets only the changed ones, agents/volatile-delta.ts). Order:
// now (date, time and zone, the model the turn runs on), the split's own facts (B-057), "My environment now"
// (environment.ts), who works nearby (work-presence), the models line, "## My chats" (chat-overview.ts), my split groups
// still at work, my home project and its skills (agent-core/prompt.ts), "## Pinned" – always-skills and pinned notes
// with the day they were saved under one cap (knowledge/always.ts) –, "## My quests" (Quests round 20.11.2026: one line per
// open quest of mine, no cap, then my lone to-dos – context/quest-text.ts), the turn's own quest or to-do as it stands, and
// "## Related open work" when a person's new line is about the work of others. A section says real news only: no counters,
// no previews of my own lines, times absolute in the person's zone (context/time.ts). One agent, one context: every section
// reads the agent's own mode (the turn's mode is its own); only the current work and the related work depend on what woke
// the turn. A split's turn (thread `split:<id>`) drops its main self's
// sections.
// B-083: "## Now" says what I run on – model · effort and the turn's temperature (route.temperature; where the model
// samples at its own setting, my stance for the step with TEMPERATURE_FACT) – and my start model and who set it.
// Owner 15.11.2026: "## Now" also names the engine the turn runs in ("in Claude Code"; environment.ts engineName) – the
// engines the system has stand in "My environment now".
// Halb 21.11.2026: "## Now" also says how big my context is (my session's own count, rounded to 5k, from 20k on, not in a part).
// B-089: the models line is its own section, so a price refresh or a catalog relist re-sends only that section.
// Runde „Halb“ 21.11.2026: last, "## From my memory" – the lines my subconscious gave this turn for the entries it picked from
// the word search, each with how it opens (subconscious/hints.ts); none when it gave none, so the section leaves again.
// Owns: those renderings and their caps. A failing source is skipped (logged), never fatal.
// Never: state reconstructed from memory similarity - tasks and schedules come from their services; any list of what
// memory holds beyond my subconscious's picks for this turn.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { temperatureText } from '../../shared/model/runs.ts';
import { dayName, fullDateTime, profileZone } from './time.ts';
import { TEMPERATURE_FACT, takesTemperature } from '../engines/http/temperature.ts'; // B-083
import { currentWorkSection, myQuestsSection, relatedSection } from './quest-text.ts'; // Quests round 20.11.2026
import { chatOverview } from './chat-overview.ts'; // 13.11.2026: "## My chats"
import { modelsFactsLine } from './setup-facts.ts';
import { SPLIT_SKIP, activeSplitsLine, splitFacts, splitSection } from './split-section.ts'; // B-057
import { ALWAYS_CHARS, alwaysLines, alwaysSet } from '../knowledge/always.ts';
import { homeSection } from '../agent-core/prompt.ts'; // B-044: the home project and its skills (names + descriptions)
import { engineName, environmentNow, ownFileTools } from './environment.ts'; // disk, companies and PCs, sign-ins, connected apps
import { workNearbySection } from '../work-presence/context-line.ts'; // B-055 G (Q11): who else is changing files near this agent's work
import { hintsSection, turnHints } from '../subconscious/hints.ts'; // Runde „Halb“ 21.11.2026: "## From my memory"
import { MAIN_THREAD } from '../../shared/model/origin.ts';
import { SessionStore } from '../agents/sessions.ts'; // Halb 21.11.2026: my context's size in "## Now"
import { isSplitThread } from '../../shared/model/splits.ts';

/** The one cap of what always stands in the prompt (knowledge/always.ts). */
export const PINNED_CAP = ALWAYS_CHARS;

export interface VolatileInput {
  agent: Agent;
  conversationId?: string;
  taskId?: string;
  /** B-054: the turn's thread (TurnPlan.thread) – its native session's key. */
  thread?: string;
  /** The turn's mode – the agent's own (agents/turn-prepare.ts); absent: the agent's mode key is looked up. */
  mode?: ModeInfo;
  route: RouteDecision;
}

function nowSection(services: RuntimeServices, input: VolatileInput, zone: string): string {
  const { route } = input;
  const now = services.clock.now();
  return [`## Now`, `${fullDateTime(now, zone)} (${zone})`, runsOnLine(services, route), startModelLine(services, input.agent, zone, now), contextLine(services, input)]
    .filter(Boolean).join('\n');
}

/** Below this my context is small enough to say nothing about it. */
export const CONTEXT_LINE_MIN = 20_000;

/**
 * Halb 21.11.2026: how big my context is – the engine's own count on my session of this thread (SessionBinding.contextTokens,
 * as of my last step), rounded to 5k; none below CONTEXT_LINE_MIN and none for a part (it starts small and ends).
 */
function contextLine(services: RuntimeServices, input: VolatileInput): string {
  if (!input.route.engine || (input.thread && isSplitThread(input.thread))) return '';
  let tokens: number | undefined;
  try { tokens = new SessionStore(services.db).get(input.agent.id, input.thread ?? MAIN_THREAD, input.route.engine)?.contextTokens; } catch { tokens = undefined; }
  if (!tokens || tokens < CONTEXT_LINE_MIN) return '';
  return `My context holds about ${Math.round(tokens / 5_000) * 5}k tokens; each step of mine reads it again.`;
}

/** A model's catalog name, else its id without the provider prefix. */
function modelName(services: RuntimeServices, id: string): string {
  try { return services.catalog.get(id)?.name ?? id.slice(id.indexOf(':') + 1); } catch { return id.slice(id.indexOf(':') + 1); }
}

/** B-083: "I run on X · effort Y[ · temperature Z], in <engine>." – a temperature the model does not take (thinking stays on, owner 09.11.) is my stance for this step. */
function runsOnLine(services: RuntimeServices, route: RouteDecision): string {
  let info: ReturnType<RuntimeServices['catalog']['get']>;
  try { info = services.catalog.get(route.modelId); } catch { info = undefined; /* catalog not wired */ }
  const runs = `I run on ${info?.name ?? route.modelId} · effort ${route.effort}`;
  const engine = route.engine ? `, in ${engineName(services, route)}` : '';
  if (route.temperature === undefined) return `${runs}${engine}.`;
  const warmth = temperatureText(route.temperature);
  const model = info?.model ?? route.modelId.slice(route.modelId.indexOf(':') + 1);
  if (takesTemperature(route.engine, model, route.effort)) return `${runs} · temperature ${warmth}${engine}.`;
  return `${runs}${engine}; temperature ${warmth} is my stance for this step, as this model samples at its own setting – ${TEMPERATURE_FACT}.`;
}

/** B-083: my start model (agent page, a manager's agents.update, or my own) and who set it, when – "on my page" for the owner's. */
function startModelLine(services: RuntimeServices, agent: Agent, zone: string, now: number): string {
  const { pin, pinBy } = agent.modelPolicy ?? {};
  if (!pin || pin === 'auto') return '';
  const who = !pinBy ? '' : pinBy.self ? ` (I set it myself, ${dayName(pinBy.at, zone, now)})` : ` (set by ${pinBy.name}${pinBy.name === ownerName(services) ? ' on my page' : ''}, ${dayName(pinBy.at, zone, now)})`;
  return `My start model: ${modelName(services, pin)}${who}.`;
}

function pinnedSection(services: RuntimeServices, agent: Agent, zone: string, conversationId?: string, mode?: ModeInfo): string {
  // B-078 D12: one always set – the always-skills and the pinned notes (each with the day it was saved), one cap (knowledge/always.ts)
  const lines = alwaysLines(services, agent, alwaysSet(services, agent, mode, conversationId), zone);
  return lines.length ? ['## Pinned', ...lines].join('\n') : '';
}

function ownerName(services: RuntimeServices): string {
  try { return services.settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; }
}

/** The agent's own mode (the turn's mode when given); undefined when the mode library does not know it. */
function ownMode(services: RuntimeServices, input: VolatileInput): ModeInfo | undefined {
  if (input.mode) return input.mode;
  try { return services.modes.get(input.agent.mode); } catch { return undefined; }
}

/** One rendered section of the volatile prompt under its fixed name ('now', 'environment', 'task' …); `failed`: its builder threw (text ''). */
export interface VolatileSection { name: string; text: string; failed?: true }

/** The volatile prompt as one string (the sections in order, a blank line apart). */
export function buildVolatile(services: RuntimeServices, input: VolatileInput): string {
  return volatileSections(services, input).filter((section) => !section.failed).map((section) => section.text).join('\n\n');
}

/**
 * The volatile prompt's non-empty sections in order, each under its fixed name (B-049 F6: a resumed native session gets
 * only the changed ones, agents/volatile-delta.ts). A section whose builder threw comes back as `failed` with no text,
 * so the delta keeps its last record instead of calling it no longer current.
 */
export function volatileSections(services: RuntimeServices, input: VolatileInput): VolatileSection[] {
  const { agent, conversationId, taskId } = input;
  const zone = profileZone(services); // the Now line's zone; saved/indexed days use the same one (knowledge/age.ts)
  const split = splitFacts(services, input.thread); // B-057: a split's turn (thread split:<id>)
  const reach = conversationId ?? split?.group?.conversationId; // B-057 S15: a split's pinned notes are its parent chat's
  const mode = ownMode(services, input);
  const sections: Array<[string, () => string]> = [
    ['now', () => nowSection(services, input, zone)],
    ['split', () => (split ? splitSection(agent, split) : '')], // B-057 S5: who it is, its part, the other parts, its rules
    ['environment', () => environmentNow(services, { agent, mode })],
    ['models', () => modelsFactsLine(services)], // B-089: the connected models with price, smarts and how a turn is paid (B-078 D16)
    ['work-nearby', () => workNearbySection(services, { agent, taskId })], // B-055 G (Q11): at most 3 lines / 300 chars, '' when no one works nearby
    ['chats', () => chatOverview(services, agent.id, conversationId)],
    ['splits', () => (split ? '' : activeSplitsLine(services, agent.id, input.thread, conversationId))], // B-057 R1-4: its split groups still at work (B-080: from every chat, this thread's first)
    ['home', () => homeSection(services, agent, mode?.key, ownFileTools(services, input.route?.engine))], // B-044: the home project turns start in and the skills found there
    ['pinned', () => pinnedSection(services, agent, zone, reach, mode)],
    ['quests', () => myQuestsSection(services, agent.id, zone)],
    ['task', () => (taskId ? currentWorkSection(services, taskId, agent.id, zone) : '')],
    ['related', () => relatedSection(services, agent.id, conversationId, zone)],
    ['memory', () => (split ? '' : hintsSection(turnHints(services, agent.id, input.thread ?? MAIN_THREAD)))], // Runde „Halb“: my subconscious's hints for this turn
  ];
  const out: VolatileSection[] = [];
  for (const [name, build] of sections) {
    if (split && SPLIT_SKIP.has(name)) continue; // B-057: its main self's sections
    try {
      const text = build();
      if (text.trim()) out.push({ name, text });
    } catch (error) {
      services.log?.debug('volatile prompt section skipped', { section: name, error: String(error) });
      out.push({ name, text: '', failed: true });
    }
  }
  return out;
}
