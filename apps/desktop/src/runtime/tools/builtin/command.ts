// The command runner of shell.exec (files.ts): one shell command on this PC in a
// folder the caller resolved, with adaptive timeout reviews, an output cap and the run's abort. B-080: the shell is
// the caller's ShellSpawn – files.ts defaultShell: PowerShell on Windows (7 where found, else 5.1), sh on macOS and Linux.
// B-080 wave 3: output is decoded as UTF-8 per stream across reads, and each timeout review learns how many characters
// the command printed since the review before (newOutputChars) – the one fact between a working call and a hung one.
// B-044: `env` adds variables; a value may hold secret://<id> handles, resolved at spawn by the vault
// (secrets/handles.ts – owner 29.10.2026: every stored secret works in a command, any length – card data, CVCs and
// 2FA codes included). The output has each value the command received masked by its handle (its raw and encoded
// forms, any length – a short value that shows withholds the whole output; handles.ts maskValues), then passes the
// leak redactor like every tool output (tools/outputs.ts).
// B-072: the command starts in the engines' env (engines/wf-shim.ts agentEnv): `wf` is the app's client first on
// PATH (on Windows never system32's WF.msc) and AUTARK_DATA names this data folder; B-080: Codex's rg last on PATH
// (Windows) and PYTHONUTF8=1 come from the same env. B-085: AUTARK_AGENT = the calling agent (its `wf` writes as it),
// never for a linked PC's call (that agent is not one of this runtime's).
// Owns: the env checks, the spawn, the collection and the exit text. Never: logs the env or a value.

import { StringDecoder } from 'node:string_decoder';
import type { ToolContext, ToolOutput } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { agentEnv, asAgent } from '../../engines/wf-shim.ts';
import { ENV_NAME, MAX_ENV, handlesIn, judgeHandles, resolveMasked, withHandles } from '../../secrets/handles.ts';
import type { ActionDescription } from '../types.ts';
import type { ShellSpawn } from './files.ts';
import { commandCapNote, initialTimeoutSeconds, MAX_COMMAND_SECONDS, reviewToolTimeout, timeoutDecisionText } from '../timeout.ts';

import { maskKeyShapes } from '../../secrets/redact.ts';
import { ShellOutput, WITHHELD } from './shell-output.ts';

/** The `env` argument of a command tool. */
export const ENV_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: { type: 'string', maxLength: 8000 },
  description: `Up to ${MAX_ENV} variables; a value can hold "secret://<id>" (e.g. "Bearer secret://<id>"), replaced only as the command starts – the value never reaches me and output showing it is masked. On Windows the command reads it as $env:NAME.`,
});

/** The env as given, checked (names, count); throws bad_request. */
export function checkEnv(env: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(env ?? {});
  if (entries.length > MAX_ENV) throw new WorkforceError('bad_request', `At most ${MAX_ENV} environment variables.`);
  for (const [name] of entries) if (!ENV_NAME.test(name)) throw new WorkforceError('bad_request', `"${name.slice(0, 40)}" is not an environment variable name (letters, digits, "_").`);
  return Object.fromEntries(entries);
}

/** A command call's action with its env secrets (the 'secret' category); a secret the env cannot take throws. */
export function commandAction(ctx: ToolContext, action: ActionDescription, env: Record<string, string> | undefined): ActionDescription {
  const ids = handlesIn(Object.values(checkEnv(env)));
  if (!ids.length) return action;
  const judged = judgeHandles(ctx, ids);
  if ('problem' in judged) throw new WorkforceError('forbidden', judged.problem);
  return withHandles(action, judged, 'in its environment', true);
}

export async function runCommand(shell: ShellSpawn, ctx: ToolContext, input: { command: string; cwd: string; timeoutSeconds?: number; env?: Record<string, string> }): Promise<ToolOutput> {
  const { values: extra, mask } = await resolveMasked(ctx, checkEnv(input.env)); // at spawn, never earlier
  if (ctx.signal.aborted) return { content: [{ type: 'text', text: 'Stopped before the command started.' }], isError: true };
  const controller = new AbortController();
  let review: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let timedOut = false;
  let finish: (code: number | null) => void = () => {};
  const abort = () => { if (!done) { controller.abort(); finish(null); } };
  const started = Date.now();
  const decisions: string[] = [];
  let reviews = 0;
  const tool = 'shell.exec';
  let seconds = Math.min(initialTimeoutSeconds(tool, input), MAX_COMMAND_SECONDS);
  const streams = [new ShellOutput(), new ShellOutput()];
  const redact = (value: string) => maskKeyShapes(ctx.services.secrets.redact(mask(value)));
  let printed = 0;
  let looked = 0;
  let lookedAt = started;
  const take = (index: number, text: string) => {
    printed += text.length;
    streams[index].append(text); // bounded per pipe: whole up to its half of MAX_CAPTURE, beyond it start and end (shell-output.ts)
  };
  // Separate pipes: interleaved stderr must not split a match in stdout (or vice versa).
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  const collect = (index: number) => (chunk: Buffer | string) => take(index, typeof chunk === 'string' ? chunk : decoders[index].write(chunk));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      finish = (exitCode) => {
        if (done) return;
        done = true;
        review?.abort();
        resolve(exitCode);
      };
      const data = ctx.services.paths?.data;
      const agent = ctx.fromPc ? undefined : ctx.agent?.id; // B-085: a linked PC's agent is no agent of this runtime
      const child = shell(input.command, { cwd: input.cwd, signal: controller.signal, env: { ...(data ? agentEnv(data, { agent }) : asAgent(process.env, agent)), ...extra } });
      child.stdout?.on('data', collect(0));
      child.stderr?.on('data', collect(1));
      child.stdout?.on('error', abort);
      child.stderr?.on('error', abort);
      child.on('error', () => { if (controller.signal.aborted) finish(null); else { done = true; review?.abort(); reject(new Error('Could not run the command.')); } });
      child.on('close', finish);
      const timeout = async () => {
        if (done || ctx.signal.aborted) return;
        const now = Date.now();
        // Total limit first: no review can extend a call past it (feedback 0B998EAF – 'wait 15 s' answered for 17,329 s).
        if (now - started >= MAX_COMMAND_SECONDS * 1000) { timedOut = true; decisions.push(commandCapNote((now - started) / 1000)); ctx.status('Command ended at its total limit'); abort(); return; }
        review = new AbortController();
        ctx.status('Reviewing command timeout');
        const observation = { tool, args: { command: '[command arguments withheld during execution]' }, elapsedSeconds: Math.round((now - started) / 1000), timeoutSeconds: seconds, output: '', newOutputChars: printed - looked, secondsSinceLastLook: Math.round((now - lookedAt) / 1000) };
        looked = printed;
        lookedAt = now;
        const decision = await reviewToolTimeout(ctx, observation, review.signal);
        if (done || ctx.signal.aborted) return;
        decisions.push(timeoutDecisionText(observation, decision));
        reviews++;
        if (decisions.length > 20) decisions.shift();
        ctx.status(decisions.at(-1)!.slice(0, 140));
        if (decision.action === 'wait') { seconds = Math.max(1, Math.min(decision.seconds!, Math.ceil((started + MAX_COMMAND_SECONDS * 1000 - Date.now()) / 1000))); timer = setTimeout(() => { void timeout(); }, seconds * 1000); }
        else { timedOut = true; abort(); }
      };
      ctx.signal.addEventListener('abort', abort, { once: true });
      if (ctx.signal.aborted) abort();
      else timer = setTimeout(() => { void timeout(); }, seconds * 1000);
    });
    decoders.forEach((decoder, index) => take(index, decoder.end()));
    const completed = code !== null && !controller.signal.aborted;
    const parts = streams.map((stream) => stream.safe(completed, redact));
    const body = parts.some((part) => part === null) ? WITHHELD : ShellOutput.cap(parts.filter(Boolean).join('\n'));
    const earlier = reviews > decisions.length ? [`${reviews - decisions.length} earlier timeout decisions are recorded in the run journal.`] : [];
    return { content: [{ type: 'text', text: [...earlier, ...decisions, `exit ${timedOut ? 'timeout' : code ?? 'killed'}\n${body}`].join('\n') }], isError: timedOut || code !== 0 };
  } catch {
    return { content: [{ type: 'text', text: 'Could not run the command.' }], isError: true };
  } finally {
    clearTimeout(timer);
    review?.abort();
    ctx.signal.removeEventListener('abort', abort);
  }
}
