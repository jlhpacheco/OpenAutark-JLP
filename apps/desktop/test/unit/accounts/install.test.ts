// B-051 L1: Codex installs without Node.js – the official standalone installer first (Windows
// install.ps1, POSIX install.sh) with the caller's env plus CODEX_NON_INTERACTIVE=1, `npm i -g` only when
// that failed and npm exists, one clear error when every route failed; Claude Code keeps its own
// installer and text. A route counts only when the CLI is found afterwards (a forced lookup). B-080 wave 3: PowerShell 7
// by Microsoft's per-user installer where none is found (pwshInstaller, ensurePwsh); review: progress off, telemetry
// opt-out, a run that leaves no pwsh.exe throws with its exit and the free disk space.
// Owns: nothing in production. Never runs a real installer (scripted supervisor and finder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePwsh, INSTALL_FAILED, INSTALL_OFF_IN_DEMO, installCli, pwshInstaller } from '../../../src/runtime/accounts/install.ts';
import type { ExecutableFinder } from '../../../src/runtime/accounts/executables.ts';
import { fakeSpawn, testSupervisor, type SpawnCall } from '../engines/fakes.ts';

const ENV: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' };

/** A finder over a map the scripted installers change; records every lookup. */
function scripted(initial: Record<string, string | null>) {
  const map: Record<string, string | null> = { ...initial };
  const lookups: Array<{ id: string; force: boolean }> = [];
  let clears = 0;
  const finder = {
    find: async (id: string, options: { force?: boolean } = {}) => {
      lookups.push({ id, force: options.force === true });
      const found = map[id];
      return found ? { command: found, prefixArgs: [], path: found } : null;
    },
    clear: () => { clears += 1; },
  } as unknown as ExecutableFinder;
  return { finder, map, lookups, clears: () => clears };
}

/** Each install command exits with the code `answer` returns (after it may have "installed" something). */
function rig(initial: Record<string, string | null>, answer: (call: SpawnCall, map: Record<string, string | null>) => number | 'hang') {
  const s = scripted(initial);
  const { spawn, calls } = fakeSpawn((call) => {
    const code = answer(call, s.map);
    if (code !== 'hang') setImmediate(() => call.child.exit(code));
  });
  return { ...s, calls, supervisor: testSupervisor(spawn) };
}

test('Codex on Windows: the official install.ps1 with CODEX_NON_INTERACTIVE=1 and the caller env; npm is never asked', async () => {
  const r = rig({ codex: null, npm: 'C:\\nodejs\\npm.cmd' }, (_call, map) => { map.codex = 'C:\\Users\\p\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'; return 0; });
  assert.equal(await installCli('codex', { supervisor: r.supervisor, finder: r.finder, platform: 'win32', env: ENV }), true);
  assert.equal(r.calls.length, 1);
  const [call] = r.calls;
  assert.equal(call.command, 'powershell.exe');
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(call.args[3], /Invoke-RestMethod 'https:\/\/chatgpt\.com\/codex\/install\.ps1'/);
  assert.ok(call.args[3].includes("Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin\\codex.exe'"), 'checks the standalone install place');
  assert.equal(call.options.env?.CODEX_NON_INTERACTIVE, '1');
  assert.equal(call.options.env?.PATH, ENV.PATH, 'PATH is kept');
  assert.equal(call.options.env?.SystemRoot, ENV.SystemRoot, 'SystemRoot is kept');
  assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'ignore'], 'redirected stdio: every prompt answers no');
  assert.equal(ENV.CODEX_NON_INTERACTIVE, undefined, 'the caller env object is not changed');
  assert.ok(!r.lookups.some((lookup) => lookup.id === 'npm'), 'no npm needed');
  assert.deepEqual(r.lookups.filter((lookup) => lookup.id === 'codex').map((lookup) => lookup.force), [true, true], 'before and after: forced lookups');
  assert.equal(r.clears(), 1);
});

test('Codex on macOS/Linux: install.sh through bash with pipefail', async () => {
  const r = rig({ codex: null }, (_call, map) => { map.codex = '/home/p/.local/bin/codex'; return 0; });
  assert.equal(await installCli('codex', { supervisor: r.supervisor, finder: r.finder, platform: 'linux', env: { PATH: '/usr/bin' } }), true);
  assert.equal(r.calls[0].command, '/bin/bash');
  assert.deepEqual(r.calls[0].args, ['-c', 'set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh']);
  assert.deepEqual([r.calls[0].options.env?.CODEX_NON_INTERACTIVE, r.calls[0].options.env?.PATH], ['1', '/usr/bin']);
});

test('Codex: the script route failing falls back to npm (when npm exists, found by a forced lookup)', async () => {
  const r = rig({ codex: null, npm: 'C:\\nodejs\\npm.cmd' }, (call, map) => {
    if (call.command === 'powershell.exe') return 1;
    map.codex = 'C:\\Users\\p\\AppData\\Roaming\\npm\\codex.cmd';
    return 0;
  });
  assert.equal(await installCli('codex', { supervisor: r.supervisor, finder: r.finder, platform: 'win32', env: ENV }), true);
  assert.deepEqual(r.calls.map((call) => call.command), ['powershell.exe', 'cmd.exe']);
  assert.deepEqual(r.calls[1].args, ['/d', '/s', '/c', 'npm', 'install', '-g', '@openai/codex@latest']);
  assert.equal(r.calls[1].options.env?.CODEX_NON_INTERACTIVE, undefined, 'npm runs with the caller env');
  assert.deepEqual(r.lookups.filter((lookup) => lookup.id === 'npm'), [{ id: 'npm', force: true }], 'Node.js installed meanwhile is found');
});

test('Codex: a script that exits 0 without a CLI the finder sees is a failed route too', async () => {
  const r = rig({ codex: null, npm: '/usr/bin/npm' }, (call, map) => { if (call.command !== '/bin/bash') map.codex = '/usr/local/bin/codex'; return 0; });
  assert.equal(await installCli('codex', { supervisor: r.supervisor, finder: r.finder, platform: 'linux' }), true);
  assert.deepEqual(r.calls.map((call) => [call.command, ...call.args].join(' ')), ['/bin/bash -c set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh', '/usr/bin/npm install -g @openai/codex@latest']);
});

test('Codex: every route failed (no npm, or npm failed too) → one clear error', async () => {
  const none = rig({ codex: null }, () => 1);
  await assert.rejects(installCli('codex', { supervisor: none.supervisor, finder: none.finder, platform: 'win32', env: ENV }), (error: Error & { code?: string }) => error.message === INSTALL_FAILED.codex && error.code === 'unavailable');
  assert.equal(none.calls.length, 1, 'no npm: only the script route ran');
  assert.equal(INSTALL_FAILED.codex, 'Could not install Codex. Check your connection and try again.');

  const both = rig({ codex: null, npm: '/usr/bin/npm' }, () => 1);
  await assert.rejects(installCli('codex', { supervisor: both.supervisor, finder: both.finder, platform: 'linux' }), (error: Error) => error.message === INSTALL_FAILED.codex);
  assert.equal(both.calls.length, 2);
});

test('Codex: a route that hangs is stopped at the timeout and the next one runs', async () => {
  const r = rig({ codex: null, npm: '/usr/bin/npm' }, (call, map) => { if (call.command === '/bin/bash') return 'hang'; map.codex = '/usr/local/bin/codex'; return 0; });
  assert.equal(await installCli('codex', { supervisor: r.supervisor, finder: r.finder, platform: 'linux', timeoutMs: 20 }), true);
  assert.equal(r.calls[0].child.killed, true, 'the hanging installer was stopped');
  assert.equal(r.calls.length, 2);
});

test('installed already: nothing runs; Claude Code keeps its installer, its own text and no npm fallback', async () => {
  const there = rig({ codex: '/bin/codex' }, () => 0);
  assert.equal(await installCli('codex', { supervisor: there.supervisor, finder: there.finder, platform: 'linux' }), false);
  assert.equal(there.calls.length, 0);

  const claude = rig({ claude: null, npm: '/usr/bin/npm' }, () => 1);
  await assert.rejects(installCli('claude', { supervisor: claude.supervisor, finder: claude.finder, platform: 'win32', env: ENV }), (error: Error) => error.message === INSTALL_FAILED.claude);
  assert.equal(claude.calls.length, 1);
  assert.match(claude.calls[0].args[3], /https:\/\/claude\.ai\/install\.ps1'\)\)\) stable/);
  assert.equal(claude.calls[0].options.env?.CODEX_NON_INTERACTIVE, undefined);
  assert.equal(INSTALL_FAILED.claude, 'Could not install Claude Code. Check your connection and try again.');
});

test('B-051 integration: demo mode never runs a real installer (an installed CLI still counts)', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    const r = rig({ [provider]: null, npm: '/usr/bin/npm' }, () => 0);
    await assert.rejects(installCli(provider, { supervisor: r.supervisor, finder: r.finder, platform: 'win32', env: ENV, demo: true }), (error: Error & { code?: string }) => error.message === INSTALL_OFF_IN_DEMO && error.code === 'unavailable');
    assert.equal(r.calls.length, 0, `${provider}: nothing was spawned`);
  }
  const there = rig({ codex: '/bin/codex' }, () => 0);
  assert.equal(await installCli('codex', { supervisor: there.supervisor, finder: there.finder, platform: 'linux', demo: true }), false);
});

// B-080 wave 3 (live 08.–09.11.2026: Codex's Windows PowerShell 5.1 piped "Nächste" into python as "N?chste"): PowerShell 7
// for the engines' shells, by Microsoft's official per-user installer – constant arguments, no admin, PATH untouched.
test('B-080 wave 3: pwshInstaller is Microsoft\'s per-user installer with constant arguments into %LOCALAPPDATA%\\Microsoft\\powershell', () => {
  const route = pwshInstaller(ENV);
  assert.equal(route.command, 'powershell.exe');
  assert.deepEqual(route.env, { ...ENV, POWERSHELL_TELEMETRY_OPTOUT: '1' }, 'the caller env plus the telemetry opt-out');
  assert.equal(ENV.POWERSHELL_TELEMETRY_OPTOUT, undefined, 'the caller env object is not changed');
  const own = { ...ENV, powershell_telemetry_optout: '0' };
  assert.equal(pwshInstaller(own).env, own, 'a value of its own (any spelling) stays');
  assert.deepEqual(route.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(route.args.length, 4);
  assert.match(route.args[3], /Invoke-RestMethod 'https:\/\/aka\.ms\/install-powershell\.ps1'/);
  assert.ok(route.args[3].indexOf("$ProgressPreference = 'SilentlyContinue'") < route.args[3].indexOf('Invoke-RestMethod'), 'progress records off before the script runs (Expand-Archive on 5.1)');
  assert.ok(route.args[3].includes("$to = Join-Path $env:LOCALAPPDATA 'Microsoft\\powershell'") && route.args[3].includes('-Destination $to'), 'the per-user folder');
  assert.ok(route.args[3].includes("Test-Path -LiteralPath (Join-Path $to 'pwsh.exe')"), 'counts only with pwsh.exe there');
  assert.doesNotMatch(route.args[3], /-UseMSI|-AddToPath|RunAs|Verb|Machine/i, 'no MSI, no admin, no PATH change');
  assert.deepEqual(pwshInstaller(ENV), route, 'constant: the same every time');
});

test('B-080 wave 3: ensurePwsh runs nothing off Windows and nothing in demo mode', async () => {
  const r = rig({}, () => 0);
  const env: NodeJS.ProcessEnv = { PATH: 'C:\\nothing', LOCALAPPDATA: 'C:\\nowhere-local', ProgramFiles: 'C:\\nowhere-programs' };
  for (const deps of [{ platform: 'linux' as const }, { platform: 'darwin' as const }, { platform: 'win32' as const, demo: true }]) {
    assert.equal(await ensurePwsh({ supervisor: r.supervisor, env, ...deps }), false);
  }
  assert.equal(r.calls.length, 0, 'nothing is spawned');
});

test('B-080 wave 3: ensurePwsh runs the installer once on Windows where no pwsh is found; a found pwsh runs nothing', { skip: process.platform !== 'win32' ? 'Windows paths' : undefined }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-install-pwsh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { PATH: path.join(root, 'nothing'), LOCALAPPDATA: path.join(root, 'local'), ProgramFiles: path.join(root, 'programs') };
  const user = path.join(root, 'local', 'Microsoft', 'powershell');
  const install = rig({}, (call) => {
    if (call.command === 'powershell.exe') { mkdirSync(user, { recursive: true }); writeFileSync(path.join(user, 'pwsh.exe'), ''); }
    return 0;
  });
  assert.equal(await ensurePwsh({ supervisor: install.supervisor, env, platform: 'win32' }), true, 'installed now');
  assert.equal(install.calls.length, 1);
  assert.deepEqual([install.calls[0].command, ...install.calls[0].args], [pwshInstaller(env).command, ...pwshInstaller(env).args]);
  assert.deepEqual(install.calls[0].options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(await ensurePwsh({ supervisor: install.supervisor, env, platform: 'win32' }), false, 'found now: nothing runs again');
  assert.equal(install.calls.length, 1);

  const failing = rig({}, () => 1);
  const other = path.join(root, 'other');
  mkdirSync(other, { recursive: true });
  const empty: NodeJS.ProcessEnv = { PATH: path.join(root, 'nothing'), LOCALAPPDATA: other, ProgramFiles: path.join(root, 'programs') };
  await assert.rejects(ensurePwsh({ supervisor: failing.supervisor, env: empty, platform: 'win32' }),
    (error: Error) => error.message.startsWith('PowerShell 7\'s installer ended with exit code 1 and left no pwsh.exe; ') && error.message.includes(` GB free on the drive of ${other}`),
    'a failed install names its exit and the free disk space (main.ts logs it)');
  const hanging = rig({}, () => 'hang');
  await assert.rejects(ensurePwsh({ supervisor: hanging.supervisor, env: empty, platform: 'win32', timeoutMs: 20 }), (error: Error) => error.message.startsWith('PowerShell 7\'s installer was stopped at its time limit and left no pwsh.exe; '));
  assert.equal(hanging.calls[0].child.killed, true, 'stopped at the time limit');
  const system = path.join(root, 'programs', 'PowerShell', '7');
  mkdirSync(system, { recursive: true });
  writeFileSync(path.join(system, 'pwsh.exe'), '');
  assert.equal(await ensurePwsh({ supervisor: failing.supervisor, env: empty, platform: 'win32' }), false);
  assert.equal(failing.calls.length, 1, '%ProgramFiles%\\PowerShell\\7 counts as found');
});
