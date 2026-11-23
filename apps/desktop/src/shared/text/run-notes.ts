// The runtime's own notes in a run as one plain line each – what happened around the model, not what the model said:
// a switched model, a compacted or renewed session, a message steered into a running turn, a cut attempt, a released
// turn. They are run items of kind 'note' the runtime writes (agents/turn*.ts, dispatch-*.ts, compaction-policy.ts,
// rebuild.ts, splits/fork.ts, tools/timeout.ts). An agent's update (data.commentary) and its final answer (data.answer)
// are the model's own words and no system note. Used by the agent's activity log (team/AgentLog.tsx), the run step lines
// (team/run-steps.tsx) and the agents.log tool, so a person and an agent read the same words.
// Also the words around a turn that both read: what started it (triggerLabel), how it ended (RUN_STATUS_LABELS), how long
// it took (durationText) and its tokens (tokenLine) – shared by Team › agent and the agents.log tool.
// Owns: these lines (unit-tested in test/unit/ui/run-notes.test.ts). Never: imports runtime, ui or the DOM.

import type { Run, RunItem, WakeReason } from '../model/runs.ts';

const TRIGGERS: Record<WakeReason, string> = {
  message: 'Message', task: 'Task', schedule: 'Schedule', answer: 'Answer',
  child: 'Delegated work finished', retry: 'Retry', review: 'Review', manual: 'Manual',
  event: 'Event', split: 'Split', // B-057
  fold: 'Context fold', // KI-Runde 17.11.2026: the agent writes its hand-over
};

/** What started a run: its origin's label ("New mail in office@…"), else the wake reason's (B-054). */
export function triggerLabel(run: Pick<Run, 'trigger' | 'origin'>): string {
  return run.origin?.label || TRIGGERS[run.trigger] || run.trigger;
}

export const RUN_STATUS_LABELS: Record<Run['status'], string> = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', interrupted: 'Stopped', unknown: 'Unknown' };

/** How long something took (or runs so far): "4 s", "2 min 5 s", "1 h 3 min"; '' before it started. */
export function durationText(startedAt: number | undefined, endedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** B-089: a run's tokens in one line – "12,400 in · 9,800 cached · 640 out · 7 calls"; each part only where it was reported. */
export function tokenLine(run: Pick<Run, 'inputTokens' | 'cachedTokens' | 'outputTokens' | 'modelCalls'>): string {
  const count = (value: number | undefined, unit: string) => (value === undefined ? '' : `${value.toLocaleString('en-US')} ${unit}`);
  return [count(run.inputTokens, 'in'), count(run.cachedTokens, 'cached'), count(run.outputTokens, 'out'),
    run.modelCalls === undefined ? '' : `${run.modelCalls.toLocaleString('en-US')} ${run.modelCalls === 1 ? 'call' : 'calls'}`].filter(Boolean).join(' · ');
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const obj = (value: unknown): Record<string, unknown> | undefined =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const seconds = (ms: unknown): string => { const value = num(ms); return value === undefined ? '' : ` ${Math.round(value / 1000)} s`; };
const paren = (value: string): string => (value ? ` (${value})` : '');

/** True for a note the runtime wrote itself (not the agent's update or answer). */
export function isSystemNote(item: Pick<RunItem, 'kind' | 'data'>): boolean {
  return item.kind === 'note' && item.data.commentary !== true && item.data.answer !== true;
}

/** One line for a system note; undefined for any other item. */
export function systemNoteText(item: Pick<RunItem, 'kind' | 'name' | 'data'>): string | undefined {
  if (!isSystemNote(item)) return undefined;
  const data = item.data;
  const failover = obj(data.failover);
  if (failover) return `Switched to ${str(failover.to) || 'another model'}${paren(failover.reason === 'limit' ? 'limit reached' : 'model unavailable')}`;
  if (data.modelSet !== undefined) return `Model set to ${str(data.model) || 'another model'}${str(data.from) ? ` (was ${str(data.from)})` : ''}`;
  if (data.compacted !== undefined) return `Context compacted${paren(data.compacted === 'stateless' ? '' : str(data.compacted))}`;
  if (data.checkpoint === true) return 'Hand-over written';
  if (data.fold !== undefined) return data.fold === 'kept' ? `Context not folded${paren(str(data.reason))}` : `Context folded: ${num(data.hidden) ?? 0} earlier parts behind the hand-over`;
  if (data.sessionRenewed !== undefined) return `New session${paren(str(data.sessionRenewed))}`;
  if (data.fresh !== undefined) return `Fresh session${paren(str(data.fresh))}${data.history === 'rebuilt' ? ', history rebuilt' : ''}`;
  if (data.sessionDropped !== undefined) return `Session dropped${paren(str(data.sessionDropped).replace(/_/g, ' '))}`;
  if (data.rebuild !== undefined) {
    const kind = str(data.rebuild);
    if (kind === 'skipped') return `Session rebuild skipped${paren(str(data.why))}`;
    if (kind === 'fallback' || kind === 'revert_fallback') return `Session rebuild fell back${paren(str(data.why) || str(data.reason).replace(/_/g, ' '))}`;
    return 'Session rebuilt';
  }
  const fit = obj(data.fit);
  if (fit) return `${num(fit.hidden) ?? 0} older parts left out to fit the context`;
  if (data.previousAttempt !== undefined) return 'Continues after an earlier attempt';
  if (data.imagesHidden === true) return 'Images left out: this model reads no images';
  if (data.released === true) return 'Turn released: it did not stop after its abort';
  const stalled = obj(data.stalled);
  if (stalled) return `Engine quiet for${seconds(stalled.quietMs)} – attempt cut`;
  const steered = obj(data.steered);
  if (steered) { const lines = num(steered.lines) ?? 0; return `${lines} new ${lines === 1 ? 'line' : 'lines'} reached the running turn`; }
  if (obj(data.told)) return 'Told something while working';
  const relayed = obj(data.relayed);
  if (relayed) return `Relayed while working${paren(str(relayed.mode))}`;
  if (data.traceAsText !== undefined) return 'Engine trace kept as text';
  if (data.splitSeed !== undefined) return `Split started${paren(str(data.splitSeed))}`;
  const decision = obj(data.decision);
  if (decision) return `Decision${str(decision.question) ? `: ${str(decision.question)}` : ''}${str(decision.outcome) ? ` → ${str(decision.outcome)}` : ''}`;
  if (data.mailReplyAttempted === true) return 'Mail reply sent';
  if (str(data.summary)) return str(data.summary);
  return item.name || 'System note';
}
