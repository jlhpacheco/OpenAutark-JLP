// The Windows/Linux relaunch helper (src/main/updates/install-helper.ts): the cmd script and its launch values, the sh
// script and its positional arguments, the quitAndInstall override (helper started → quit; failed → the library's own
// call), one real run of the sh script where a shell exists (a stand-in AppImage, no install), and the install lock
// (one install at a time on a PC: a second company's helper waits and starts its company, really run in a test folder).
// Owns: these assertions only. Never: runs an installer, starts Autark or touches the real updater cache.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LINUX_HELPER_SCRIPT, LOCK_NAME, LOCK_STALE_MS, QUIT_MS, WAIT_SECONDS, WINDOWS_HELPER_SCRIPT, helperLaunch, installWithHelper, linuxHelper, spawnHelper, takeInstallLock, windowsHelper,
  type HelperLaunch, type InstallHelperDeps,
} from '../../../src/main/updates/install-helper.ts';
import { INSTALL_WATCHDOG_MS } from '../../../src/main/updates/update-service.ts';
import type { Updater } from '../../../src/main/updates/update-service.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-helper-'));
// Windows can still hold the fixture cwd briefly after the detached helper's last log line.
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const INSTALLER = 'C:\\Users\\Jürgen Ä\\AppData\\Local\\autark-updater\\pending\\autark-windows-x64.exe';
const EXE = 'C:\\Users\\Jürgen Ä\\AppData\\Local\\Programs\\Autark\\Autark.exe';
const LOG = 'C:\\Users\\Jürgen Ä\\AppData\\Roaming\\Autark\\logs\\update-helper.log';

test('Windows: a plain-ASCII cmd script beside the installer, values through the environment, CRLF lines', () => {
  const launch = windowsHelper({ pid: 4242, installer: INSTALLER, exe: EXE, logFile: LOG });
  const dir = 'C:\\Users\\Jürgen Ä\\AppData\\Local\\autark-updater\\pending';
  assert.equal(launch.command, 'cmd.exe');
  assert.deepEqual(launch.args, ['/d', '/c', 'start "" /b cmd.exe /d /c .\\update-helper.cmd'], 'a hidden cmd hands over; no path in the line');
  assert.equal(launch.verbatim, true);
  assert.equal(launch.handoff, true, 'not detached: a detached cmd has no console and its tasklist | find never ends');
  assert.equal(launch.cwd, dir, 'never the install folder, which the uninstaller removes');
  assert.deepEqual(launch.env, {
    AUTARK_UPDATE_PID: '4242', AUTARK_UPDATE_INSTALLER: INSTALLER, AUTARK_UPDATE_EXE: EXE,
    AUTARK_UPDATE_DIR: 'C:\\Users\\Jürgen Ä\\AppData\\Local\\Programs\\Autark', AUTARK_UPDATE_LOG: LOG, AUTARK_UPDATE_ARGS: '',
    AUTARK_UPDATE_LOCK: path.win32.join(os.tmpdir(), LOCK_NAME),
  });
  assert.equal(launch.script?.file, `${dir}\\update-helper.cmd`);
  const text = launch.script!.text;
  assert.match(text, /^@echo off\r\n/);
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'every line ends with CRLF');
  assert.equal(/^[\x00-\x7f]*$/.test(text), true, 'no path inside: the script is ASCII');
  assert.match(text, /start "" \/wait "%AUTARK_UPDATE_INSTALLER%" --updated \/S\r\n/);
  assert.doesNotMatch(text, /--force-run/, 'the helper starts the app, not NSIS through Explorer');
  assert.match(text, /start "" \/D "%AUTARK_UPDATE_DIR%" "%AUTARK_UPDATE_EXE%" --updated %AUTARK_UPDATE_ARGS%\r\n/);
  assert.match(text, /"%SystemRoot%\\System32\\tasklist\.exe" \/FI "PID eq %AUTARK_UPDATE_PID%"/);
  assert.match(text, /\| "%SystemRoot%\\System32\\find\.exe" /, 'never a find from PATH (Git\'s find matches nothing)');
  assert.match(text, />>"%AUTARK_UPDATE_LOG%" echo/);
  assert.doesNotMatch(text, /timeout /, 'timeout fails without a console input; ping waits instead');
  assert.equal(WINDOWS_HELPER_SCRIPT.includes('\r'), false);
});

test('F25: the company that pressed Update starts again – only its own --company flag reaches the scripts', () => {
  assert.equal(windowsHelper({ pid: 1, installer: INSTALLER, exe: EXE, logFile: LOG, args: ['--company=company-2'] }).env.AUTARK_UPDATE_ARGS, '--company=company-2');
  assert.equal(windowsHelper({ pid: 1, installer: INSTALLER, exe: EXE, logFile: LOG, args: ['--company=x&calc', '--background'] }).env.AUTARK_UPDATE_ARGS, '', 'nothing that is no company flag lands in the cmd line');
  assert.equal(linuxHelper({ pid: 1, downloaded: '/a', appImage: '/b', logFile: '/c', args: ['--company=company-3'] }).args.at(-1), '--company=company-3');
  assert.match(LINUX_HELPER_SCRIPT, /if \[ -n "\$company" \]; then exec "\$target" --updated "\$company"; fi/);
});

test('Windows: a differential package goes along as --package-file', () => {
  const launch = windowsHelper({ pid: 1, installer: INSTALLER, packageFile: 'C:\\cache\\package.7z', exe: EXE, logFile: LOG });
  assert.equal(launch.env.AUTARK_UPDATE_PACKAGE, 'C:\\cache\\package.7z');
  assert.match(launch.script!.text, /"--package-file=%AUTARK_UPDATE_PACKAGE%"/);
  assert.equal('AUTARK_UPDATE_PACKAGE' in windowsHelper({ pid: 1, installer: INSTALLER, exe: EXE, logFile: LOG }).env, false);
});

test('Linux: sh with positional arguments, mv -f and chmod, then exec with --updated', () => {
  const launch = linuxHelper({ pid: 77, downloaded: '/home/a b/.cache/autark-updater/pending/autark-linux-x64.AppImage', appImage: '/home/a b/Apps/autark-linux-x64.AppImage', logFile: '/home/a b/.config/Autark/logs/update-helper.log' });
  assert.equal(launch.command, '/bin/sh');
  assert.deepEqual(launch.args.slice(0, 3), ['-c', LINUX_HELPER_SCRIPT, 'autark-update']);
  assert.deepEqual(launch.args.slice(3), ['77', '/home/a b/.cache/autark-updater/pending/autark-linux-x64.AppImage', '/home/a b/Apps/autark-linux-x64.AppImage', '/home/a b/.config/Autark/logs/update-helper.log', '']);
  assert.equal(launch.cwd, '/home/a b/Apps');
  assert.equal(launch.verbatim, false);
  assert.equal(launch.handoff, false);
  assert.match(LINUX_HELPER_SCRIPT, /mv -f "\$downloaded" "\$target"/);
  assert.match(LINUX_HELPER_SCRIPT, /chmod \+x "\$target"/);
  assert.match(LINUX_HELPER_SCRIPT, /exec "\$target" --updated/);
});

function fakeUpdater(file: string | null): Updater & { original: Array<[boolean, boolean]> } {
  const original: Array<[boolean, boolean]> = [];
  return {
    autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false, logger: null,
    on: () => undefined,
    checkForUpdates: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve(null),
    quitAndInstall(silent: boolean, run: boolean) { original.push([silent, run]); },
    installerPath: file,
    downloadedUpdateHelper: { packageFile: null },
    original,
  } as Updater & { original: Array<[boolean, boolean]> };
}

function deps(patch: Partial<InstallHelperDeps> & { outcome?: 'started' | 'failed' | 'throws' | 'silent' } = {}) {
  const record = { quits: 0, launches: [] as HelperLaunch[], lines: [] as string[], ends: [] as Array<() => void> };
  const value: InstallHelperDeps = {
    platform: 'win32', pid: 9, exe: EXE, logFile: LOG,
    spawn: (launch, events) => {
      record.launches.push(launch);
      record.ends.push(() => events.ended());
      if (patch.outcome === 'throws') throw Object.assign(new Error('nope'), { code: 'EINVAL' });
      if (patch.outcome === 'failed') events.failed(Object.assign(new Error('blocked'), { code: 'EACCES' }));
      else if (patch.outcome !== 'silent') events.started();
    },
    quit: () => { record.quits += 1; },
    log: line => record.lines.push(line),
    ...patch,
  };
  return { value, record };
}

test('quitAndInstall: the started helper quits the app; the library\'s own install is not called', () => {
  const updater = fakeUpdater(INSTALLER);
  const { value, record } = deps();
  installWithHelper(updater, value);
  updater.quitAndInstall(true, true);
  assert.equal(record.quits, 1);
  assert.equal(record.launches.length, 1);
  assert.deepEqual(updater.original, []);
  updater.quitAndInstall(true, true);
  assert.equal(record.launches.length, 1, 'the helper still lives and waits: a second click only quits again');
  assert.equal(record.quits, 2);
  record.ends[0]!(); // the helper gave up (the app kept running past its wait) and exited
  updater.quitAndInstall(true, true);
  assert.equal(record.launches.length, 2, 'after the helper ended, the next click starts a new one');
  assert.equal(record.quits, 3);
});

test('19.11.2026: a quit for the install that does not end the app ends it hard before the watchdog resumes work', async () => {
  assert.ok(QUIT_MS < INSTALL_WATCHDOG_MS, 'the app ends before update-service.ts would resume it');
  assert.ok(QUIT_MS < WAIT_SECONDS * 1000, 'and before the helper gives up');
  const updater = fakeUpdater(INSTALLER);
  let exits = 0;
  const { value, record } = deps({ exit: () => { exits += 1; } });
  const timers: Array<() => void> = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => { timers.push(fn); return { unref() {} }; }) as unknown as typeof setTimeout;
  try { installWithHelper(updater, value); updater.quitAndInstall(true, true); } finally { globalThis.setTimeout = real; }
  assert.equal(record.quits, 1);
  assert.equal(exits, 0, 'first the ordinary quit');
  timers.forEach((fn) => fn());
  assert.equal(exits, 1, 'then a hard end – the process is gone in a quit that ran, so this only fires when it hangs');
  assert.ok(record.lines.includes('the quit did not end the app; ending it for the install'));
});

test('a helper never installs over a resumed app: it waits longer than the install watchdog, then gives up', () => {
  assert.ok(WAIT_SECONDS * 1000 > INSTALL_WATCHDOG_MS + 15_000, 'longer than the watchdog plus a slow graceful quit');
  const text = WINDOWS_HELPER_SCRIPT;
  const late = text.slice(text.indexOf(':late'), text.indexOf(':gone'));
  assert.match(late, /update left for the next try"\nexit \/b 3\n$/, 'Windows: no installer (and no taskkill) after the wait');
  assert.match(LINUX_HELPER_SCRIPT, new RegExp(`-gt ${WAIT_SECONDS * 2} \\]; then note "the app still runs after ${WAIT_SECONDS} s; update left for the next try"; exit 3; fi`));
});

test('quitAndInstall: a helper that cannot start falls back to the library, which relaunches as before', () => {
  for (const outcome of ['failed', 'throws'] as const) {
    const updater = fakeUpdater(INSTALLER);
    const { value, record } = deps({ outcome });
    installWithHelper(updater, value);
    updater.quitAndInstall(true, true);
    assert.equal(record.quits, 0, outcome);
    assert.deepEqual(updater.original, [[true, true]], outcome);
    assert.match(record.lines.at(-1) ?? '', outcome === 'failed' ? /\(EACCES\)/ : /\(EINVAL\)/);
    updater.quitAndInstall(true, true);
    assert.equal(record.launches.length, 2, `${outcome}: the next click tries the helper again`);
  }
});

test('the library\'s own path where the helper has nothing to work with', () => {
  assert.equal(helperLaunch(fakeUpdater(null), { platform: 'win32', pid: 1, exe: EXE, logFile: LOG }), 'no downloaded update');
  assert.equal(helperLaunch(fakeUpdater('/tmp/x.AppImage'), { platform: 'linux', pid: 1, exe: '/opt/autark', logFile: '/l' }), 'not started from an AppImage');
  assert.equal(helperLaunch(fakeUpdater('/tmp/x.zip'), { platform: 'darwin', pid: 1, exe: '/a', logFile: '/l' }), 'not Windows or Linux');
  const machineWide = Object.assign(fakeUpdater(INSTALLER), { downloadedUpdateHelper: { packageFile: null, downloadedFileInfo: { isAdminRightsRequired: true } } });
  assert.equal(helperLaunch(machineWide, { platform: 'win32', pid: 1, exe: EXE, logFile: LOG }), 'the install needs administrator rights');
  const updater = fakeUpdater(null);
  const { value, record } = deps();
  installWithHelper(updater, value);
  updater.quitAndInstall(true, true);
  assert.deepEqual(updater.original, [[true, true]]);
  assert.equal(record.launches.length, 0);
});

test('Windows helper, really run through spawnHelper: waits for the process, then runs the installer', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  // Before 08.11.2026 the helper ran detached without a console; its `find` waited for keyboard input forever.
  const dir = path.join(tmp, 'win run Ä');
  mkdirSync(dir);
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const installer = path.join(dir, 'autark-windows-x64.exe');
  copyFileSync(path.join(system32, 'whoami.exe'), installer); // a stand-in: rejects --updated /S with exit code 1
  const logFile = path.join(dir, 'update-helper.log');
  const app = spawn(path.join(system32, 'PING.EXE'), ['-n', '4', '127.0.0.1'], { stdio: 'ignore', windowsHide: true }); // "the app", about 3 s
  let appEnded = false;
  app.once('exit', () => { appEnded = true; });
  const lock = path.join(dir, LOCK_NAME);
  const launch = windowsHelper({ pid: app.pid!, installer, exe: path.join(dir, 'missing', 'Autark.exe'), logFile, lock });
  process.env.AUTARK_UPDATE_AFTER = '1'; // what an app started by a waiting helper carries: it must not reach this helper
  try {
    await new Promise<void>((resolve, reject) => spawnHelper(launch, dir, { started: resolve, failed: reject, ended: () => undefined }));
  } finally {
    delete process.env.AUTARK_UPDATE_AFTER;
  }
  assert.equal(existsSync(lock), true, 'this company holds the install lock while its helper waits and installs');
  const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split(/\r?\n/) : []);
  let sawEnd = false;
  for (let i = 0; i < 120 && read().length < 4; i++) {
    if (!sawEnd && read().some(line => line.includes('app ended'))) { sawEnd = true; assert.equal(appEnded, true, 'the installer starts only after the app ended'); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const lines = read();
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.match(lines[0], new RegExp(`waiting for the app \\(pid ${app.pid}\\) to end$`));
  assert.match(lines[1], /app ended; installer starts$/);
  assert.match(lines[2], /installer ended \(exit code 1\)$/);
  assert.match(lines[3], /the app file is missing after the install; nothing to start$/);
  assert.equal(existsSync(lock), false, 'freed once the installer ended');
});

test('one install at a time: the first company takes the lock, a second does not, a stale one is taken over', () => {
  const lock = path.join(tmp, 'lock unit', LOCK_NAME);
  mkdirSync(path.dirname(lock));
  assert.equal(takeInstallLock(lock), true);
  assert.equal(takeInstallLock(lock), false, 'another company\'s helper installs');
  assert.equal(takeInstallLock(lock, Date.now() + LOCK_STALE_MS + 1000), true, 'left by a helper that never ended');
  assert.equal(existsSync(lock), true);
});

test('a helper that does not start frees the lock it took; another company\'s lock stays', async () => {
  const dir = path.join(tmp, 'lock spawn');
  mkdirSync(dir);
  const lock = path.join(dir, LOCK_NAME);
  const launch: HelperLaunch = { command: path.join(dir, 'no-such-helper.exe'), args: [], env: { AUTARK_UPDATE_LOCK: lock }, cwd: dir, verbatim: false, handoff: false };
  const attempt = () => new Promise<unknown>((resolve) => {
    try { spawnHelper(launch, dir, { started: () => resolve('started'), failed: resolve, ended: () => undefined }); } catch (error) { resolve(error); }
  });
  assert.notEqual(await attempt(), 'started');
  assert.equal(existsSync(lock), false, 'free for the next try');
  mkdirSync(lock); // another company's helper holds it
  assert.notEqual(await attempt(), 'started');
  assert.equal(existsSync(lock), true, 'not this helper\'s to free');
});

test('one install at a time, really run: a second company\'s helper runs no installer, waits for the lock, then starts its company', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  // Review 16.11.2026: NSIS runs one installer; a second one quits at once, and its helper started the app mid-install.
  const dir = path.join(tmp, 'win after Ä');
  mkdirSync(dir);
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const installer = path.join(dir, 'autark-windows-x64.exe');
  copyFileSync(path.join(system32, 'whoami.exe'), installer);
  const logFile = path.join(dir, 'update-helper.log');
  const lock = path.join(dir, LOCK_NAME);
  mkdirSync(lock); // the first company's helper installs right now
  const app = spawn(path.join(system32, 'PING.EXE'), ['-n', '2', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  const launch = windowsHelper({ pid: app.pid!, installer, exe: path.join(dir, 'missing', 'Autark.exe'), logFile, lock, args: ['--company=company-2'] });
  await new Promise<void>((resolve, reject) => spawnHelper(launch, dir, { started: resolve, failed: reject, ended: () => undefined }));
  const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split(/\r?\n/) : []);
  const until = async (count: number) => { for (let i = 0; i < 120 && read().length < count; i++) await new Promise(resolve => setTimeout(resolve, 250)); };
  await until(2);
  assert.match(read()[1] ?? '', /app ended; another company installs this update, this one starts after it$/);
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(read().length, 2, 'it waits while the other install holds the lock');
  rmSync(lock, { recursive: true }); // the other install ended
  await until(3);
  const lines = read();
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[2], /nothing to start$/, 'it went on to start its own company');
  assert.equal(lines.some(line => line.includes('installer')), false, 'no second installer');
});

const shell = spawnSync('sh', ['-c', 'exit 0']).status === 0;

test('Linux script, really run: waits for a gone process, replaces the AppImage, starts it with --updated', { skip: !shell && 'no sh on this PC' }, () => {
  const dir = path.join(tmp, 'linux run').replace(/\\/g, '/'); // Git's sh on Windows takes C:/… paths
  mkdirSync(dir);
  const target = `${dir}/autark-linux-x64.AppImage`;
  const downloaded = `${dir}/pending.AppImage`;
  const out = `${dir}/started.txt`;
  const log = `${dir}/update-helper.log`;
  writeFileSync(target, `#!/bin/sh\necho old > "${out}"\n`);
  writeFileSync(downloaded, `#!/bin/sh\necho "new $*" > "${out}"\n`);
  const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim(); // a process that already ended
  const launch = linuxHelper({ pid: Number(gone), downloaded, appImage: target, logFile: log });
  const run = spawnSync('sh', launch.args, { cwd: dir, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr.toString());
  assert.equal(existsSync(downloaded), false);
  assert.equal(readFileSync(out, 'utf8').trim(), 'new --updated');
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /replaced; new version starts$/);
});

test('F25, Linux script really run: another company starts again as itself', { skip: !shell && 'no sh on this PC' }, () => {
  const dir = path.join(tmp, 'linux company').replace(/\\/g, '/');
  mkdirSync(dir);
  const target = `${dir}/autark.AppImage`;
  const downloaded = `${dir}/pending.AppImage`;
  const out = `${dir}/started.txt`;
  writeFileSync(target, '#!/bin/sh\necho old\n');
  writeFileSync(downloaded, `#!/bin/sh\necho "new $*" > "${out}"\n`);
  const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
  const launch = linuxHelper({ pid: Number(gone), downloaded, appImage: target, logFile: `${dir}/helper.log`, args: ['--company=company-2'] });
  const run = spawnSync('sh', launch.args, { cwd: dir, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr.toString());
  assert.equal(readFileSync(out, 'utf8').trim(), 'new --updated --company=company-2');
});
