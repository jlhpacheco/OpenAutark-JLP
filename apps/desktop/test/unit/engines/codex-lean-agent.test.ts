// Every Codex agent thread opens lean: native shell features remain off at start, resume and fork.
// view_image and image_generation remain available; isolation.ts's workspace features stay off
// again, the permission/app/collaboration/environment blocks off, its skill list, sub-agents and question tool off, Codex's
// live web search on, apps off; its environment, history, developer instructions and isolation (read-only open, untrusted
// cwd, approvals to us, the turn's own sandbox) stay exactly as before. A Codex that refuses these settings fails the open
// (a resume: rebase) – there is no plainer fallback.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { AGENT_FEATURES_KEPT, AGENT_FEATURES_OFF, HELPER_FEATURES_OFF, agentLeanConfig, agentThread } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { WORKSPACE_FEATURES, threadIsolation } from '../../../src/runtime/engines/codex/isolation.ts';
import { RUN_CEILING } from '../../../src/runtime/agents/compaction-policy.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

/** A scripted app-server; `refuse(msg)` answers a thread/start or thread/resume with an error. */
function appServer(refuse: (msg: any) => boolean = () => false) {
  const requests: any[] = [];
  let threads = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      if ((msg.method === 'thread/start' || msg.method === 'thread/resume') && refuse(msg)) {
        child.send({ id: msg.id, error: { code: -32602, message: 'unknown variant `web_search`' } });
        return;
      }
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/fork': child.send({ id: msg.id, result: { thread: { id: 'thr_' + (++threads) } } }); break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } }); break;
        case 'thread/inject_items': case 'thread/unsubscribe': child.send({ id: msg.id, result: {} }); break;
        case 'turn/start':
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId: msg.params.threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'ok' } } });
          child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
          break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });

function assertLeanAgent(params: any, label: string): void {
  assert.deepEqual(params.config.features, agentLeanConfig().features, `${label}: Codex's own tools off`);
  for (const name of AGENT_FEATURES_KEPT) assert.equal(params.config.features[name], undefined, `${label}: ${name} kept`);
  for (const key of ['include_permissions_instructions', 'include_apps_instructions', 'include_collaboration_mode_instructions', 'include_environment_context']) {
    assert.equal(params.config[key], false, `${label}: ${key}`);
  }
  assert.equal(params.config.web_search, 'live', `${label}: Codex's own live web search`);
  assert.deepEqual(params.config.apps, { _default: { enabled: false } }, label);
  assert.deepEqual(params.config.skills, { include_instructions: false, bundled: { enabled: false } }, `${label}: no Codex skill list`);
  assert.deepEqual(params.config.agents, { enabled: false }, `${label}: no Codex sub-agents (role text, spawn tools)`);
  assert.deepEqual(params.config.tools, { experimental_request_user_input: { enabled: false } }, `${label}: no question tool nobody answers`);
  assert.equal(params.config.model_auto_compact_token_limit, RUN_CEILING, `${label}: Runde "Halb" – Codex compacts near the run ceiling`);
  assert.equal(params.environments, undefined, `${label}: the agent keeps its environment`);
  assert.equal(params.ephemeral, undefined, `${label}: and its history`);
  // isolation.ts exactly as before
  assert.equal(params.sandbox, 'read-only', label);
  assert.equal(params.approvalPolicy, 'never', label);
  assert.equal(params.approvalsReviewer, 'user', label);
  assert.deepEqual(params.config.project_root_markers, [], label);
  assert.equal(params.config.project_doc_max_bytes, 0, label);
  assert.deepEqual(params.config.projects['/work'], { trust_level: 'untrusted' }, label);
}

test('agentLeanConfig: the helper\'s features off except view_image and image_generation; the workspace features off too; blocks off, web search disabled, apps off', () => {
  const config = agentLeanConfig();
  const features = config.features as Record<string, boolean>;
  for (const name of AGENT_FEATURES_KEPT) assert.equal(name in features, false, `${name} kept (not even set to true)`);
  assert.ok(AGENT_FEATURES_KEPT.includes('image_generation'), 'owner 29.10.: agent threads keep Codex image generation (portraits)');
  for (const name of ['computer_use', 'browser_use', 'apps', 'plugins', 'skill_search', 'tool_suggest', 'goals', 'memories', 'hooks', 'mentions_v2', 'remote_plugin']) {
    assert.equal(features[name], false, name);
  }
  for (const name of WORKSPACE_FEATURES) assert.equal(features[name], false, `${name}: a session features table never brings it back`);
  assert.ok(Object.values(features).every((value) => value === false), 'nothing is turned on');
  assert.equal(AGENT_FEATURES_OFF.length, Object.keys(features).length);
  assert.ok(HELPER_FEATURES_OFF.every((name) => AGENT_FEATURES_KEPT.includes(name) || features[name] === false), 'every other helper feature is off');
  assert.equal('multi_agent' in features, false, 'the flag changes nothing – agents.enabled does');
  assert.equal(config.web_search, 'live', "the agent searches with Codex's own live search");
  assert.equal(config.include_environment_context, false);
});

test('agentThread: the lean config never replaces an isolation key; every other setting stays as given', () => {
  const isolation = threadIsolation(['/w'], { GIT_PAGER: 'cat' });
  const settings = { model: 'gpt-test', cwd: '/w', baseInstructions: 'S', developerInstructions: 'V', approvalPolicy: 'on-request', ...isolation };
  const out = agentThread(settings);
  for (const [key, value] of Object.entries(isolation.config)) assert.deepEqual((out.config as any)[key], value, key);
  assert.equal(out.sandbox, 'read-only');
  assert.equal(out.approvalsReviewer, 'user');
  assert.equal(out.developerInstructions, 'V', 'the volatile developer message stays');
  assert.equal(out.baseInstructions, 'S');
  assert.equal('environments' in out, false);
  assert.equal('ephemeral' in out, false);
  assert.deepEqual(settings.config, isolation.config, 'the given settings are not changed');
  // A clash (none today) would keep the isolation's value.
  assert.equal((agentThread({ config: { web_search: 'cached' } }).config as any).web_search, 'cached');
});

test('an agent thread opens lean on thread/start and on thread/resume; its turns keep their own sandbox', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  const start = turnInput({ runId: 'run_1' }).input;
  const fresh = await e.run(start);
  assert.equal(fresh.stop, 'done');
  assertLeanAgent(fake.sent('thread/start')[0].params, 'thread/start');
  assert.equal(fake.sent('thread/start')[0].params.dynamicTools.length, 1);
  assert.deepEqual(fake.sent('turn/start')[0].params.sandboxPolicy, { type: 'dangerFullAccess' }, 'an agent turn works on the whole PC');

  await e.unload(start.account, fresh.session!.ref);
  assert.equal((await e.run(turnInput({ runId: 'run_2', session: fresh.session }).input)).stop, 'done');
  assertLeanAgent(fake.sent('thread/resume')[0].params, 'thread/resume');
  assert.equal(fake.sent('thread/resume')[0].params.threadId, fresh.session!.ref);
  const fork = await e.fork({ runId: 'run_fork', agentId: start.agentId, parentRef: fresh.session!.ref, cwd: start.cwd, account: start.account, model: start.model });
  assertLeanAgent(fake.sent('thread/fork')[0].params, 'thread/fork');
  assert.notEqual(fork.ref, fresh.session!.ref);
  assert.equal(fake.sent('thread/start').length + fake.sent('thread/resume').length + fake.sent('thread/fork').length, 3);
  await e.dispose();
});

test('a refused resume is the thread\'s own: rebase, one request; the next new thread opens lean', async () => {
  const fake = appServer((msg) => msg.method === 'thread/resume');
  const e = engineOf(fake.spawn);
  const initial = turnInput().input;
  const fresh = await e.run(initial);
  assert.equal(fresh.stop, 'done');
  await e.unload(initial.account, fresh.session!.ref);
  const result = await e.run(turnInput({ session: fresh.session }).input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.details?.rebase, true);
  assert.equal(fake.sent('thread/resume').length, 1, 'no plainer second try');
  await e.run(turnInput({ runId: 'run_2' }).input);
  assert.equal(fake.sent('thread/start').length, 2);
  assertLeanAgent(fake.sent('thread/start')[1].params, 'thread/start');
  await e.dispose();
});

test('a Codex that refuses the lean agent settings fails the turn – no plainer thread', async () => {
  const fake = appServer((msg) => msg.method === 'thread/start');
  const e = engineOf(fake.spawn);
  const result = await e.run(turnInput({ runId: 'run_1' }).input);
  assert.equal(result.stop, 'error');
  assert.equal(fake.sent('thread/start').length, 1);
  await e.dispose();
});

test('custom thread overrides cannot turn the five native shell flags back on', () => {
  const flags = ['shell_tool', 'unified_exec', 'shell_snapshot', 'shell_zsh_fork', 'js_repl'];
  const withOverrides = agentThread({config: {features: {...Object.fromEntries(flags.map(flag => [flag, true])), code_mode: true}}});
  const features = withOverrides.config.features as Record<string, boolean>;
  for (const flag of flags) assert.equal(features[flag], false);
  assert.equal(features.code_mode, true);
});