// Adaptive shell deadlines, cancellation races and process-tree termination; B-080 wave 3: what the command printed
// since the last review (newOutputChars) and UTF-8 decoded across reads. The subconscious's choice itself:
// test/unit/subconscious/tool-timeout.test.ts.
// 0.3.19 (the masked engine shell, tools/builtin/shell-output.ts): output that may end mid-value never leaves the process –
// a review sees the counts only (newOutputChars, secondsSinceLastLook), never the output or the command, and a command that
// timed out, was aborted or overflowed returns "[command output withheld]" instead of its partial output. The three tests
// below that asserted the masked partial output assert that now; the masking of complete output: shell-output.test.ts.
// Owns: these assertions only. Never: runs an install or contacts a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { runCommand } from '../../../src/runtime/tools/builtin/command.ts';
import { defaultShell, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import { initialTimeoutSeconds, NO_DECISION, reviewToolTimeout, TIMEOUT_REVIEW_MS, type ToolTimeoutDecision } from '../../../src/runtime/tools/timeout.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(review?: RuntimeServices['subconscious']['toolTimeout']) {
  const stop = new AbortController();
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: null, kill: () => true });
  let spawned = 0;
  let commandSignal: AbortSignal | undefined;
  const notes: unknown[] = [];
  const shell: ShellSpawn = (_command, options) => { spawned++; commandSignal = options.signal; return child as unknown as ReturnType<ShellSpawn>; };
  const ctx = {
    agent: { id: 'ag_a', name: 'Ada' }, runId: 'r1', mode: 'coding', signal: stop.signal, status() {},
    services: { secrets: { redact: (text: string) => text.replaceAll('sensitive-value', 'secret://s1') }, subconscious: { toolTimeout: review }, runs: { item: (_id: string, item: unknown) => notes.push(item) } },
  } as unknown as ToolContext;
  return { shell, ctx, child, stdout, stop, notes, spawned: () => spawned, commandSignal: () => commandSignal };
}

test('initial estimates distinguish actual commands and explicit review intervals', () => {
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm install' }), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm ci' }), 300);
  assert.equal(initialTimeoutSeconds('shell', 'npm install'), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'python -m pip install requests' }), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'git clone https://example.com/repo' }), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm run test' }), 180);
  assert.equal(initialTimeoutSeconds('shell', { command: 'rg install src' }), 15);
  assert.equal(initialTimeoutSeconds('shell', { command: 'rg "npm install" src' }), 15);
  assert.equal(initialTimeoutSeconds('Grep', { pattern: 'npm install' }), 15);
  assert.equal(initialTimeoutSeconds('shell', { command: 'something', timeoutSeconds: 27 }), 27);
  assert.equal(initialTimeoutSeconds('shell', { command: ['npm', 'install'] }), 300);
});

test('B-080: the call\'s own limit comes first, in each form the engines send it (live 07.11.: 66 calls with their own timeout were reviewed at 60 s)', () => {
  assert.equal(initialTimeoutSeconds('Bash', { command: 'python x.py', timeout: 600000 }), 600, 'Claude Code Bash/PowerShell: ms');
  assert.equal(initialTimeoutSeconds('PowerShell', { command: 'python x.py', timeout: 120000 }), 120, 'Claude Code PowerShell: ms');
  assert.equal(initialTimeoutSeconds('TaskOutput', { task_id: 'b1', timeout: 30000 }), 30, 'Claude Code TaskOutput: ms');
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm test', timeout: 60 }), 60, 'an ACP shell (Kimi Code): seconds');
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm test', timeout: 300 }), 300, 'an ACP shell: 300 s stays 300 s, not 1 s');
  assert.equal(initialTimeoutSeconds('shell', { command: 'python x.py', timeout_ms: 90000 }), 90, 'Codex shell: ms');
  assert.equal(initialTimeoutSeconds('shell.exec', { command: 'python x.py', timeoutSeconds: 30 }), 30);
  assert.equal(initialTimeoutSeconds('Bash', { command: 'sleep 100', timeout: 100500 }), 101, 'whole seconds, rounded up');
  assert.equal(initialTimeoutSeconds('Bash', { command: 'make', timeout: 7_200_000 }), 1800, 'at most MAX_TIMEOUT_SECONDS');
  assert.equal(initialTimeoutSeconds('shell', { command: 'rg x' }), 15);
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm install' }), 300);
  assert.equal(initialTimeoutSeconds('Bash', { command: 'npm install', timeout: 0 }), 300, 'no usable own limit: the estimate by kind');
});

test('wait twice then abort: one process, chosen deadlines and decisions reach main AI; the partial output is withheld (0.3.19)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen: unknown[] = [];
  const replies: ToolTimeoutDecision[] = [{ action: 'wait', seconds: 2, reason: 'Still working' }, { action: 'wait', seconds: 3, reason: 'Almost done' }, { action: 'abort', reason: 'No progress' }];
  const f = fixture(async (input) => { seen.push(input); return replies.shift()!; });
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush();
  f.stdout.emit('data', 'partial sensitive-value');
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.commandSignal()?.aborted, false);
  t.mock.timers.tick(1999); await flush(); assert.equal(seen.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(seen.length, 2);
  t.mock.timers.tick(3000); await flush();
  const result = await pending;
  const text = result.content[0].type === 'text' ? result.content[0].text : '';
  assert.equal(f.spawned(), 1);
  assert.equal(f.commandSignal()?.aborted, true);
  assert.equal(result.isError, true);
  assert.match(text, /wait another 2 seconds[\s\S]*wait another 3 seconds[\s\S]*abort the running call[\s\S]*exit timeout\n\[command output withheld\]$/);
  assert.equal(text.includes('partial'), false, 'a stopped command may have stopped mid-value: nothing of it');
  assert.equal(JSON.stringify(seen).includes('sensitive-value'), false);
  assert.equal(JSON.stringify(seen).includes('partial'), false);
  assert.equal(f.notes.length, 3);
});

test('0.3.19: a review sees how much was printed, never the output (it may end mid-value) nor the command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let output = 'unset';
  let printed: number | undefined;
  let args: unknown;
  const f = fixture(async (input) => { output = input.output; printed = input.newOutputChars; args = input.args; return { action: 'abort', reason: 'Done checking' }; });
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush();
  f.stdout.emit('data', 'old '.repeat(40_000));
  f.stdout.emit('data', 'new progress sensitive-value');
  t.mock.timers.tick(1000); await flush();
  await pending;
  assert.equal(output, '');
  assert.equal(printed, 'old '.length * 40_000 + 'new progress sensitive-value'.length, 'the count goes on past the result cap');
  assert.equal(JSON.stringify(args).includes('slow'), false);
});

test('a command finishing while review waits cancels review and ignores its late abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: ToolTimeoutDecision) => void;
  let reviewSignal: AbortSignal | undefined;
  const f = fixture((input) => { reviewSignal = input.signal; return new Promise((resolve) => { answer = resolve; }); });
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush(); t.mock.timers.tick(1000); await flush();
  f.stdout.emit('data', 'done'); f.child.emit('close', 0);
  const result = await pending;
  answer({ action: 'abort', reason: 'Late answer' }); await flush();
  assert.equal(reviewSignal?.aborted, true);
  assert.equal(result.isError, false);
  assert.equal(f.commandSignal()?.aborted, false);
  assert.equal(f.notes.length, 0);
});

test('parent abort releases a command even when its fake process and review ignore cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {}));
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush(); t.mock.timers.tick(1000); await flush(); f.stop.abort();
  assert.equal((await pending).isError, true);
  assert.equal(f.commandSignal()?.aborted, true);
  const stopped = await runCommand(f.shell, f.ctx, { command: 'never', cwd: '.' });
  assert.equal(stopped.isError, true); assert.equal(f.spawned(), 1);
});

test('B-080: a stuck subconscious review has its own deadline, and the call keeps running for the same time again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {}));
  const pending = reviewToolTimeout(f.ctx, { tool: 'shell', args: {}, elapsedSeconds: 15, timeoutSeconds: 15, output: '' });
  await flush(); t.mock.timers.tick(TIMEOUT_REVIEW_MS); await flush();
  assert.deepEqual(await pending, { action: 'wait', seconds: 15, reason: NO_DECISION });
  const none = fixture(undefined);
  assert.deepEqual(await reviewToolTimeout(none.ctx, { tool: 'shell', args: {}, elapsedSeconds: 60, timeoutSeconds: 60, output: '' }), { action: 'wait', seconds: 60, reason: NO_DECISION }, 'no subconscious: no stop either');
});

// B-080 wave 3 (live 08.–09.11.2026: a scan still printing paths was aborted – the review saw only the last 6000
// characters, never whether anything came since its last look): each review learns what the command printed since then.
test('B-080 wave 3: each review gets newOutputChars since the review before – printing gives > 0, silence 0; secrets stay masked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen: Array<{ newOutputChars?: number; output: string }> = [];
  const replies: ToolTimeoutDecision[] = [{ action: 'wait', seconds: 2, reason: 'working' }, { action: 'wait', seconds: 2, reason: 'working' }, { action: 'abort', reason: 'hangs' }];
  const f = fixture(async (input) => { seen.push({ newOutputChars: input.newOutputChars, output: input.output }); return replies.shift()!; });
  const pending = runCommand(f.shell, f.ctx, { command: 'scan', cwd: '.', timeoutSeconds: 1 });
  await flush();
  f.stdout.emit('data', 'abc');
  t.mock.timers.tick(1000); await flush();
  f.stdout.emit('data', 'path sensitive-value');
  t.mock.timers.tick(2000); await flush();
  t.mock.timers.tick(2000); await flush();
  const result = await pending;
  assert.deepEqual(seen.map((input) => input.newOutputChars), [3, 20, 0], 'since the start, then since each look');
  assert.ok(seen.every((input) => !input.output.includes('sensitive-value')), 'the review sees the handle, not the value');
  assert.ok(seen.every((input) => input.output === ''), '0.3.19: the counts only, never output that may end mid-value');
  assert.equal(f.commandSignal()?.aborted, true, 'a sure abort kills the command');
  assert.equal(result.isError, true);
});

// B-080 wave 3 review (the next wait starts only after a review, which can take up to TIMEOUT_REVIEW_MS): the seconds a
// review names and the characters it counts cover the same span – from the last observation on.
test('B-080 wave 3 review: secondsSinceLastLook spans the same time as newOutputChars, a slow review included', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen: Array<{ secondsSinceLastLook?: number; timeoutSeconds: number; newOutputChars?: number }> = [];
  const replies: ToolTimeoutDecision[] = [{ action: 'wait', seconds: 2, reason: 'working' }, { action: 'abort', reason: 'hangs' }];
  let release: (() => void) | undefined;
  const f = fixture(async (input) => {
    seen.push({ secondsSinceLastLook: input.secondsSinceLastLook, timeoutSeconds: input.timeoutSeconds, newOutputChars: input.newOutputChars });
    if (seen.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return replies.shift()!;
  });
  const pending = runCommand(f.shell, f.ctx, { command: 'scan', cwd: '.', timeoutSeconds: 1 });
  await flush();
  t.mock.timers.tick(1000); await flush();
  f.stdout.emit('data', 'during the review');
  t.mock.timers.tick(5000); // the first review takes 5 s
  release!(); await flush(); await flush();
  t.mock.timers.tick(2000); await flush();
  await pending;
  assert.deepEqual(seen, [
    { secondsSinceLastLook: 1, timeoutSeconds: 1, newOutputChars: 0 },
    { secondsSinceLastLook: 7, timeoutSeconds: 2, newOutputChars: 17 },
  ], 'the 5 s of the review and what came during it are both in the second look');
});

test('B-080 wave 3: no decision keeps the command running and it is looked at again after the same time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reviews = 0;
  const f = fixture(async () => { reviews++; throw new Error('backend down'); });
  const pending = runCommand(f.shell, f.ctx, { command: 'scan', cwd: '.', timeoutSeconds: 1 });
  await flush();
  t.mock.timers.tick(1000); await flush();
  assert.equal(reviews, 1);
  assert.equal(f.commandSignal()?.aborted, false, 'still running');
  t.mock.timers.tick(1000); await flush();
  assert.equal(reviews, 2, 'the same wait again');
  f.stdout.emit('data', 'done'); f.child.emit('close', 0);
  const result = await pending;
  const text = result.content[0].type === 'text' ? result.content[0].text : '';
  assert.equal(result.isError, false);
  assert.ok(text.includes(NO_DECISION) && text.endsWith('exit 0\ndone'), text);
});

// 0.3.20 (feedback 0B998EAF, live 17.11.2026: a command that left a dev server holding its pipes lived 17,329 s because every
// review answered "wait another 15 s"): the call's total lifetime is capped, whatever the reviews say.
test('0.3.20: endless "wait another 15 s" answers end at the total limit; the process tree is stopped and the output stays withheld', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reviews = 0;
  const f = fixture(async () => { reviews++; return { action: 'wait', seconds: 15, reason: 'HTTP 200 seen, still running' }; });
  let settled = false;
  const pending = runCommand(f.shell, f.ctx, { command: 'next dev', cwd: '.', timeoutSeconds: 15 }).then((value) => { settled = true; return value; });
  await flush();
  f.stdout.emit('data', 'ready - sensitive-value on http://localhost:3000');
  // Simulate the incident's span (4.8 h) second by second of review rounds; the cap must have ended it long before.
  for (let second = 0; second < 17_400 && !settled; second += 15) { t.mock.timers.tick(15_000); await flush(); }
  assert.equal(settled, true, 'the command ended instead of waiting for ever');
  const result = await pending;
  const text = result.content[0].type === 'text' ? result.content[0].text : '';
  assert.equal(f.commandSignal()?.aborted, true, 'the abort reaches the shell spawn – defaultShell kills that child\'s tree by PID');
  assert.equal(result.isError, true);
  assert.ok(reviews <= 3600 / 15, `bounded reviews: ${reviews}`);
  assert.match(text, /total limit of 3600 s[\s\S]*process tree[\s\S]*exit timeout\n\[command output withheld\]$/);
  assert.equal(text.includes('sensitive-value'), false);
  assert.equal(text.includes('localhost'), false, 'masking guarantee: nothing of a stopped command\'s output');
});

test('0.3.20: a long wait is clamped so the total never passes the limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const waits: number[] = [];
  const f = fixture(async (input) => { waits.push(input.timeoutSeconds); return { action: 'wait', seconds: 1800, reason: 'long job' }; });
  let settled = false;
  const pending = runCommand(f.shell, f.ctx, { command: 'build', cwd: '.', timeoutSeconds: 1500 }).then((value) => { settled = true; return value; });
  await flush();
  t.mock.timers.tick(1500_000); await flush(); // review 1 -> wait 1800 (3300 s total)
  t.mock.timers.tick(1800_000); await flush(); // review 2 -> clamped wait of 300 s
  assert.equal(settled, false);
  t.mock.timers.tick(300_000); await flush();
  assert.equal(settled, true);
  assert.deepEqual(waits, [1500, 1800], 'no third review: the cap ends it');
  assert.equal(f.commandSignal()?.aborted, true);
  const first = (await pending).content[0];
  assert.match(first.type === 'text' ? first.text : '', /total limit of 3600 s \(3600 s elapsed/);
});

// B-080 wave 3 (live: command.ts decoded each read on its own – a letter split across two reads became two U+FFFD).
test('B-080 wave 3: a UTF-8 letter split across two reads stays whole', async () => {
  const f = fixture(undefined);
  const pending = runCommand(f.shell, f.ctx, { command: 'print', cwd: '.', timeoutSeconds: 60 });
  await flush();
  f.stdout.emit('data', Buffer.from('Gr'));
  f.stdout.emit('data', Buffer.from([0xC3]));
  f.stdout.emit('data', Buffer.from([0xBC, 0xC3]));
  f.stdout.emit('data', Buffer.from([0x9F, 0x65]));
  f.child.emit('close', 0);
  const result = await pending;
  assert.equal(result.content[0].type === 'text' ? result.content[0].text : '', 'exit 0\nGrüße');
});

test('default shell abort closes the real shell and its long-running descendant', { timeout: 30_000 }, async () => {
  const stop = new AbortController();
  const child = defaultShell('node -e "process.stdout.write(\'ready\'); setInterval(() => {}, 1000)"', { cwd: process.cwd(), signal: stop.signal });
  const closed = once(child as unknown as EventEmitter, 'close');
  try {
    await once(child.stdout! as EventEmitter, 'data', { signal: AbortSignal.timeout(20_000) });
    stop.abort();
    await closed;
  } finally { stop.abort(); }
});
