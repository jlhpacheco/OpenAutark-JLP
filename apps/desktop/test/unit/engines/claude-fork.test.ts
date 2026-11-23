// B-057 C – the Claude Code native fork of a split over a scripted CLI: fork() reserves a new session id and the first
// turn on it resumes the parent with `--resume <parent> --fork-session --session-id <new>` (the split's identity in the
// user message as the <live> block); the next turn resumes the new id alone. The parent resumes by its id in
// the folder its turns ran in, else by the absolute path of the CLI's transcript (found by folder names in the account
// home); a project: parent keeps the app home's project folder (and its ref prefix); a transcript path as it is; a
// parent whose transcript is gone is not forked (the split falls back). A turn that never reached the CLI keeps the
// fork pending; one the CLI answered (also with an error) ends it; deleting its ref drops it.
// Owns: nothing in production. Never starts a real binary or touches a real home (in-memory files, fake paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ClaudeEngine } from '../../../src/runtime/engines/claude/engine.ts';
import type { EngineForkInput } from '../../../src/runtime/engines/types.ts';
import { BASE_ENV, TEMP, claudeAccount, claudeCli } from './claude-fixture.ts';
import { fakeFinder, fakeSpawn, memoryFiles, testSupervisor, turnInput } from './fakes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valueAfter = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const resumeArgs = (args: string[]) => args.slice(args.indexOf('--resume'));

interface Script { transcripts?: Record<string, number>; folders?: Record<string, string[]>; quiet?: { value: boolean }; failing?: { value: boolean } }

function setup(script: Script = {}) {
  const cli = claudeCli({
    refuse: () => script.quiet?.value === true,
    // A real CLI with --fork-session --session-id reports the new id (its result line names it).
    turn: (call, session) => {
      const id = call.args.includes('--fork-session') ? valueAfter(call.args, '--session-id')! : session;
      return script.failing?.value
        ? [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500', session_id: id }]
        : [{ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: id }];
    },
  });
  const memory = memoryFiles();
  const files = {
    ...memory.files,
    size: async (file: string) => script.transcripts?.[file] ?? memory.written.get(file)?.length,
    rm: async (file: string) => { memory.written.delete(file); await memory.files.rm(file); },
    folders: async (dir: string) => script.folders?.[dir] ?? [],
    rmDir: async () => {},
  };
  let n = 0;
  const version = fakeSpawn(({ child }) => {
    setImmediate(() => { child.stdout.write('2.1.329 (Claude Code)\n'); child.exit(0); });
  });
  const engine = new ClaudeEngine({
    supervisor: testSupervisor((command, args, options) => (args.includes('--version') ? version : cli).spawn(command, args, options)), finder: fakeFinder({ claude: '/fake-bin/claude' }), tempDir: TEMP, files, env: BASE_ENV,
    accountsRoots: ['/fake-homes/claude'],
    now: () => 1_800_000_000_000, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { engine, cli, removeFile: files.rm, last: () => cli.of('turn').at(-1)! };
}

const acc = claudeAccount();
const forkInput = (parentRef: string, patch: Partial<EngineForkInput> = {}): EngineForkInput => ({ runId: 'run_w1', agentId: 'ag_1', account: acc, parentRef, cwd: '/work', model: 'claude-sonnet-5-5', ...patch });
const turn = (patch: Record<string, unknown>) => turnInput({ account: acc, model: 'claude-sonnet-5-5', cwd: '/work', ...patch }).input;
const PROJECTS = path.join(acc.home, 'projects');
const rebuild = (engine: ClaudeEngine, tier: 'project' | 'path') => engine.rebuild({
  runId: 'run_rebuild', agentId: 'ag_1', account: acc, cwd: '/work', model: 'claude-sonnet-5-5',
  items: [{ itemId: 'm1', kind: 'm', role: 'user', text: 'A safe prior message.' }],
  tools: [], toolNames: [], system: { stable: '', volatile: '' },
  generation: 2, probe: { ok: true, version: '2.1.329', at: 0, tier },
});
/** A CLI transcript of `id` in the account home's project folder of /work. */
const cliTranscript = (id: string) => path.join(PROJECTS, 'C--work', `${id}.jsonl`);

test('claude says it can fork', () => {
  assert.equal(setup().engine.caps.fork, true);
});

test('same folder: the first turn resumes the parent with --fork-session and the new id; the second resumes the fork alone', async () => {
  const transcripts: Record<string, number> = {};
  const { engine, last } = setup({ transcripts, folders: { [PROJECTS]: ['C--work'] } });
  const parent = await engine.run(turn({ runId: 'run_p1' }));
  const parentRef = parent.session!.ref;
  assert.match(parentRef, UUID);
  transcripts[cliTranscript(parentRef)] = 100;

  const forked = await engine.fork(forkInput(parentRef));
  assert.match(forked.ref, UUID);
  assert.notEqual(forked.ref, parentRef);
  assert.equal(forked.generation, 1);

  const first = await engine.run(turn({ runId: 'run_w1', session: { ref: forked.ref, generation: 1 }, system: { stable: 'STABLE', volatile: 'You are split #2 of 3.' }, input: [{ type: 'text', text: 'Your part: count the files.' }] }));
  assert.equal(first.stop, 'done');
  assert.deepEqual(resumeArgs(last().args), ['--resume', parentRef, '--fork-session', '--session-id', forked.ref]);
  assert.equal(first.session?.ref, forked.ref, 'the fork is its own session');
  const user = last().child.lines.find((line: any) => line?.type === 'user') as any;
  assert.equal(user.message.content[0].text, '<live>\nYou are split #2 of 3.\n</live>', 'the identity travels in the user message');
  assert.equal(user.message.content[1].text, 'Your part: count the files.');

  const second = await engine.run(turn({ runId: 'run_w2', session: { ref: forked.ref, generation: 1 } }));
  assert.equal(second.stop, 'done');
  assert.deepEqual(resumeArgs(last().args), ['--resume', forked.ref], 'no second fork (the CLI would refuse the id as in use)');

  await engine.run(turn({ runId: 'run_p2', session: { ref: parentRef, generation: 1 } }));
  assert.deepEqual(resumeArgs(last().args), ['--resume', parentRef], "the parent's own turns are unchanged");
});

test("another folder (a worktree): the parent resumes from the absolute path of the CLI's transcript; not found: the fork throws", async () => {
  const transcripts: Record<string, number> = {};
  const folders = { [PROJECTS]: ['C--elsewhere', 'C--work'] };
  const { engine, last } = setup({ transcripts, folders });
  const parentRef = (await engine.run(turn({ runId: 'run_p1' }))).session!.ref;
  const file = path.join(PROJECTS, 'C--work', `${parentRef}.jsonl`);
  transcripts[file] = 2048;

  const forked = await engine.fork(forkInput(parentRef, { cwd: '/work/.worktrees/wf-split-1' }));
  await engine.run(turn({ runId: 'run_w1', cwd: '/work/.worktrees/wf-split-1', session: { ref: forked.ref, generation: 1 } }));
  assert.deepEqual(resumeArgs(last().args), ['--resume', file, '--fork-session', '--session-id', forked.ref]);

  delete transcripts[file];
  await assert.rejects(engine.fork(forkInput(parentRef, { cwd: '/work/.worktrees/wf-split-2' })), /not found/);
});

test('a transcript existing after a restart is not enough to fork or resume it', async () => {
  const parentRef = '00000000-0000-4000-8000-000000000999';
  const file = cliTranscript(parentRef);
  const { engine, cli } = setup({ transcripts: { [file]: 10 }, folders: { [PROJECTS]: ['C--work'] } });
  await assert.rejects(engine.fork(forkInput(parentRef)), /rebuilt from the filtered Autark history/);
  const resume = await engine.run(turn({ session: { ref: parentRef, generation: 1 } }));
  assert.equal(resume.error?.details?.rebase, true);
  assert.equal(cli.calls.length, 0);
});

test("a project: parent forks inside the app home's project folder; the fork keeps the prefix and its env", async () => {
  const { engine, last } = setup();
  const parent = await rebuild(engine, 'project');
  assert.match(parent.ref, /^project:/);
  const parentId = parent.ref.slice('project:'.length);
  const forked = await engine.fork(forkInput(parent.ref));
  assert.match(forked.ref, /^project:/);
  const id = forked.ref.slice('project:'.length);
  const first = await engine.run(turn({ runId: 'run_w1', session: { ref: forked.ref, generation: 1 } }));
  assert.deepEqual(resumeArgs(last().args), ['--resume', parentId, '--fork-session', '--session-id', id]);
  assert.equal(last().options.env?.CLAUDE_CODE_PROJECT_DIR_NAME, 'workforce-rebuilt');
  assert.equal(first.session?.ref, forked.ref);
  await engine.run(turn({ runId: 'run_w2', session: { ref: forked.ref, generation: 1 } }));
  assert.deepEqual(resumeArgs(last().args), ['--resume', id]);
  assert.equal(last().options.env?.CLAUDE_CODE_PROJECT_DIR_NAME, 'workforce-rebuilt');
});

test('a locally rebuilt path parent forks with that path; deletion revokes its provenance', async () => {
  const { engine, last } = setup();
  const { ref: file } = await rebuild(engine, 'path');
  assert.match(file, /\.jsonl$/);
  const forked = await engine.fork(forkInput(file));
  await engine.run(turn({ runId: 'run_w1', session: { ref: forked.ref, generation: 1 } }));
  assert.deepEqual(resumeArgs(last().args), ['--resume', file, '--fork-session', '--session-id', forked.ref]);
  assert.equal(await engine.deleteSession(acc, file), 'deleted');
  await assert.rejects(engine.fork(forkInput(file)), /rebuilt from the filtered Autark history/);
});

test('a turn that never reached the CLI keeps the fork pending; one the CLI answered with an error ends it', async () => {
  const quiet = { value: false };
  const failing = { value: false };
  const transcripts: Record<string, number> = {};
  const { engine, last } = setup({ quiet, failing, transcripts, folders: { [PROJECTS]: ['C--work'] } });
  const parentRef = (await engine.run(turn({ runId: 'run_p1' }))).session!.ref;
  transcripts[cliTranscript(parentRef)] = 100;
  const forked = await engine.fork(forkInput(parentRef));

  quiet.value = true;
  const silent = await engine.run(turn({ runId: 'run_w1', session: { ref: forked.ref, generation: 1 } }));
  assert.equal(silent.stop, 'error');
  quiet.value = false;
  failing.value = true;
  const failed = await engine.run(turn({ runId: 'run_w2', session: { ref: forked.ref, generation: 1 } }));
  assert.equal(failed.stop, 'error');
  assert.deepEqual(resumeArgs(last().args), ['--resume', parentRef, '--fork-session', '--session-id', forked.ref], 'still the fork');
  failing.value = false;
  await engine.run(turn({ runId: 'run_w3', session: { ref: forked.ref, generation: 1 } }));
  assert.deepEqual(resumeArgs(last().args), ['--resume', forked.ref], 'the CLI took the fork: resumed by its id');
});

test("no fork of a parent whose transcript is gone (a Forget or a purge): same folder, project: and an account without a home", async () => {
  const transcripts: Record<string, number> = {};
  const { engine, removeFile } = setup({ transcripts, folders: { [PROJECTS]: ['C--work'] } });
  const parentRef = (await engine.run(turn({ runId: 'run_p1' }))).session!.ref;
  await assert.rejects(engine.fork(forkInput(parentRef)), /transcript is gone/, 'same folder, nothing in the home');
  transcripts[cliTranscript(parentRef)] = 10;
  assert.match((await engine.fork(forkInput(parentRef))).ref, UUID);
  const project = await rebuild(engine, 'project');
  const projectFile = path.join(PROJECTS, 'workforce-rebuilt', `${project.ref.slice('project:'.length)}.jsonl`);
  const homeless = claudeAccount({ home: undefined });
  await assert.rejects(engine.fork(forkInput(project.ref, { account: homeless })), /transcript is gone/, 'a managed project ref still needs the app home');
  const other = claudeAccount({ id: 'acc_other', home: acc.home });
  await assert.rejects(engine.fork(forkInput(project.ref, { account: other })), /rebuilt from the filtered Autark history/, 'same file is not sufficient for another account');
  // Use the in-memory FS to emulate an independent removal (not an engine delete that also forgets the ref).
  await removeFile(projectFile);
  await assert.rejects(engine.fork(forkInput(project.ref)), /transcript is gone/);
});

test('deleting a fork that never ran drops it: a later turn requests rebase without spawning', async () => {
  const transcripts: Record<string, number> = {};
  const { engine, cli } = setup({ transcripts, folders: { [PROJECTS]: ['C--work'] } });
  const parentRef = (await engine.run(turn({ runId: 'run_p1' }))).session!.ref;
  transcripts[cliTranscript(parentRef)] = 10;
  const forked = await engine.fork(forkInput(parentRef));
  assert.equal(await engine.deleteSession(acc, forked.ref), 'missing', 'the CLI never wrote it');
  const stale = await engine.run(turn({ runId: 'run_w1', session: { ref: forked.ref, generation: 1 } }));
  assert.equal(stale.error?.details?.rebase, true);
  assert.equal(cli.of('turn').length, 1, 'no new turn on the deleted fork');
});
