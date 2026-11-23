// 0.3.19, the persistent mark (engines/managed-path.ts) through the real engines: every own write path seals the session
// at its end with its transcript as it then stands – Codex: a new turn, a resumed turn, a fork, a revert, a fresh rebuild;
// Claude Code: a new turn, a resumed turn, a fork (pending until its first turn seals the new session), a rebuild. Then a
// restart (new engine instances over the same database): every sealed session resumes natively, one whose transcript
// someone else extended or whose fork never ran is cold – its turn ends in the rebase conflict – and a deleted session
// leaves no mark. The fold is a resumed turn (its drop on a cold session: agents/context-fold.test.ts).
// Owns: these assertions only. Never starts a real binary (scripted app-server / CLI); every transcript is a synthetic
// file in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { ClaudeEngine } from '../../../src/runtime/engines/claude/engine.ts';
import { nodeFiles } from '../../../src/runtime/engines/claude/rebuild.ts';
import { homeRoots } from '../../../src/runtime/system/paths.ts';
import { LEGACY_SESSION, type ManagedPathStore } from '../../../src/runtime/engines/managed-session.ts';
import type { EngineRebuildInput, RebuildItem } from '../../../src/runtime/engines/types.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';
import { VERIFIED_CODEX_AGENT, codexHome, managedStore } from './managed-fixture.ts';

const ITEMS: RebuildItem[] = [
  { itemId: 'm1', kind: 'm', role: 'user', text: '[10:00] Lena: build the export' },
  { itemId: 'a2', kind: 'a', role: 'assistant', text: 'The export is written.' },
];
type Row = { state: string; transcript: string | null; transcript_bytes: number | null };
type Db = ReturnType<typeof managedStore>['db'];
const rowOf = (db: Db, engine: string, accountId: string, ref: string) => db.get<Row>('SELECT state, transcript, transcript_bytes FROM managed_paths WHERE engine = ? AND account_id = ? AND session_ref = ?', [engine, accountId, ref]);
const settled = (engine: object) => (engine as { trust: { settled(): Promise<void> } }).trust.settled();
/** The mark is 'ready' for exactly the transcript as it stands now. */
function sealedAt(db: Db, engine: string, accountId: string, ref: string, file: string) {
  const row = rowOf(db, engine, accountId, ref);
  assert.deepEqual(row && [row.state, row.transcript, row.transcript_bytes], ['ready', file, statSync(file).size], `${engine} ${ref}`);
}

/** A Codex app-server that writes each thread's rollout as Codex does: one file per thread, appended on every write. */
function writingCodex(home: ReturnType<typeof codexHome>) {
  let threads = 0;
  let forks = 0;
  let turns = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method || msg.id === undefined) return;
      const write = (id: string, what: string) => home.append(id, JSON.stringify({ type: 'event_msg', payload: { what } }));
      const threadId = msg.params?.threadId as string;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: VERIFIED_CODEX_AGENT } }); break;
        case 'thread/start': { const id = `thr_${++threads}`; write(id, 'session_meta'); child.send({ id: msg.id, result: { thread: { id } } }); break; }
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: threadId } } }); break;
        case 'thread/fork': {
          const id = `thr_fork_${++forks}`;
          writeFileSync(home.file(id), readFileSync(home.file(threadId)));
          write(id, 'forked');
          child.send({ id: msg.id, result: { thread: { id, forkedFromId: threadId }, cwd: msg.params.cwd, model: 'gpt-test' } });
          break;
        }
        case 'thread/revert': write(threadId, 'reverted'); child.send({ id: msg.id, result: { thread: { id: threadId, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null } }); break;
        case 'thread/inject_items': write(threadId, 'injected'); child.send({ id: msg.id, result: {} }); break;
        case 'thread/delete': rmSync(home.file(threadId), { force: true }); child.send({ id: msg.id, result: {} }); break;
        case 'turn/start': {
          const id = `turn_${++turns}`;
          write(threadId, id);
          child.send({ id: msg.id, result: { turn: { id, status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `m${turns}`, type: 'agentMessage', text: 'ok' } } });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
          break;
        }
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return spawn;
}

const codexEngine = (store: ManagedPathStore, home: string) => new CodexEngine({
  supervisor: testSupervisor(writingCodex(homes.get(home)!)), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0',
  realpath: async (dir: string) => dir, managed: store, env: { CODEX_HOME: home },
} as ConstructorParameters<typeof CodexEngine>[0]);
const homes = new Map<string, ReturnType<typeof codexHome>>();

function rebuildInput(patch: Partial<EngineRebuildInput> = {}): EngineRebuildInput {
  const { input } = turnInput();
  return {
    runId: 'run_9', agentId: 'ag_1', account: account(), model: 'gpt-test', cwd: '/work', items: ITEMS, tools: input.tools, toolNames: ['tasks.create'],
    system: { stable: 'STABLE', volatile: 'VOLATILE' }, generation: 3, probe: { version: 'v', ok: true, verify: 'accepted', at: 1 }, ...patch,
  };
}

test('Codex: turn, resumed turn, fork, revert and rebuild each seal the mark; after a restart they resume, an extended one is cold, a deleted one has no mark', async () => {
  const home = codexHome([]);
  homes.set(home.dir, home);
  const { db, store } = managedStore();
  const acc = account().id as string;
  try {
    const e = codexEngine(store, home.dir);
    const first = await e.run(turnInput({ runId: 'run_1' }).input);
    const thread = first.session!.ref;
    await settled(e);
    sealedAt(db, 'codex', acc, thread, home.file(thread));
    const after = statSync(home.file(thread)).size;

    await e.run(turnInput({ runId: 'run_2', session: { ref: thread, generation: 1 } }).input);
    await settled(e);
    sealedAt(db, 'codex', acc, thread, home.file(thread));
    assert.ok(statSync(home.file(thread)).size > after, 'the resumed turn wrote, and the seal followed it');

    const fork = (await e.fork({ runId: 'run_w1', agentId: 'ag_1', account: account(), parentRef: thread, cwd: '/work', model: 'gpt-test' })).ref;
    await settled(e);
    sealedAt(db, 'codex', acc, fork, home.file(fork));

    await e.rebuild(rebuildInput({ revert: { ref: thread, beforeTurn: 'turn_2' } }));
    await settled(e);
    sealedAt(db, 'codex', acc, thread, home.file(thread));

    const rebuilt = (await e.rebuild(rebuildInput())).ref;
    await settled(e);
    sealedAt(db, 'codex', acc, rebuilt, home.file(rebuilt));
    await e.dispose();

    // the restart: a new engine instance, empty process memory, the same database
    const again = codexEngine(store, home.dir);
    for (const ref of [thread, fork, rebuilt]) assert.equal(await again.managedResume(account(), ref), true, `${ref} warm`);
    const resumed = await again.run(turnInput({ runId: 'run_3', session: { ref: thread, generation: 1 } }).input);
    assert.equal(resumed.stop, 'done');
    home.append(fork, '{"type":"event_msg","payload":{"what":"written outside Autark"}}');
    assert.equal(await again.managedResume(account(), fork), false, 'extended since its seal');
    const cold = await again.run(turnInput({ runId: 'run_4', session: { ref: fork, generation: 1 } }).input);
    assert.deepEqual([cold.stop, cold.error?.code, cold.error?.message, cold.error?.details?.rebase], ['error', 'conflict', LEGACY_SESSION, true]);
    assert.equal(await again.deleteSession(account(), rebuilt), 'deleted');
    assert.equal(rowOf(db, 'codex', acc, rebuilt), undefined, 'deleteSession takes its mark');
    await again.dispose();
  } finally { home.cleanup(); homes.delete(home.dir); }
});

const valueAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

/** Claude Code over a temp data folder: the CLI writes and appends its transcripts on disk as the real one does. */
function claudeOnDisk(version = '2.1.303') {
  const data = mkdtempSync(path.join(os.tmpdir(), 'wf-claude-data-'));
  const own = path.join(data, 'accounts', 'acc_claude');
  const projects = path.join(own, 'projects', 'C--work');
  mkdirSync(projects, { recursive: true });
  const transcript = (id: string) => path.join(projects, `${id}.jsonl`);
  let n = 0;
  const fake = fakeSpawn((call) => {
    const { child, args } = call;
    if (args.includes('--version')) { setImmediate(() => { child.stdout.write(`${version} (Claude Code)\n`); setImmediate(() => child.exit(0)); }); return; }
    if (args.includes('--help')) { setImmediate(() => { child.stdout.write('Usage: claude [options]\n'); setImmediate(() => child.exit(0)); }); return; }
    if (!args.includes('--include-partial-messages')) {
      child.onLine = (message) => {
        if (message?.type === 'control_request') child.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [] } } });
      };
      return;
    }
    let started = false;
    child.onLine = (message) => {
      if (message?.type !== 'user' || started) return;
      started = true;
      const resume = valueAfter(args, '--resume');
      const fresh = valueAfter(args, '--session-id');
      let session: string;
      if (resume?.endsWith('.jsonl')) { session = path.basename(resume, '.jsonl'); appendFileSync(resume, '{"type":"assistant","appended":true}\n'); } else if (args.includes('--fork-session') && fresh && resume) {
        session = fresh;
        writeFileSync(transcript(session), `${readFileSync(transcript(resume), 'utf8')}{"type":"user","forked":true}\n`);
      } else { session = resume ?? fresh!; appendFileSync(transcript(session), `{"type":"user","turn":${++n}}\n`); }
      child.send({ type: 'system', subtype: 'init', session_id: session, claude_code_version: version });
      child.send({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session });
      setImmediate(() => child.exit(0));
    };
  });
  let ids = 0;
  const engine = (store: ManagedPathStore) => new ClaudeEngine({
    supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ claude: '/fake-bin/claude' }), tempDir: path.join(data, 'temp'), files: nodeFiles,
    env: { PATH: '/fake-bin' }, now: () => 1_800_000_000_000, uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    transcriptsDir: path.join(data, 'engine-transcripts', 'claude'), accountsRoots: homeRoots({ data, accounts: path.join(data, 'logins') }), managed: store,
  } as ConstructorParameters<typeof ClaudeEngine>[0]);
  const claudeAccount = () => account({ id: 'acc_claude', provider: 'claude', home: own });
  return { engine, claudeAccount, transcript, cleanup: () => rmSync(data, { recursive: true, force: true }) };
}

test('Claude Code: turn, resumed turn, a fork\'s first turn and a rebuild each seal the mark; a fork that never ran stays pending; after a restart the sealed ones resume', async () => {
  const cli = claudeOnDisk();
  const { db, store } = managedStore();
  try {
    const e = cli.engine(store);
    const input = (patch: Record<string, unknown> = {}) => turnInput({ account: cli.claudeAccount(), model: 'claude-opus-5-5', ...patch }).input;
    const first = await e.run(input({ runId: 'run_1' }));
    const session = first.session!.ref;
    await settled(e);
    sealedAt(db, 'claude', 'acc_claude', session, cli.transcript(session));

    await e.run(input({ runId: 'run_2', session: { ref: session, generation: 1 } }));
    await settled(e);
    sealedAt(db, 'claude', 'acc_claude', session, cli.transcript(session));

    const forked = (await e.fork({ runId: 'run_w1', agentId: 'ag_1', account: cli.claudeAccount(), parentRef: session, cwd: '/work', model: 'claude-opus-5-5' })).ref;
    assert.equal(rowOf(db, 'claude', 'acc_claude', forked)?.state, 'pending', 'no transcript before its first turn');
    const unrun = (await e.fork({ runId: 'run_w2', agentId: 'ag_1', account: cli.claudeAccount(), parentRef: session, cwd: '/work', model: 'claude-opus-5-5' })).ref;
    const ran = await e.run(input({ runId: 'run_w1', session: { ref: forked, generation: 1 } }));
    assert.equal(ran.stop, 'done');
    await settled(e);
    sealedAt(db, 'claude', 'acc_claude', ran.session!.ref, cli.transcript(ran.session!.ref));

    const built = await e.rebuild({
      runId: 'run_5', agentId: 'ag_1', account: cli.claudeAccount(), model: 'claude-opus-5-5', cwd: '/work', items: ITEMS, tools: [], toolNames: ['tasks.create'],
      system: { stable: 'STABLE', volatile: 'VOLATILE' }, generation: 2, probe: { version: '2.1.303', ok: true, tier: 'path', at: 1 },
    });
    await settled(e);
    sealedAt(db, 'claude', 'acc_claude', built.ref, built.ref);
    await e.dispose();

    const again = cli.engine(store);
    for (const ref of [session, ran.session!.ref, built.ref]) assert.equal(await again.managedResume(cli.claudeAccount(), ref), true, `${ref} warm`);
    assert.equal(await again.managedResume(cli.claudeAccount(), unrun), false, 'a fork that never ran is pending: cold');
    appendFileSync(cli.transcript(session), '{"type":"user","outside":true}\n');
    const cold = await again.run(input({ runId: 'run_6', session: { ref: session, generation: 1 } }));
    assert.deepEqual([cold.stop, cold.error?.code, cold.error?.details?.rebase], ['error', 'conflict', true], 'extended since its seal');
    const warm = await again.run(input({ runId: 'run_7', session: { ref: built.ref, generation: 2 } }));
    assert.equal(warm.stop, 'done');
    await again.dispose();
  } finally { cli.cleanup(); }
});

test('Claude Code below 2.1.303 (its --tools no allowlist yet): a sealed session is cold after a restart', async () => {
  const cli = claudeOnDisk('2.1.302');
  const { db, store } = managedStore();
  try {
    const e = cli.engine(store);
    const first = await e.run(turnInput({ runId: 'run_1', account: cli.claudeAccount(), model: 'claude-opus-5-5' }).input);
    await settled(e);
    assert.equal(rowOf(db, 'claude', 'acc_claude', first.session!.ref)?.state, 'ready');
    await e.dispose();
    assert.equal(await cli.engine(store).managedResume(cli.claudeAccount(), first.session!.ref), false);
  } finally { cli.cleanup(); }
});
