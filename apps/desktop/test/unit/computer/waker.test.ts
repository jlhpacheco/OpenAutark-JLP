// Wake helper supervisor of the broker (23.11.2026, 0.3.19): the pure logic of resources/broker/Waker.cs (registration
// validation, WakerPolicy.Decide, backoff, command-line quoting, environment block) in C#, compiled in memory with the
// Framework csc (waker-cs/run.ps1 + WakerTests.cs), and the source rules: the helper starts as the PERSON (WTSQueryUserToken,
// CreateEnvironmentBlock), never with the service's SYSTEM token, never the app itself, always with the sleeper script.
// No service, no real token, no process is started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const code = (file: string) => readFileSync(path.join('resources', 'broker', file), 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

test('the waker starts the helper as the person: WTSQueryUserToken + CreateEnvironmentBlock + CreateProcessAsUser, never the SYSTEM start', () => {
  const waker = code('Waker.cs');
  assert.match(waker, /WTSQueryUserToken/);
  assert.match(waker, /CreateEnvironmentBlock/);
  assert.match(waker, /DestroyEnvironmentBlock/);
  assert.match(waker, /CreateProcessAsUser/);
  assert.match(waker, /CREATE_UNICODE_ENVIRONMENT/);
  assert.match(waker, /ELECTRON_RUN_AS_NODE/);
  assert.match(waker, /SHGetKnownFolderPath/);
  assert.match(waker, /Impersonate\(\)/);
  assert.match(waker, /context\.Undo\(\)/);
  assert.match(waker, /winsta0\\\\default/);
  assert.doesNotMatch(waker, /StartInSession/, 'the helper never runs with the service\'s LocalSystem token');
  assert.doesNotMatch(waker, /OpenProcessToken\(GetCurrentProcess/, 'no own SYSTEM token is duplicated');
  assert.doesNotMatch(waker, /winlogon/i);
});

test('the waker never starts the app: always the sleeper script, never --background', () => {
  const waker = code('Waker.cs');
  assert.doesNotMatch(waker, /--background/);
  assert.match(waker, /WakerCommandLine\.Build\(registration\.Exe, registration\.Script, registration\.WakeFile, registration\.Args\)/);
  const broker = code('Broker.cs');
  assert.doesNotMatch(broker, /--background/);
  assert.match(broker, /new WakerSupervisor\(userSid\)/);
  assert.match(broker, /waker\.Start\(\)/);
  assert.match(broker, /waker\.Stop\(\)/);
  assert.match(broker, /waker\.Poke\(\)/);
});

test('the waker holds no network connection and no key', () => {
  const waker = code('Waker.cs');
  assert.doesNotMatch(waker, /System\.Net|Socket|NamedPipe|HttpClient|WebClient/);
  assert.doesNotMatch(waker, /broker\.key/);
});

test('build.ps1 compiles Waker.cs and prints its hash', () => {
  const build = readFileSync(path.join('resources', 'broker', 'build.ps1'), 'utf8');
  assert.equal((build.match(/'Waker\.cs'/g) ?? []).length, 2);
});

test('the waker\'s logic (C#, Waker.cs): registrations, decision, backoff, quoting, environment block', { skip: process.platform !== 'win32' || !existsSync(csc) }, () => {
  // Compiled in memory and run inside PowerShell (waker-cs/run.ps1): a fresh unsigned test exe may be held by Smart App Control.
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join('test', 'unit', 'computer', 'waker-cs', 'run.ps1')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /^FAIL /m, run.stdout);
  assert.match(run.stdout, /ALL PASS/);
  assert.ok((run.stdout.match(/^PASS /gm) ?? []).length >= 40, run.stdout);
});
