// Official installers for the engine CLIs, so a PC without Node.js gets a working CLI (B-051 L1).
// Claude Code: its official native installer (code.claude.com/docs/en/setup, ported from legacy
// accounts.cjs). Codex: its official standalone installer first (chatgpt.com/codex/install.ps1 on
// Windows → %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe, install.sh elsewhere → ~/.local/bin;
// CODEX_NON_INTERACTIVE=1 and redirected stdio answer every prompt "no"); `npm i -g @openai/codex@latest` only
// when that route failed and npm exists – the same command updates a Codex in npm's global folder (engines/cli-update.ts,
// Fest 22.11.2026). A route counts once the finder sees the CLI (fresh PATH).
// B-051 integration: demo mode (WORKFORCE_FAKE_ENGINE, e2e and window tests) never runs a real installer.
// B-080 wave 3 (live 08.–09.11.2026: Codex's shell on Windows was Windows PowerShell 5.1, whose pipes into programs are
// ASCII – "Nächste" reached a file as "N?chste"): PowerShell 7 for the engines' shells, the way the CLIs come –
// Microsoft's official per-user installer (aka.ms/install-powershell.ps1, its zip into %LOCALAPPDATA%\Microsoft\powershell,
// no admin, no PATH change: engines/wf-shim.ts withTools puts that folder on the engines' PATH). ensurePwsh runs it once
// per start on Windows, in the background (main.ts), where no pwsh.exe is found (wf-shim.ts pwshDir).
// B-080 wave 3 review: progress records off for the whole script (Windows PowerShell 5.1's Expand-Archive is slow with
// them – the 100 MB zip could reach the 5-minute stop), POWERSHELL_TELEMETRY_OPTOUT=1 as for the engines, and a run that
// leaves no pwsh.exe throws with its exit and the free space of %LOCALAPPDATA%'s drive (main.ts logs it as
// "PowerShell 7 not installed" – a full disk shows there).
// Owns: the fixed install commands, their order and their 5-minute timeout (per route).
// Never: builds commands from user input (all arguments are constants), runs as admin, or installs in demo mode.

import { statfs } from 'node:fs/promises';
import type { Supervisor } from '../system/supervisor.ts';
import type { Executable, ExecutableFinder } from './executables.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { pwshDir } from '../engines/wf-shim.ts';

/** npm's newest release, by name: an install and an update are the same command. */
const NPM_PACKAGES = { codex: '@openai/codex@latest' } as const;
export const INSTALL_FAILED = {
  claude: 'Could not install Claude Code. Check your connection and try again.',
  codex: 'Could not install Codex. Check your connection and try again.',
} as const;
/** Demo mode: the fake engine needs no CLI, and a real installer must never run there. */
export const INSTALL_OFF_IN_DEMO = 'The demo does not install programs.';
const INSTALL_MS = 5 * 60_000;

/** One install command: constant arguments, the env it runs with (undefined = the inherited one). */
export interface InstallRoute { command: string; args: string[]; env?: NodeJS.ProcessEnv }

export interface InstallDeps { supervisor: Supervisor; finder: ExecutableFinder; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number; demo?: boolean }

/** Claude Code's official native installer (stable channel). */
export function claudeInstaller(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): InstallRoute {
  return platform === 'win32'
    ? { command: 'powershell.exe', env, args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://claude.ai/install.ps1'))) stable; if (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.local/bin/claude.exe'))) { exit 1 }"] }
    : { command: '/bin/bash', env, args: ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s stable'] };
}

/** Codex's official standalone installer; the caller's env (never dropped: PATH, SystemRoot …) plus CODEX_NON_INTERACTIVE=1. */
export function codexInstaller(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): InstallRoute {
  const quiet: NodeJS.ProcessEnv = { ...(env ?? process.env), CODEX_NON_INTERACTIVE: '1' };
  return platform === 'win32'
    ? { command: 'powershell.exe', env: quiet, args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://chatgpt.com/codex/install.ps1'))); if (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin\\codex.exe'))) { exit 1 }"] }
    : { command: '/bin/bash', env: quiet, args: ['-c', 'set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh'] };
}

/** `npm install -g @openai/codex@latest` (Codex's fallback install and an npm install's update); npm.cmd cannot be spawned without a shell – all arguments are constants, so cmd /c is safe. */
export function npmInstaller(npm: Executable, platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): InstallRoute {
  if (platform === 'win32' && npm.path.toLowerCase().endsWith('.cmd') && npm.command === npm.path) {
    return { command: 'cmd.exe', env, args: ['/d', '/s', '/c', 'npm', 'install', '-g', NPM_PACKAGES.codex] };
  }
  return { command: npm.command, env, args: [...npm.prefixArgs, 'install', '-g', NPM_PACKAGES.codex] };
}

/** Installs the CLI unless the finder already sees it; true when it was installed now. Throws INSTALL_FAILED when every route failed. */
export async function installCli(provider: 'claude' | 'codex', deps: InstallDeps): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (await deps.finder.find(provider, { force: true })) return false; // already installed
  if (deps.demo) throw new WorkforceError('unavailable', INSTALL_OFF_IN_DEMO);
  if (provider === 'claude') {
    if (await runRoute(claudeInstaller(platform, deps.env), provider, deps)) return true;
  } else {
    if (await runRoute(codexInstaller(platform, deps.env), provider, deps)) return true;
    const npm = await deps.finder.find('npm', { force: true }); // Node may have been installed meanwhile
    if (npm && await runRoute(npmInstaller(npm, platform, deps.env), provider, deps)) return true;
  }
  throw new WorkforceError('unavailable', INSTALL_FAILED[provider]);
}

/**
 * B-080 wave 3: PowerShell 7 by Microsoft's official installer script with its stable release as a zip into
 * %LOCALAPPDATA%\Microsoft\powershell (wf-shim.ts pwshUserDir) – per user, no admin, PATH untouched (no -AddToPath);
 * progress records off, the caller's env plus POWERSHELL_TELEMETRY_OPTOUT=1 unless it sets its own.
 */
export function pwshInstaller(env?: NodeJS.ProcessEnv): InstallRoute {
  const base = env ?? process.env;
  const own = Object.keys(base).some((key) => key.toUpperCase() === 'POWERSHELL_TELEMETRY_OPTOUT');
  return { command: 'powershell.exe', env: own ? base : { ...base, POWERSHELL_TELEMETRY_OPTOUT: '1' }, args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $to = Join-Path $env:LOCALAPPDATA 'Microsoft\\powershell'; & ([scriptblock]::Create((Invoke-RestMethod 'https://aka.ms/install-powershell.ps1'))) -Destination $to; if (-not (Test-Path -LiteralPath (Join-Path $to 'pwsh.exe'))) { exit 1 }"] };
}

/**
 * B-080 wave 3: installs PowerShell 7 on Windows where no pwsh.exe is found (wf-shim.ts pwshDir: PATH, %ProgramFiles%,
 * the per-user folder); true when it was installed now. Off Windows, in demo mode and with a pwsh found: nothing runs.
 * A run that leaves none throws with its exit and the free space where it installs (B-080 wave 3 review).
 */
export async function ensurePwsh(deps: Pick<InstallDeps, 'supervisor' | 'platform' | 'env' | 'timeoutMs' | 'demo'>): Promise<boolean> {
  const env = deps.env ?? process.env;
  if ((deps.platform ?? process.platform) !== 'win32' || deps.demo || pwshDir(env)) return false;
  const code = await runToEnd(pwshInstaller(deps.env), 'install:pwsh', deps);
  if (pwshDir(env)) return true;
  const local = env[Object.keys(env).find((key) => key.toUpperCase() === 'LOCALAPPDATA') ?? 'LOCALAPPDATA'];
  const disk = local ? await statfs(local).catch(() => undefined) : undefined;
  const free = disk ? `; ${(Number(disk.bavail) * Number(disk.bsize) / 1e9).toFixed(1)} GB free on the drive of ${local}` : '';
  const end = code === 'stopped' ? 'was stopped at its time limit' : code === null ? 'could not start' : `ended with exit code ${code}`;
  throw new Error(`PowerShell 7's installer ${end} and left no pwsh.exe${free}`);
}

/** Runs one route to its end (or the timeout); true when it exited 0 and the CLI is found now. */
async function runRoute(route: InstallRoute, provider: 'claude' | 'codex', deps: InstallDeps): Promise<boolean> {
  const code = await runToEnd(route, `install:${provider}`, deps);
  deps.finder.clear();
  return code === 0 && Boolean(await deps.finder.find(provider, { force: true }));
}

/** One install command to its end, stopped at the timeout; its exit code ('stopped': at the timeout; null: it could not start). */
async function runToEnd(route: InstallRoute, owner: string, deps: Pick<InstallDeps, 'supervisor' | 'timeoutMs'>): Promise<number | null | 'stopped'> {
  try {
    const lease = deps.supervisor.spawn({ command: route.command, args: route.args, owner, kind: 'light', env: route.env, stdio: ['ignore', 'ignore', 'ignore'] });
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; void lease.release(); }, deps.timeoutMs ?? INSTALL_MS);
    timer.unref?.();
    const code = await lease.exited;
    clearTimeout(timer);
    return stopped ? 'stopped' : code;
  } catch {
    return null; // could not start (no PowerShell or bash)
  }
}
