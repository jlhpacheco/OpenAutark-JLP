// Adaptive deadlines shared by shell commands and engine-native tools. An abort says that the app stopped the call
// (B-072, live 03.11.2026: an app timeout was read as the person's "no" and became a team rule). B-080 (live 05.–08.11.:
// 71 of 80 aborts came from no decision at all – a failed backend, an unsure or "none" answer – and 66 calls with their
// own `timeout` were reviewed at 60 s): a call's own limit comes first, in each form the engines send it, and without a
// clear decision the call keeps running and is looked at again after the same time. B-080 wave 3: a review of a command
// also learns how much it printed since the last look (newOutputChars; native calls report none).
// Owns: initial estimates, bounded subconscious reviews and their journal. Never: restarts a command or exposes secrets.

import type { ToolContext } from './types.ts';
import { preview } from './outputs.ts';

export interface ToolTimeoutInput {
  tool: string;
  args: unknown;
  elapsedSeconds: number;
  /** Seconds since the call started or since the last review – the wait that just ended. */
  timeoutSeconds: number;
  output: string;
  /** B-080 wave 3: characters the call printed since the last review, where the runner sees its output (shell.exec). */
  newOutputChars?: number;
  /** B-080 wave 3 review: seconds since the last observation was built – the span newOutputChars covers (a review itself
   * can take up to TIMEOUT_REVIEW_MS); absent: timeoutSeconds. */
  secondsSinceLastLook?: number;
}

export interface ToolTimeoutDecision {
  action: 'wait' | 'abort';
  seconds?: number;
  reason: string;
  by?: string;
}

export const TIMEOUT_REVIEW_MS = 120_000;
export const MAX_TIMEOUT_SECONDS = 1800;
/** Hard cap on one shell.exec call's total lifetime, reviews and extensions included (feedback 0B998EAF, 17.11.2026: a
 * command that started a dev server and left it holding the pipes lived 17,329 s – every review answered "wait another 15 s").
 * One hour is two of the longest single waits (MAX_TIMEOUT_SECONDS): generous for any install or build a call should block
 * on, far below the incident; longer jobs belong detached with a log the agent reads. At the cap the app ends the command's
 * own process tree by PID – never by program name, other runs use the same executables – and returns control. */
export const MAX_COMMAND_SECONDS = 2 * MAX_TIMEOUT_SECONDS;
/** What the result says when the cap ended the command (the output is withheld on this path like on any stop). */
export function commandCapNote(elapsedSeconds: number): string {
  return `The app ended the command at its total limit of ${MAX_COMMAND_SECONDS} s (${Math.round(elapsedSeconds)} s elapsed, timeout extensions included) and stopped its process tree – nobody declined it. Its output is withheld, as for every stopped command. A job this long: start it detached, write its log to a file and read that, or run a shorter step.`;
}
/** What a review without a clear decision answers (B-080): the call goes on. */
export const NO_DECISION = 'No clear timeout decision came back; I let the call run and look again after the same time.';

/** A wait of `seconds` as a review answers it: whole seconds within 1..MAX_TIMEOUT_SECONDS. */
export function sameWait(seconds: number, by?: string): ToolTimeoutDecision {
  return { action: 'wait', seconds: Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(seconds) || 1)), reason: NO_DECISION, ...(by ? { by } : {}) };
}

/** Claude Code's own tools whose `timeout` is in milliseconds; an ACP agent's shell (e.g. Kimi Code's) gives it in seconds. */
const MS_TIMEOUT_TOOLS = /^(?:Bash|PowerShell|TaskOutput)$/;

/** An estimate until the first review, not a maximum lifetime. The call's own limit comes first: timeoutSeconds (shell.exec),
 * timeout (ms for Claude Code's Bash, PowerShell and TaskOutput; seconds for any other tool, such as an ACP
 * agent's shell – B-080), timeout_ms (Codex's shell). */
export function initialTimeoutSeconds(name: string, args: unknown): number {
  const record: Record<string, unknown> = typeof args === 'string' ? { command: args } : args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const own = typeof record.timeoutSeconds === 'number' ? record.timeoutSeconds
    : typeof record.timeout === 'number' ? (MS_TIMEOUT_TOOLS.test(name) ? record.timeout / 1000 : record.timeout)
      : typeof record.timeout_ms === 'number' ? record.timeout_ms / 1000
        : undefined;
  if (own !== undefined && Number.isFinite(own) && own > 0) return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(own)));
  const command = [record.command, record.cmd, record.script, record.source].flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => typeof value === 'string').join(' ');
  const quick = /^\s*(?:rg|grep|findstr|select-string|git\s+(?:status|diff|log)|ls|dir|pwd|cat|head|tail|echo|Get-Content|Get-ChildItem)\b/i.test(command);
  if ((quick && !/[;&|\n]/.test(command)) || /grep|glob|search|read|list/i.test(name)) return 15;
  // Match executable/subcommand pairs rather than argument words: `rg install` is still a search.
  if (/\b(?:npm|pnpm|yarn|bun|pip\d?|uv|poetry|conda|brew|apt(?:-get)?|winget|choco|scoop|dotnet|cargo|git)\b[^;&|\n]*\b(?:install|ci|update|upgrade|download|clone|fetch|pull|restore|add)\b/i.test(command) || /^\s*(?:curl|wget|Invoke-WebRequest|Start-BitsTransfer)\b/i.test(command)) return 300;
  if (/\b(?:npm|pnpm|yarn|bun|dotnet|cargo|gradle|mvn|docker)\b[^;&|\n]*\b(?:build|test|check|compile|typecheck|package|publish)\b/i.test(command) || /(?:^|[;&|])\s*(?:pytest|tsc|webpack|vite|make|cmake)\b/i.test(command)) return 180;
  if (quick) return 15;
  return 60;
}

/** Who stopped an aborted call: the app, not the person (native-timeout.ts says it on the continuation too). */
export const APP_STOPPED = 'The app stopped the running call for its time limit – nobody declined it.';

export function timeoutDecisionText(input: Pick<ToolTimeoutInput, 'tool' | 'elapsedSeconds'>, decision: ToolTimeoutDecision): string {
  const action = decision.action === 'wait' ? `wait another ${decision.seconds} seconds until the next timeout` : 'abort the running call';
  const stopped = decision.action === 'abort' ? `${APP_STOPPED} I check its effects and go on – other ways work too. ` : '';
  return `Subconscious timeout decision for ${input.tool} after ${input.elapsedSeconds}s: ${action}. ${stopped}${decision.reason}${decision.by ? ` (${decision.by})` : ''}`;
}

/** A timeout review is itself bounded, even when a helper ignores cancellation. The running tool may finish during it. */
export async function reviewToolTimeout(ctx: ToolContext, input: ToolTimeoutInput, signal = ctx.signal): Promise<ToolTimeoutDecision> {
  const controller = new AbortController();
  const stop = AbortSignal.any([ctx.signal, signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_REVIEW_MS);
  const redact = (value: string) => ctx.services.secrets.redact(value);
  const fallback = sameWait(input.timeoutSeconds); // B-080: no decision, no stop
  let cancel: (() => void) | undefined;
  try {
    const clean = { ...input, args: JSON.parse(redact(JSON.stringify(input.args ?? {}))), output: redact(input.output).slice(-6000) }; // newOutputChars as given
    const ended = new Promise<ToolTimeoutDecision>((resolve) => {
      cancel = () => resolve(fallback);
      if (stop.aborted) cancel();
      else stop.addEventListener('abort', cancel, { once: true });
    });
    const work = Promise.resolve().then(() => stop.aborted ? fallback : ctx.services.subconscious.toolTimeout?.({ ...clean, agent: ctx.agent, signal: stop }) ?? fallback);
    const answer = await Promise.race([work, ended]);
    const valid = answer.action === 'abort' || (answer.action === 'wait' && Number.isInteger(answer.seconds) && answer.seconds! >= 1 && answer.seconds! <= MAX_TIMEOUT_SECONDS);
    const decision = valid ? { ...answer, reason: redact(answer.reason || 'Timeout reviewed.').slice(0, 500) } : fallback;
    if (!signal.aborted && !ctx.signal.aborted) {
      try {
        ctx.services.runs.item(ctx.runId, { kind: 'note', name: 'tool.timeout', effectStatus: 'none', data: { callId: ctx.callId, toolTimeout: { tool: input.tool, elapsedSeconds: input.elapsedSeconds, timeoutSeconds: input.timeoutSeconds, decision }, summary: preview(ctx.services.secrets, timeoutDecisionText(input, decision), 400) } });
      } catch { /* the result also travels with the tool output */ }
    }
    return decision;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    if (cancel) stop.removeEventListener('abort', cancel);
    controller.abort();
  }
}
