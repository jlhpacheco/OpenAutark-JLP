// Shared text rules of the native rebuild for Codex and Claude Code: how a ledger item that has
// no native counterpart in the target CLI reads as text, and the bound of a native tool's output.
// Owns: the record of a call with no native counterpart (with its detail and – B-049 F9 – a script's nested-calls line,
// recordText), a code-mode script's first line,
// the condensed item's restore stamp at the end of its text, model families (reasoning replays only within
// one), and how a failed first turn on a
// rebuilt session is reported (an ended session, so the executor falls back).
// Never: invents content – every note is built from the ledger item's own text, call and output.

import type { EngineTurnResult, RebuildItem } from './types.ts';
import { boundOutput } from './output.ts';
import { isScriptCall } from './code-mode.ts';

export { boundOutput };
/** The summary of a native call's arguments in its note. */
const SUMMARY_CHARS = 200;

/** The item's text with its restore stamp appended verbatim (condensed items). */
export function withStamp(text: string, stamp?: string): string {
  if (!stamp) return text;
  return text.trim() ? `${text}\n${stamp}` : stamp;
}

/** B-049 F9: a code-mode script's first line that says something (no blank line, no `// @exec:` pragma), at most `max` characters. */
export function scriptLine(source: string, max = 120): string {
  const line = source.split('\n').map((entry) => entry.trim()).find((entry) => entry && !/^\/\/\s*@exec:/.test(entry)) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A short line for a native call's arguments: the command, the path(s), the query or a script's first line, else compact JSON. */
export function argsSummary(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, SUMMARY_CHARS);
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'query', 'file_path', 'path', 'url', 'pattern', 'description', 'source']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return key === 'source' ? scriptLine(value, SUMMARY_CHARS) : value.slice(0, SUMMARY_CHARS);
      if (Array.isArray(value) && value.length) return value.map(String).join(' ').slice(0, SUMMARY_CHARS);
    }
    if (Array.isArray(record.files) && record.files.length) return record.files.map(String).join(', ').slice(0, SUMMARY_CHARS);
  }
  try { return (JSON.stringify(args) ?? '').slice(0, SUMMARY_CHARS); } catch { return ''; }
}

/**
 * 17.11.2026 (BEFUND-RUNTIME-JAN §3): a call the target cannot replay natively, as ONE user-side record – what ran and
 * its output. Before, "[ran Write: {…}]" stood as the model's own assistant text; models then "called" tools by writing
 * that line and ended their turn, and nothing ran (6 turns on 16./17.11.). A record on the user side, worded as a
 * record, is nothing the model said and nothing to imitate. `output`: the output text to show (default the call's).
 */
export function recordText(call: NonNullable<RebuildItem['call']>, options: { detail?: string; calls?: string; stamp?: string; output?: string } = {}): string {
  const summary = argsSummary(call.args);
  const failed = call.ok === false ? ' (failed)' : '';
  return withStamp([
    `[record of an earlier call, not replayable here – ${call.name}${summary ? `: ${summary}` : ''}]`,
    options.detail, options.calls ? `Calls inside the script: ${options.calls}.` : '',
    `[its output${failed}]`, boundOutput(options.output ?? (call.output || '(no output)')),
  ].filter(Boolean).join('\n'), options.stamp);
}

/**
 * A final text that begins with a call record or a "[ran …]" line – a turn that imitated a call instead of making it
 * (nothing ran). The six real ones (16./17.11.) were each such a line with the call's JSON arguments, and nothing else.
 */
export function imitatedCall(text: string): boolean {
  return /^\s*\[(ran [\w.-]+[:\]]|record of an earlier call\b|output of\b|its output\b)/.test(text); // \"[ran out of …\" is prose
}

// Historical engine-owned shell rows were not protected at the model boundary. Never replay their
// arguments or results as model context, regardless of the target tool inventory.
export const legacyShellOmission = (count: number): string =>
  `[Earlier native shell or script calls omitted: ${count}. Their results are not available in the rebuilt context.]`;
const LEGACY_SHELL_NAMES = new Set(['Bash', 'PowerShell', 'shell', 'exec_command', 'shell_command', 'write_stdin']);

export function legacyNativeShell(call: Pick<NonNullable<RebuildItem['call']>, 'name' | 'managed'>, engine?: string): boolean {
  // Historical Code Mode aggregates can contain nested shell output without retained provenance. 0.3.19: an aggregate whose
  // journal rows carry the row mark (`managed`, set where turn-attempt.ts wrote them for a thread without native shell) is
  // no legacy row; the mark is never derived from a session's mark, and native shell names stay blocked whatever they carry.
  if (LEGACY_SHELL_NAMES.has(call.name)) return true;
  return isScriptCall(call.name, engine) && call.managed !== true;
}

/** A model's family: the provider prefix and the variant suffix dropped ("codex:gpt-6.1-sol-mini" → "gpt-6.1"). */
export function modelFamily(model: string | undefined): string {
  const id = (model ?? '').toLowerCase().replace(/^[a-z0-9_-]+:/, '').replace(/\[.*\]$/, '');
  return id.split('-').slice(0, 2).join('-');
}

/** Whether a reasoning item may be replayed natively: same engine, same account and same model family. */
export function sameReasoningSource(item: RebuildItem, target: { engine: string; accountId: string; model: string }): boolean {
  const origin = item.origin;
  return origin?.engine === target.engine && origin.accountId === target.accountId && modelFamily(origin.model) === modelFamily(target.model);
}

/**
 * The first turn on a rebuilt session failed in a way the rebuilt history may have caused (the CLI or the
 * API refused it): reported as an ended session (details.rebase, rebuild 'failed'), so the executor drops
 * at once to today's renewal. Limits, sign-outs, outages and stops stay as they are.
 */
export function rebuiltTurnFailed(result: EngineTurnResult): EngineTurnResult {
  if (result.stop !== 'error' || result.error?.code !== 'internal') return result;
  return { ...result, session: undefined, error: { code: 'conflict', message: 'The rebuilt session could not continue.', details: { rebase: true, rebuild: 'failed', cause: result.error.message } } };
}

/** Whether a call replays as a real call of ours (any tool of the app, offered this turn or not): every call that was not engine-native. */
export function oursCall(call: NonNullable<RebuildItem['call']>): boolean {
  return call.own !== true && call.name !== 'tool';
}
