// Owns: start nonblocking broker reconciliation at each interactive packaged Windows launch, and how it ended
// (F03, 16.11.2026: its exit code – 0 installed, 1223 the Windows prompt got no Yes, anything else failed – is logged and
// reported, so main hands it to the runtime as 'broker.setup' and the computer tools can say why the secure desktop is out of reach).
// The script verifies protected image/hash, key ACL and service state; only a mismatch requests UAC.
// 0.3.19 (23.11.2026): Windows PowerShell 5.1 started without a console (spawn's detached: true, DETACHED_PROCESS) exits 0
// at once without running the script, so 0.3.9–0.3.18 reported "installed" while the old broker kept running. The script
// now starts hidden but attached (windowsHide alone gives it a console without a window), and an exit 0 only counts once a
// read-only `install.ps1 -Check` confirms the broker afterwards. PowerShell 5.1 gets no inherited PSModulePath: one from a
// PowerShell 7 parent can hide its own Microsoft.PowerShell.Utility (Get-FileHash), and without it 5.1 takes its default.
// Never: treats key existence or an unconfirmed exit 0 as proof of installation, changes the service itself, waits for the
// script, starts PowerShell detached, or asks in background/test mode.

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EventMap } from '../shared/api/events.ts';

export type BrokerSetup = EventMap['broker.setup'];

/** install.ps1's exit code when the person answered the Windows prompt with No (ERROR_CANCELLED). */
export const DECLINED_EXIT = 1223;

/** The started script, as far as its end is concerned (a ChildProcess). */
export interface BrokerChild {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** How the setup ended, from the script's exit code (null: it ended without one, e.g. killed). */
export function setupResult(code: number | null, script: string): BrokerSetup {
  if (code === 0) return { state: 'installed', script };
  if (code === DECLINED_EXIT) return { state: 'declined', script };
  return { state: 'failed', ...(code !== null ? { code } : {}), script };
}

const SETUP_LOG: Record<BrokerSetup['state'], string> = {
  installed: 'desktop broker setup: installed and running',
  declined: 'desktop broker setup: the Windows prompt got no Yes – the secure desktop stays out of reach until the next start or a new run of install.ps1',
  failed: 'desktop broker setup failed',
};

export interface BrokerSetupDeps {
  platform: string;
  packaged: boolean;
  testMode: boolean;
  background: boolean;
  /** The app root (…\resources\app.asar when packaged); the script lives unpacked beside it. */
  root: string;
  /** Autark.exe (its firewall rule). */
  exe: string;
  env?: NodeJS.ProcessEnv;
  exists?(file: string): boolean;
  /** Starts the script hidden and unwaited; the child it returns tells how it ended. */
  start?(command: string, args: string[], env: NodeJS.ProcessEnv): BrokerChild | undefined;
  log?(line: string): void;
  /** How the setup ended (main forwards it to the runtime as 'broker.setup'). */
  report?(setup: BrokerSetup): void;
}

/** The environment Windows PowerShell 5.1 gets: the app's own, without PSModulePath in any spelling (5.1 then takes its default). */
export function powershellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() !== 'psmodulepath') out[key] = value;
  return out;
}

/** How the script is spawned: hidden, never waited for, and never detached (5.1 without a console runs nothing and exits 0). */
export function spawnOptions(env: NodeJS.ProcessEnv): SpawnOptions {
  return { stdio: 'ignore', windowsHide: true, env };
}

/** True when the broker's setup was started now. */
export function setupBroker(deps: BrokerSetupDeps): boolean {
  if (deps.platform !== 'win32' || !deps.packaged || deps.testMode || deps.background) return false;
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;
  // The script reconciles image hash, protected path and running service before deciding whether UAC is needed.
  // A key alone cannot prove migration or an executable update completed.
  const script = path.win32.join(deps.root, 'resources', 'broker', 'install.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (!exists(script)) return false;
  const powershell = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
  const childEnv = powershellEnv(env);
  const start = deps.start ?? startHidden;
  let child: BrokerChild | undefined;
  try {
    child = start(powershell, [...base, '-AppExe', deps.exe], childEnv);
  } catch { return false; }
  deps.log?.('desktop broker reconciliation started; Windows elevation is requested if installation or repair is needed');
  let ended = false;
  const end = (setup: BrokerSetup, detail?: string) => {
    if (ended) return;
    ended = true;
    deps.log?.(`${SETUP_LOG[setup.state]}${setup.code !== undefined ? ` (exit ${setup.code})` : ''}${detail ? `: ${detail}` : ''}`);
    deps.report?.(setup);
  };
  // An exit 0 is only believed once the read-only check finds the broker current and running (exit 0); its exit 2 means
  // the reconciliation did not happen, whatever the first process said.
  const confirm = () => {
    let check: BrokerChild | undefined;
    const unconfirmed = 'install.ps1 ended with 0, but its -Check does not find the current broker running';
    try { check = start(powershell, [...base, '-Check'], childEnv); } catch (error) { end({ state: 'failed', script }, `${unconfirmed}: ${(error as Error).message}`); return; }
    if (!check) { end({ state: 'failed', script }, unconfirmed); return; }
    check.on('exit', (code) => end(code === 0 ? setupResult(0, script) : { state: 'failed', ...(code !== null ? { code } : {}), script }, code === 0 ? undefined : unconfirmed));
    check.on('error', (error) => end({ state: 'failed', script }, `${unconfirmed}: ${error.message}`));
  };
  let exited = false;
  child?.on('exit', (code) => {
    if (ended || exited) return;
    exited = true;
    if (code === 0) confirm();
    else end(setupResult(code, script));
  });
  child?.on('error', (error) => { if (!exited) end({ state: 'failed', script }, error.message); }); // also keeps a spawn error from throwing
  return true;
}

/** Hidden and attached to a console of its own without a window; the app never waits for it, but hears its exit while it runs. */
function startHidden(command: string, args: string[], env: NodeJS.ProcessEnv): BrokerChild {
  const child = spawn(command, args, spawnOptions(env));
  child.unref();
  return child;
}
