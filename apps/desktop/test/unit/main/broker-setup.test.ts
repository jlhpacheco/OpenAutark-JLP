// F03 (16.11.2026, main/broker-setup.ts): the broker's setup at an interactive start still runs hidden and is never
// waited for, but its end is read – exit 1223 the Windows prompt got no Yes, any other code or a start error failed –
// logged in main.log and reported once (main forwards it to the runtime as 'broker.setup'). The installer itself
// turns a No at the Windows prompt into exit 1223.
// 0.3.19 (23.11.2026): an exit 0 is "installed" only once a read-only `install.ps1 -Check` confirms it; PowerShell 5.1
// starts attached (never detached – without a console it ran nothing and exited 0) and without an inherited PSModulePath.
// Owns: these assertions only. Never: UAC or a real service; on Windows one test runs powershell.exe against throwaway
// stub scripts in a temp folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DECLINED_EXIT, powershellEnv, setupBroker, setupResult, spawnOptions, type BrokerSetup, type BrokerSetupDeps } from '../../../src/main/broker-setup.ts';

const ROOT = 'C:\\Users\\me\\AppData\\Local\\Programs\\Autark\\resources\\app.asar';
const SCRIPT = 'C:\\Users\\me\\AppData\\Local\\Programs\\Autark\\resources\\app.asar.unpacked\\resources\\broker\\install.ps1';

function rig(patch: Partial<BrokerSetupDeps> = {}) {
  const children: EventEmitter[] = [];
  const starts: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const lines: string[] = [];
  const reports: BrokerSetup[] = [];
  const deps: BrokerSetupDeps = {
    platform: 'win32', packaged: true, testMode: false, background: false, root: ROOT, exe: 'C:\\Autark\\Autark.exe',
    env: { SystemRoot: 'C:\\Windows' }, exists: (file) => file === SCRIPT,
    start: (command, args, env) => { starts.push({ command, args, env }); const child = new EventEmitter(); children.push(child); return child; },
    log: (line) => lines.push(line), report: (setup) => reports.push(setup), ...patch,
  };
  return { deps, children, starts, lines, reports, get child() { return children[0]!; } };
}

test('the exit code tells installed, declined (1223) and failed apart', () => {
  assert.deepEqual(setupResult(0, SCRIPT), { state: 'installed', script: SCRIPT });
  assert.deepEqual(setupResult(DECLINED_EXIT, SCRIPT), { state: 'declined', script: SCRIPT });
  assert.equal(DECLINED_EXIT, 1223);
  assert.deepEqual(setupResult(1, SCRIPT), { state: 'failed', code: 1, script: SCRIPT });
  assert.deepEqual(setupResult(null, SCRIPT), { state: 'failed', script: SCRIPT }, 'ended without a code');
});

test('an exit 0 is installed only after the read-only -Check confirms it; logged and reported once', () => {
  const r = rig();
  assert.equal(setupBroker(r.deps), true);
  assert.deepEqual(r.starts[0]!.args.slice(-2), ['-AppExe', 'C:\\Autark\\Autark.exe']);
  r.child.emit('exit', 0, null);
  r.child.emit('exit', 0, null);
  assert.equal(r.reports.length, 0, 'an exit 0 alone proves nothing');
  assert.equal(r.starts.length, 2, 'one check, however often the first exit is heard');
  assert.equal(r.starts[1]!.command, r.starts[0]!.command);
  assert.deepEqual(r.starts[1]!.args.slice(-3), ['-File', SCRIPT, '-Check']);
  assert.ok(!r.starts[1]!.args.includes('-AppExe'), 'the check changes nothing');
  r.children[1]!.emit('exit', 0, null);
  r.children[1]!.emit('exit', 0, null);
  assert.deepEqual(r.reports, [{ state: 'installed', script: SCRIPT }]);
  assert.equal(r.lines.at(-1), 'desktop broker setup: installed and running');
});

test('an exit 0 the check does not confirm (the 0.3.18 case: old broker still running) is failed, never installed', () => {
  const r = rig();
  setupBroker(r.deps);
  r.child.emit('exit', 0, null);
  r.children[1]!.emit('exit', 2, null);
  assert.deepEqual(r.reports, [{ state: 'failed', code: 2, script: SCRIPT }]);
  assert.match(r.lines.at(-1)!, /^desktop broker setup failed \(exit 2\): install\.ps1 ended with 0, but its -Check does not find the current broker running$/);
  for (const ends of [(c: EventEmitter) => c.emit('error', new Error('spawn EPERM')), (c: EventEmitter) => c.emit('exit', null, 'SIGTERM')]) {
    const s = rig();
    setupBroker(s.deps);
    s.child.emit('exit', 0, null);
    ends(s.children[1]!);
    assert.equal(s.reports.length, 1);
    assert.equal(s.reports[0]!.state, 'failed');
  }
  const thrown = rig();
  let calls = 0;
  thrown.deps.start = () => { if (calls++) throw new Error('no handles'); const c = new EventEmitter(); thrown.children.push(c); return c; };
  setupBroker(thrown.deps);
  thrown.child.emit('exit', 0, null);
  assert.deepEqual(thrown.reports, [{ state: 'failed', script: SCRIPT }]);
  assert.match(thrown.lines.at(-1)!, /-Check does not find the current broker running: no handles$/);
});

for (const [code, state, logged] of [
  [1223, 'declined', 'desktop broker setup: the Windows prompt got no Yes'],
  [1, 'failed', 'desktop broker setup failed (exit 1)'],
  [2, 'failed', 'desktop broker setup failed (exit 2)'],
] as const) {
  test(`a setup that ends with exit ${code} is logged and reported once as ${state}, with no check; the start is not waited for`, () => {
    const r = rig();
    assert.equal(setupBroker(r.deps), true);
    assert.equal(r.reports.length, 0, 'nothing yet: the app goes on while Windows asks');
    r.child.emit('exit', code, null);
    r.child.emit('exit', code, null);
    assert.equal(r.starts.length, 1);
    assert.equal(r.reports.length, 1);
    assert.equal(r.reports[0]!.state, state);
    assert.equal(r.reports[0]!.script, SCRIPT);
    assert.ok(r.lines.at(-1)!.startsWith(logged), r.lines.at(-1));
  });
}

test('a start error (no PowerShell) is a failed setup with its message, never a thrown error', () => {
  const r = rig();
  assert.equal(setupBroker(r.deps), true);
  r.child.emit('error', new Error('spawn powershell.exe ENOENT'));
  r.child.emit('exit', null, null);
  assert.deepEqual(r.reports, [{ state: 'failed', script: SCRIPT }]);
  assert.equal(r.lines.at(-1), 'desktop broker setup failed: spawn powershell.exe ENOENT');
});

test('no setup runs, so nothing is reported, in the background, unpackaged, in test mode or off Windows', () => {
  for (const patch of [{ background: true }, { packaged: false }, { testMode: true }, { platform: 'linux' }]) {
    const r = rig(patch);
    assert.equal(setupBroker(r.deps), false);
    assert.deepEqual(r.reports, []);
  }
});

test('PowerShell 5.1 gets the app\'s environment without an inherited PSModulePath, in any spelling, for setup and check', () => {
  const pwsh7 = 'C:\\Users\\me\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules';
  const r = rig({ env: { SystemRoot: 'C:\\Windows', PSModulePath: pwsh7, psmodulepath: pwsh7, Path: 'C:\\Windows\\System32', ProgramData: 'C:\\ProgramData' } });
  setupBroker(r.deps);
  r.child.emit('exit', 0, null);
  assert.equal(r.starts.length, 2);
  for (const { env } of r.starts) {
    assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === 'psmodulepath'), []);
    assert.equal(env.Path, 'C:\\Windows\\System32', 'everything else stays');
    assert.equal(env.SystemRoot, 'C:\\Windows');
  }
  assert.ok(r.deps.env!.PSModulePath, "the app's own environment is left as it was");
  assert.deepEqual(powershellEnv({ PSMODULEPATH: 'x', TEMP: 't' }), { TEMP: 't' });
});

test('the script starts hidden and never detached: Windows PowerShell without a console runs nothing and exits 0', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const options = spawnOptions(env);
  assert.notEqual(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.env, env);
});

test('the installer answers a No at the Windows prompt with exit 1223 and reads the elevated exit code', () => {
  const script = readFileSync(path.join('resources', 'broker', 'install.ps1'), 'utf8');
  assert.match(script, /\$elevate\.Verb = 'runas'/);
  assert.match(script, /\[Diagnostics\.Process\]::Start\(\$elevate\)/);
  assert.match(script, /NativeErrorCode -eq 1223\) \{ exit 1223 \}/);
  assert.match(script, /\$process\.WaitForExit\(\)\r?\n\s*exit \$process\.ExitCode/);
  assert.match(script, /if \(\$Check\) \{ exit 2 \}/, 'the check the setup confirms with exits 2 for a missing or outdated broker');
});

/** Runs setupBroker with its real start against a stub install.ps1 in a temp app folder; resolves with the report. */
async function realRun(stub: string, env: NodeJS.ProcessEnv): Promise<{ report: BrokerSetup; lines: string[]; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autark-broker-setup-'));
  const broker = path.join(dir, 'resources', 'app.asar.unpacked', 'resources', 'broker');
  mkdirSync(broker, { recursive: true });
  writeFileSync(path.join(broker, 'install.ps1'), stub);
  const lines: string[] = [];
  const report = await new Promise<BrokerSetup>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no report within 60 s: ${lines.join(' | ')}`)), 60_000); // also keeps the loop alive: the children are unref'd
    setupBroker({
      platform: 'win32', packaged: true, testMode: false, background: false, root: path.join(dir, 'resources', 'app.asar'), exe: 'C:\\Autark\\Autark.exe',
      env, log: (line) => lines.push(line), report: (setup) => { clearTimeout(timeout); resolve(setup); },
    });
  });
  return { report, lines, dir: broker };
}

test('on Windows, the real start runs the script, confirms it with -Check and hands PowerShell no PSModulePath', { skip: process.platform !== 'win32' ? 'powershell.exe' : undefined, timeout: 120_000 }, async () => {
  const env = { ...powershellEnv(process.env), PSModulePath: 'C:\\sentinel-pwsh7\\Modules' };
  const installs = [
    'param([switch]$Check, [string]$AppExe)',
    '$marker = Join-Path $PSScriptRoot "ran.txt"',
    'if ($Check) { if (Test-Path -LiteralPath $marker) { exit 0 } else { exit 2 } }',
    'Set-Content -LiteralPath $marker -Value "$AppExe|$env:PSModulePath"',
    'exit 0',
  ].join('\r\n');
  const good = await realRun(installs, env);
  try {
    assert.ok(existsSync(path.join(good.dir, 'ran.txt')), `the script really ran (${good.lines.join(' | ')})`);
    const [appExe, modulePath] = readFileSync(path.join(good.dir, 'ran.txt'), 'utf8').trim().split('|');
    assert.equal(appExe, 'C:\\Autark\\Autark.exe');
    assert.doesNotMatch(modulePath!, /sentinel-pwsh7/i, 'PowerShell 5.1 built its own module path');
    assert.deepEqual(good.report, { state: 'installed', script: path.join(good.dir, 'install.ps1') });
  } finally { rmSync(path.dirname(path.dirname(path.dirname(path.dirname(good.dir)))), { recursive: true, force: true }); }

  const noop = await realRun('param([switch]$Check, [string]$AppExe)\r\nif ($Check) { exit 2 }\r\nexit 0', env);
  try {
    assert.deepEqual(noop.report, { state: 'failed', code: 2, script: path.join(noop.dir, 'install.ps1') }, 'an exit 0 without a broker is no installation');
  } finally { rmSync(path.dirname(path.dirname(path.dirname(path.dirname(noop.dir)))), { recursive: true, force: true }); }
});
