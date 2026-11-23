import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.env.SECURE_GATE_TREE ?? '.');
const file = (name) => path.join(root, name);
const load = (name) => import(pathToFileURL(file(name)).href);
const log = { debug() {}, info() {}, warn() {}, error() {} };

test('Windows helper protocol: changes of desktop are observed per request and denied only in Secure', { skip: process.platform !== 'win32' }, () => {
  const original = readFileSync(file('resources/computer/windows-helper.ps1'), 'utf8').replaceAll('\r\n', '\n');
  const prefix = original.slice(0, original.indexOf('# ---------------------------------------------------------------- optional OCR'));
  const loop = original.slice(original.indexOf('# ---------------------------------------------------------------- protocol loop'));
  assert.ok(prefix.includes('Add-Type -TypeDefinition') && loop.includes('$reader.ReadLine()'));
  // Compile the actual C# including P/Invoke signatures. Substitute only observations and intercepted
  // actions in the protocol loop. This test never calls user32 or sends real input / captures images.
  assert.ok(loop.includes('$out = [WorkforceHelper.Dispatcher]::Handle($request)'));
  const script = prefix.replace('$dpiAware = [WorkforceHelper.Native]::InitDpi()', '$dpiAware = $true')
    + [
      '$DefaultDesktopOnly = $env:SECURE_GATE_TEST_MODE -eq "secure"',
      'function Require-TestDefault {',
      "  $desktop = [WorkforceHelper.Args]::Get($request, 'syntheticDesktop')",
      "  if ($script:dispatched) { $desktop = [WorkforceHelper.Args]::Get($request, 'syntheticAfter') }",
      "  $receivesInput = [WorkforceHelper.Args]::Get($request, 'syntheticInput')",
      "  $ordinaryToken = [WorkforceHelper.Args]::Get($request, 'syntheticOrdinary')",
      '  if (-not [WorkforceHelper.SecureDesktop]::Allows($desktop, $receivesInput, $ordinaryToken)) {',
      '    throw (New-Object WorkforceHelper.HelperException("protected_desktop", "Protected"))',
      '  }',
      '}',
    ].join('\n') + '\n'
    + loop.replaceAll('[WorkforceHelper.SecureDesktop]::RequireDefault()', 'Require-TestDefault')
      .replace('$id = [WorkforceHelper.Args]::Get($request, \'id\')', '$id = [WorkforceHelper.Args]::Get($request, \'id\'); $script:dispatched = $false')
      .replace('$out = [WorkforceHelper.Dispatcher]::Handle($request)', '$script:dispatched = $true; $out = [WorkforceHelper.Dispatcher]::Ok($id, "mock dispatched")')
      .replace('$out = [WorkforceHelper.Dispatcher]::Ok($id, (Invoke-Ocr $opArgs))', '$script:dispatched = $true; $out = [WorkforceHelper.Dispatcher]::Ok($id, "mock dispatched")');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autark-gate-unit-'));
  try {
    const runner = path.join(dir, 'protocol-fixture.ps1');
    writeFileSync(runner, '\ufeff' + script);
    const states = ['Default', 'Winlogon', 'UAC', null, 'default', 'Default', 'Default', 'Default'];
    const requests = ['screenshot', 'click', 'ocr', 'type'].flatMap((op) => states.map((state, i) => ({
      op, syntheticDesktop: state, syntheticAfter: i === 7 ? 'Winlogon' : state,
      syntheticInput: i !== 5, syntheticOrdinary: i !== 6,
      // Untrusted request args have no say in the launched process mode.
      args: { mode: 'trust', DefaultDesktopOnly: false },
    })));
    for (const mode of ['trust', 'secure']) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner], {
        input: requests.map((req, index) => JSON.stringify({id: index + 1, ...req})).join('\n') + '\n',
        env: { ...process.env, SECURE_GATE_TEST_MODE: mode }, encoding: 'utf8', timeout: 120_000,
      });
      assert.equal(result.error?.message, undefined, result.stderr);
      assert.equal(result.status, 0, result.stderr);
      const [ready, ...answers] = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(ready.ready, true);
      assert.equal(answers.length, requests.length, result.stderr);
      requests.forEach((req, i) => {
        const expected = mode === 'trust' || (
          req.syntheticDesktop === 'Default' && req.syntheticInput && req.syntheticOrdinary &&
          (!['screenshot', 'ocr'].includes(req.op) || req.syntheticAfter === 'Default')
        );
        assert.deepEqual(answers[i], expected
          ? { id: i + 1, ok: true, result: 'mock dispatched' }
          : { id: i + 1, ok: false, error: { code: 'protected_desktop', message: 'Protected' } },
        mode + ' / ' + req.op + ' / ' + JSON.stringify(req));
      });
    }
  } finally {
    rmSync(path.join(dir, 'protocol-fixture.ps1'), { force: true });
    rmdirSync(dir);
  }
});

test('Secure starts the ordinary helper with a process-level desktop guard, not the broker', async () => {
  const { createHelper } = await load('src/runtime/computer/drivers.ts');
  const starts = [];
  const stop = new Error('intercept before spawning');
  const helper = createHelper('win32', {
    supervisor: { spawn: (input) => { starts.push(input); throw stop; } }, resourcesDir: 'resources', log, unpacked: (p) => p,
    broker: { reachable: () => { throw new Error('Secure consulted the broker'); } }, secureWindows: true,
  });
  await assert.rejects(helper.call('screenshot'), stop);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].command, 'powershell.exe');
  assert.ok(starts[0].args.includes('-DefaultDesktopOnly'));
});

test('Secure screenshot and preview never fall back to host capture; Trust still does', async () => {
  const { ComputerService } = await load('src/runtime/computer/service.ts');
  const { WorkforceError } = await load('src/shared/errors.ts');
  let mode = 'secure';
  let hostCalls = 0;
  const unavailable = new WorkforceError('unavailable', 'helper down');
  const helper = { running: () => true, dispose: async () => {}, call: async (op) => { if (op !== 'config') throw unavailable; } };
  const service = new ComputerService({
    platform: 'win32', helper, host: { capture: { screenshot: async () => {
      hostCalls++; return { data: Buffer.from([0]), width: 1, height: 1, mime: 'image/jpeg' };
    }}},
    services: () => ({ security: { current: () => ({ mode, computer: 'yes' }) } }),
    log,
  });
  await assert.rejects(service.screenshot(), unavailable);
  await assert.rejects(service.preview({}), unavailable);
  assert.equal(hostCalls, 0);
  mode = 'trust';
  assert.equal((await service.screenshot()).source, 'host');
  assert.match((await service.preview({})).dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(hostCalls, 2);
  await service.dispose();
});

