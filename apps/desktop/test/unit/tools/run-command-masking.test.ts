// 0.3.19, the masked engine shell (tools/builtin/command.ts runCommand – what shell.exec runs for Claude's and Codex's
// agent threads now that their native shells are off): each pipe is masked whole – catalog values (secrets.redact) and
// key shapes (maskKeyShapes) – before the streams are joined or capped; a timeout review sees counts, never output; an
// overflow, abort, pipe error or failing redactor withholds the output; a spawn error carries no raw text. Ported from the
// reviewed draft's fixture tests (fixture-tests/run-command.test.mjs), unchanged in substance.
// Owns: these assertions only. Never: a real key – the values below are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runCommand } from '../../../src/runtime/tools/builtin/command.ts';
import { Redactor } from '../../../src/runtime/secrets/redact.ts';
import type { ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { ToolTimeoutDecision } from '../../../src/runtime/tools/timeout.ts';

const catalog = 'synthetic-catalog-fixture-9ACD7';
const stripe = 'sk_live_' + 'd3adb33f'.repeat(6);

type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
type Review = (input: { output: string; newOutputChars?: number }) => ToolTimeoutDecision | Promise<ToolTimeoutDecision>;

function fixture(action: (child: Child, control: AbortController) => void, review?: Review, redactFailure = false) {
  const controller = new AbortController();
  const redactor = new Redactor();
  redactor.set('fixture', catalog);
  const ctx = {
    signal: controller.signal, agent: { id: 'fixture-agent' }, status() {},
    services: {
      runs: { item() {} }, subconscious: { toolTimeout: review },
      secrets: {
        list: () => [{ id: 'fixture' }], use: async () => catalog,
        redact: (text: string) => { if (redactFailure) throw new Error('redactor unavailable'); return redactor.redact(text); },
      },
    },
  } as unknown as ToolContext;
  const shell: ShellSpawn = (_command, options) => {
    assert.equal(options.env?.FIXTURE, catalog, 'the handle resolves into the env only');
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => action(child, controller));
    return child as unknown as ReturnType<ShellSpawn>;
  };
  return runCommand(shell, ctx, { command: 'fixture', cwd: '.', timeoutSeconds: 1, env: { FIXTURE: 'secret://fixture' } });
}
const out = (child: Child, name: 'stdout' | 'stderr', value: string | Buffer) => child[name].emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value));
const text = (result: Awaited<ReturnType<typeof runCommand>>) => result.content[0].type === 'text' ? result.content[0].text : '';

test('complete streams are masked before interleaving or the visible cap, even on a nonzero exit', async () => {
  const r = await fixture((c) => {
    const bytes = Buffer.from('Vörne ' + catalog);
    out(c, 'stdout', bytes.subarray(0, 2));
    out(c, 'stdout', bytes.subarray(2, -8));
    out(c, 'stderr', 'ERR ' + stripe);
    out(c, 'stdout', bytes.subarray(-8));
    out(c, 'stdout', ' ende');
    c.emit('close', 5);
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /^exit 5\nVörne secret:\/\/fixture ende\nERR ‹secret:stripe-[^›]+›$/);
});

test('a catalog value crossing the visible cap is masked before the cap', async () => {
  const r = await fixture((c) => {
    out(c, 'stdout', 'x'.repeat(65524) + ' ' + catalog.slice(0, 16));
    out(c, 'stdout', catalog.slice(16));
    c.emit('close', 0);
  });
  assert.ok(!text(r).includes('synthetic-catalog'), 'no raw prefix');
  assert.match(text(r), /\[output capped\] …\nx+ secret:\/\/fixture$/);
});

test('a timeout review sees counts, never incomplete output', async () => {
  let seen: { output: string; newOutputChars?: number } | undefined;
  const r = await fixture((c) => out(c, 'stdout', stripe.slice(0, -12)), (input) => { seen = input; return { action: 'abort', reason: 'Fixture stop.' }; });
  assert.equal(seen?.output, '');
  assert.ok((seen?.newOutputChars ?? 0) > 0);
  assert.match(text(r), /exit timeout\n\[command output withheld\]/);
});

test('cancellation and a failing redactor expose no partial output', async () => {
  for (const kind of ['abort', 'maskFailure']) {
    const r = await fixture((c, control) => {
      out(c, 'stdout', 'safe text ' + stripe.slice(0, -12));
      if (kind === 'abort') control.abort();
      c.emit('close', 0);
    }, undefined, kind === 'maskFailure');
    assert.match(text(r), /\[command output withheld\]/, kind);
    assert.ok(!text(r).includes('safe text'), kind);
  }
});

test('a spawn error carries no raw value in its text', async () => {
  const r = await fixture((c) => c.emit('error', new Error(stripe)));
  assert.equal(r.isError, true);
  assert.equal(text(r), 'Could not run the command.');
});

// 0.3.19 (Noah's review 24.11.2026): an output over budget keeps each pipe's start and end, masked – no longer all withheld.
test('an overflow keeps start and end of each pipe, masked; the visible text stays capped', async () => {
  const r = await fixture((c) => {
    out(c, 'stdout', 'safe text ' + stripe + '\n' + 'A'.repeat(600 * 1024));
    out(c, 'stderr', 'B'.repeat(600 * 1024) + '\nERR ' + catalog);
    c.emit('close', 1);
  });
  const shown = text(r);
  assert.equal(r.isError, true);
  assert.match(shown, /^exit 1\nsafe text ‹secret:stripe-[^›]+›\nA+/, 'the start, masked');
  assert.match(shown, /B+\nERR secret:\/\/fixture$/, 'the end with the error, masked');
  assert.match(shown, /\[output capped\]/);
  assert.ok(!shown.includes(catalog) && !shown.includes(stripe.slice(8, 24)), 'no raw value');
  assert.ok(shown.length < 70 * 1024);
});

test('a pipe error aborts the process and suppresses both streams', async () => {
  const r = await fixture((c) => {
    out(c, 'stdout', 'prefix');
    c.stderr.emit('error', new Error(stripe));
    out(c, 'stdout', 'late');
    c.emit('close', 0);
  });
  assert.equal(r.isError, true);
  assert.equal(text(r), 'exit killed\n[command output withheld]');
});
