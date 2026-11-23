// FX3 of the Sicher-Runde (19.11.2026, REVIEW-2 7 and 9): every agent process carries its id with this runtime's proof
// (an HMAC under a key held in memory), the wf CLI sends both and the Hello takes an agent's name only with a valid proof;
// the security section last applied is kept in the database, so the first read after a start puts back an edit made
// while the app was closed.
// Owns: these assertions only. Never: real sockets, a real engine or the person's data folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentIdentity, agentProof, validProof } from '../../../src/runtime/security/agent-proof.ts';
import { AGENT_PROOF_ENV } from '../../../src/shared/api/protocol.ts';
import { asAgent, withShim } from '../../../src/runtime/engines/wf-shim.ts';
import { threadIsolation } from '../../../src/runtime/engines/codex/isolation.ts';
import { CLOSE, ClientSockets, Keepalive } from '../../../src/runtime/http/ws.ts';
import { discover, type DiscoverEnv } from '../../../src/runtime/wf-cli/discover.ts';
import { closeError } from '../../../src/runtime/wf-cli/errors.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { securityDefaults } from '../../../src/shared/model/security-settings.ts';
import { securityOf } from '../../../src/shared/model/system.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { harness } from '../chat/harness.ts';
import { silentLog } from '../devices/fakes.ts';

test('REVIEW-2 7: the proof is this runtime\'s HMAC of the agent id – valid for that agent only', () => {
  const proof = agentProof('ag_lena');
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.equal(agentProof('ag_lena'), proof, 'the same key for the whole run');
  assert.equal(validProof('ag_lena', proof), true);
  assert.equal(validProof('ag_tom', proof), false, 'another agent\'s proof');
  for (const wrong of [undefined, '', 'x'.repeat(64), proof.toUpperCase(), 42]) assert.equal(validProof('ag_lena', wrong), false);
  assert.deepEqual(agentIdentity('ag_lena'), { AUTARK_AGENT: 'ag_lena', [AGENT_PROOF_ENV]: proof });
});

test('REVIEW-2 7: every agent process gets id and proof (shell, Claude turn, Codex thread); a shared one gets neither, an inherited pair never passes on', () => {
  const inherited = { PATH: '/bin', AUTARK_AGENT: 'ag_parent', AUTARK_AGENT_PROOF: agentProof('ag_parent') };
  const mine = asAgent(inherited, 'ag_lena', 'linux');
  assert.equal(mine.AUTARK_AGENT, 'ag_lena');
  assert.equal(mine.AUTARK_AGENT_PROOF, agentProof('ag_lena'));
  const shared = asAgent(inherited, undefined, 'linux');
  assert.equal(shared.AUTARK_AGENT, undefined);
  assert.equal(shared.AUTARK_AGENT_PROOF, undefined);
  const win = asAgent({ Autark_Agent_Proof: 'old', Path: 'C:\\x' }, 'ag_lena', 'win32');
  assert.equal(win.Autark_Agent_Proof, undefined, 'Windows spelling of an inherited proof is dropped too');
  assert.equal(withShim({}, 'C:\\data', undefined, 'win32', 'ag_lena').AUTARK_AGENT_PROOF, agentProof('ag_lena'));
  const set = threadIsolation(['c:\\w'], { GIT_X: '1' }, 'ag_lena').config.shell_environment_policy.set;
  assert.deepEqual(set, { GIT_X: '1', AUTARK_AGENT: 'ag_lena', AUTARK_AGENT_PROOF: agentProof('ag_lena') });
  assert.deepEqual(threadIsolation(['c:\\w'], { GIT_X: '1' }).config.shell_environment_policy.set, { GIT_X: '1' });
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  closedWith?: number;
  send(): void {}
  close(code: number): void { this.closedWith ??= code; }
  ping(): void {}
  terminate(): void {}
}

function hello(frame: Record<string, unknown>): { scope?: ClientScope; closed?: number } {
  const keepalive = new Keepalive();
  let attached: ClientScope | undefined;
  const sockets = new ClientSockets({
    rpc: { attach: (_connection, next) => { attached = next; return () => {}; }, handleHttp: async () => ({ id: 0 }) },
    authenticate: () => ({ kind: 'owner' }), keepalive, log: () => silentLog, agentLive: () => true,
  });
  const ws = new FakeSocket();
  try {
    sockets.accept(ws as never, true);
    ws.emit('message', Buffer.from(JSON.stringify({ protocol: 1, token: 'launch', client: 'cli', ...frame })), false);
    return { scope: attached, closed: ws.closedWith };
  } finally { keepalive.stop(); }
}

test('REVIEW-2 7: a Hello names an agent only with its proof; without one (a shell that set AUTARK_AGENT) it closes; no agent: the plain launch scope', () => {
  assert.deepEqual(hello({ agent: 'ag_lena', proof: agentProof('ag_lena') }).scope, { kind: 'owner', agentId: 'ag_lena' });
  assert.deepEqual(hello({ agent: 'ag_lena' }), { scope: undefined, closed: CLOSE.revoked });
  assert.deepEqual(hello({ agent: 'ag_lena', proof: agentProof('ag_tom') }), { scope: undefined, closed: CLOSE.revoked });
  assert.deepEqual(hello({}).scope, { kind: 'owner' });
  assert.match(closeError(CLOSE.revoked).message, /not started by Autark for that agent/);
});

test('REVIEW-2 7: the wf CLI sends the proof beside the agent and never prints it', () => {
  const DATA = 'C:\\Users\\Ann\\AppData\\Roaming\\Autark';
  const env = (vars: Record<string, string>): DiscoverEnv => ({
    platform: 'win32', env: vars, home: 'C:\\Users\\Ann', cwd: 'C:\\work', alive: () => true,
    readFile: () => JSON.stringify({ port: 4321, token: 'fixture-runtime-launch-token', pid: 77 }),
  });
  const proof = agentProof('ag_ava');
  const found = discover({}, env({ AUTARK_DATA: DATA, AUTARK_AGENT: 'ag_ava', AUTARK_AGENT_PROOF: proof }));
  assert.ok(found.ok);
  assert.deepEqual({ agent: found.endpoint.hello().agent, proof: found.endpoint.hello().proof }, { agent: 'ag_ava', proof });
  assert.equal(found.endpoint.redact(`x ${proof} y`), 'x [proof] y');
  assert.ok(!JSON.stringify(found.endpoint).includes(proof));
  const other = discover({ data: 'D:\\Other' }, env({ AUTARK_DATA: DATA, AUTARK_AGENT: 'ag_ava', AUTARK_AGENT_PROOF: proof }));
  assert.ok(other.ok);
  assert.equal(other.endpoint.hello().proof, undefined, 'another company: neither agent nor proof');
});

test('REVIEW-2 9: an edit of the security section made while the app was closed is put back at the first read; a new company takes its file', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-fx3-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness();
  const store = (data = dir) => new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, dataDir: data, env: { locale: 'en-US', timezone: 'UTC' } });
  const first = store();
  first.update({ security: securityDefaults('secure') } as never);
  first.close();
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"mode": "secure"', '"mode": "trust"'));
  assert.match(readFileSync(file, 'utf8'), /"mode": "trust"/, 'the closed-app edit is on disk');
  const next = store();
  assert.equal(securityOf(next.get()).mode, 'secure', 'put back');
  assert.match(readFileSync(file, 'utf8'), /"mode": "secure"/, 'the file says it again');
  assert.ok(existsSync(path.join(dir, 'settings.rejected.json')), 'the edit kept aside');
  next.close();

  const fresh = mkdtempSync(path.join(os.tmpdir(), 'wf-fx3-fresh-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  const other = harness();
  writeFileSync(path.join(fresh, 'settings.json'), JSON.stringify({ security: securityDefaults('secure') }));
  const taken = new SettingsStore({ db: other.db, bus: other.bus, clock: other.clock, dataDir: fresh, env: { locale: 'en-US', timezone: 'UTC' } });
  assert.equal(securityOf(taken.get()).mode, 'secure', 'no record yet: the file\'s section is taken');
  taken.close();
});
