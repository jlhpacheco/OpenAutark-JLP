// The agents' `wf` (B-072): engine processes (Codex app-server, Claude Code, ACP agents) and their shells find the
// app's terminal client first on PATH. <data>/bin holds `wf` (sh: Git Bash, macOS, Linux) and on Windows `wf.cmd`
// (cmd, PowerShell). Both run app/wf.mjs – the bundle beside this runtime's own, app.asar.unpacked when packaged
// (package.json asarUnpack) – with this process's binary as Node: the app's Electron through ELECTRON_RUN_AS_NODE,
// set for that one call (node ignores it). The folder comes first, so on Windows `wf` is never system32\WF.msc
// (the firewall console). AUTARK_DATA names the data folder, so wf reaches this runtime (wf-cli/discover.ts).
// B-080 (live 05.–08.11.2026: rg was missing in 77 of 87 rg calls of Codex's own shell, Python failed 32 times on
// cp1252): one rule for every engine's shells, shell.exec (withTools) – on Windows, when no PATH entry
// holds rg.exe, Codex's own rg goes at the END of PATH (the person's own rg wins): the folder of the rg.exe beside the
// codex.exe the app runs or in a sibling folder under the same bin root (codex/server.ts names that codex.exe), else
// the newest rg.exe one level under %LOCALAPPDATA%\OpenAI\Codex\bin – what Codex's own launcher gives its shells; none
// found: PATH as it was. The lookup is memoized per PATH, LOCALAPPDATA and codex.exe (rgDirs: no folder scan per
// command). PYTHONUTF8=1 unless the person's env sets it, so plain python reads and writes UTF-8.
// B-080 wave 3 (live 08.–09.11.2026: text piped into python in Codex's Windows PowerShell 5.1 arrived as "N?chste";
// Python jobs showed no output until they ended, and the timeout review took them for hung): PYTHONUNBUFFERED=1 unless
// the env sets its own, and on Windows the folder of PowerShell 7 (pwshDir: a PATH entry, else %ProgramFiles%\PowerShell\7,
// else the per-user install of accounts/install.ts ensurePwsh) goes at the END of PATH when no PATH entry holds a
// pwsh.exe – Codex and Claude Code then take pwsh for their shells, UTF-8 throughout. B-080 wave 3 review: a Store pwsh
// on PATH is an app execution alias that stat refuses (EACCES) – it counts, since Windows starts it; and
// POWERSHELL_TELEMETRY_OPTOUT=1 unless the env sets its own (pwsh reports each start to Microsoft otherwise, and the
// engines start one per command).
// B-085: AUTARK_AGENT (shared/api/protocol.ts AGENT_ENV) names the agent whose process it is – its `wf` then writes as
// that agent (wf-cli/discover.ts → Hello `agent`). Set per agent (shell.exec per call, a Claude turn, a
// Codex thread); the shared engine env (Codex app-server, ACP) never carries one, an inherited value is dropped.
// Sicher-Runde 19.11.2026: AUTARK_AGENT_PROOF beside it (security/agent-proof.ts) – without it the runtime takes no agent's name.
// Owns: the shim texts, writing them (only what changed, LF), the PATH order (the shim folder first, Codex's rg and
// pwsh last), AUTARK_DATA, AUTARK_AGENT, PYTHONUTF8, PYTHONUNBUFFERED and POWERSHELL_TELEMETRY_OPTOUT of the agents'
// env, where pwsh.exe is found.
// Never: puts a token, secret or env value into the files, or fails an engine start (no wf.mjs or a write error:
// PATH stays as it was).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackedPath } from '../computer/service.ts';
import { AGENT_ENV, AGENT_PROOF_ENV } from '../../shared/api/protocol.ts';
import { agentIdentity } from '../security/agent-proof.ts';

export interface ShimFile { name: string; text: string }

const NOTE = "Autark's wf client, kept up to date by the app (changes here are replaced).";

/** <data>/bin: the agents' own commands. */
export function shimDir(data: string): string {
  return path.join(data, 'bin');
}

/** app/wf.mjs beside the runtime bundle (app/runtime.mjs, app/runtime-cli.mjs); packaged: in app.asar.unpacked. */
export function wfEntry(bundleFile: string): string {
  return unpackedPath(path.join(path.dirname(bundleFile), 'wf.mjs'));
}

/** `wf` (sh) and on Windows `wf.cmd`, both running `entry` with `executable` as Node; `dir` is where they lie. */
export function shimFiles(launch: { executable: string; entry: string }, platform: NodeJS.Platform, dir: string): ShimFile[] {
  const lines = (...rows: string[]) => `${rows.join('\n')}\n`;
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`; // sh: every other character as it is
  if (platform !== 'win32') {
    return [{ name: 'wf', text: lines('#!/bin/sh', `# ${NOTE}`, 'export ELECTRON_RUN_AS_NODE=1', `exec ${quote(launch.executable)} ${quote(launch.entry)} "$@"`) }];
  }
  // Windows: the shells read these files in their own code page, so a path on the shim's drive is written relative
  // to the shim's folder, which each shell takes from Windows itself (Git Bash: `pwd -W`, as C:/…; cmd: %~dp0) –
  // a name such as C:\Users\Jürgen never stands in the files. A path on another drive stays absolute.
  const relative = (file: string) => {
    const rel = path.win32.relative(dir, file);
    return path.win32.isAbsolute(rel) ? undefined : rel;
  };
  const sh = (file: string) => {
    const rel = relative(file);
    return rel === undefined ? quote(file.replace(/\\/g, '/')) : `"$d"${quote(`/${rel.replace(/\\/g, '/')}`)}`;
  };
  const cmd = (file: string) => {
    const rel = relative(file);
    return `"${rel === undefined ? file.replace(/%/g, '%%') : `%~dp0${rel.replace(/%/g, '%%')}`}"`;
  };
  return [{
    name: 'wf', // builtins only: a Git Bash started without its own PATH has no dirname
    text: lines('#!/bin/sh', `# ${NOTE}`, 'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac', 'd=$(CDPATH= cd -- "$d" && pwd -W)',
      'export ELECTRON_RUN_AS_NODE=1', `exec ${sh(launch.executable)} ${sh(launch.entry)} "$@"`),
  }, {
    name: 'wf.cmd', // setlocal keeps the switch out of the caller
    text: lines('@echo off', `rem ${NOTE}`, 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `${cmd(launch.executable)} ${cmd(launch.entry)} %*`),
  }];
}

/** Writes the files whose text differs (LF, `wf` executable); false when the folder cannot be written. */
function writeShim(dir: string, files: ShimFile[]): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = path.join(dir, file.name);
      let current: string | undefined;
      try { current = readFileSync(target, 'utf8'); } catch { current = undefined; }
      if (current !== file.text) writeFileSync(target, file.text, { mode: 0o755 });
    }
    return true;
  } catch {
    return false;
  }
}

/** The name `env` holds the variable under (Windows: its own spelling, e.g. Path; else as given). */
function keyOf(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? Object.keys(env).find((key) => key.toUpperCase() === name) : undefined) ?? name;
}

/**
 * B-085: `env` with AUTARK_AGENT = `agentId` (the agent whose process it is: its `wf` writes as that agent) and its proof
 * (AUTARK_AGENT_PROOF), or without both – an inherited value never passes on. The input stays as it was.
 */
export function asAgent(env: NodeJS.ProcessEnv, agentId: string | undefined, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of [AGENT_ENV, AGENT_PROOF_ENV]) delete out[keyOf(out, name, platform)];
  return agentId ? Object.assign(out, agentIdentity(agentId)) : out;
}

/**
 * `base` plus AUTARK_DATA, and `dir` first on PATH (once; on Windows under the variable's own spelling, e.g. Path).
 * B-085: AUTARK_AGENT = `agentId` when given, else none (asAgent).
 */
export function withShim(base: NodeJS.ProcessEnv, data: string, dir: string | undefined, platform: NodeJS.Platform, agentId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...asAgent(base, agentId, platform), AUTARK_DATA: data };
  if (!dir) return env;
  const key = keyOf(env, 'PATH', platform);
  const separator = platform === 'win32' ? ';' : ':';
  env[key] = [dir, ...(env[key] ?? '').split(separator).filter((part) => part && part !== dir)].join(separator);
  return env;
}

const isFile = (file: string): boolean => { try { return statSync(file).isFile(); } catch { return false; } };

/**
 * B-080 wave 3 review: a program Windows starts – a file, or an app execution alias (a Store app's WindowsApps\pwsh.exe:
 * a link stat refuses with EACCES, CreateProcess starts it). A link whose target is gone (ENOENT) is none.
 */
export function isProgram(file: string): boolean {
  try { return statSync(file).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    try { return lstatSync(file).isSymbolicLink(); } catch { return false; }
  }
}

/** The entries of a Windows PATH value (trimmed, outer quotes off). */
const pathEntries = (value: string | undefined): string[] => (value ?? '').split(';').map((part) => part.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);

/** The folder of the newest rg.exe one level under `root` (by its file time); undefined: none there. */
function newestRg(root: string): string | undefined {
  let names: string[];
  try { names = readdirSync(root); } catch { return undefined; }
  let best: { dir: string; time: number } | undefined;
  for (const name of names) {
    const dir = path.win32.join(root, name);
    try {
      const info = statSync(path.win32.join(dir, 'rg.exe'));
      if (info.isFile() && (!best || info.mtimeMs > best.time)) best = { dir, time: info.mtimeMs };
    } catch { /* no rg here */ }
  }
  return best?.dir;
}

/**
 * B-080 review: the answer per PATH, LOCALAPPDATA and codex.exe – every shell.exec builds agentEnv, and
 * a PATH entry on an unreachable share would stall the runtime on each scan. A folder found is checked again (one stat
 * of its rg.exe) and looked for anew once that file is gone (a Codex update replaced its folder).
 */
const rgDirs = new Map<string, string | undefined>();

/**
 * B-080, Windows: the folder of Codex's own rg.exe for an env whose PATH holds none – beside `codex` (the codex.exe the
 * app runs) or in a sibling folder under the same bin root, else the newest one level under
 * %LOCALAPPDATA%\OpenAI\Codex\bin. undefined: PATH has an rg.exe already, or none is found. Memoized (rgDirs).
 */
export function codexRgDir(env: NodeJS.ProcessEnv, codex?: string): string | undefined {
  const key = [env[keyOf(env, 'PATH', 'win32')] ?? '', env[keyOf(env, 'LOCALAPPDATA', 'win32')] ?? '', codex ?? ''].join('\0');
  if (rgDirs.has(key)) {
    const known = rgDirs.get(key);
    if (!known || isFile(path.win32.join(known, 'rg.exe'))) return known;
  }
  const found = findRgDir(env, codex);
  if (rgDirs.size >= 64) rgDirs.clear(); // a handful of distinct envs in practice
  rgDirs.set(key, found);
  return found;
}

function findRgDir(env: NodeJS.ProcessEnv, codex?: string): string | undefined {
  if (pathEntries(env[keyOf(env, 'PATH', 'win32')]).some((dir) => isFile(path.win32.join(dir, 'rg.exe')))) return undefined;
  if (codex) {
    const own = path.win32.dirname(codex);
    if (isFile(path.win32.join(own, 'rg.exe'))) return own;
    const sibling = newestRg(path.win32.dirname(own));
    if (sibling) return sibling;
  }
  const local = env[keyOf(env, 'LOCALAPPDATA', 'win32')];
  return local ? newestRg(path.win32.join(local, 'OpenAI', 'Codex', 'bin')) : undefined;
}

/** B-080 wave 3: the PATH entry holding pwsh.exe, per PATH value (one stat per entry once – a share that does not answer would stall each look). */
const pwshOnPath = new Map<string, string | undefined>();

function pathPwsh(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[keyOf(env, 'PATH', 'win32')] ?? '';
  if (pwshOnPath.has(value)) {
    const known = pwshOnPath.get(value);
    if (!known || isProgram(path.win32.join(known, 'pwsh.exe'))) return known;
  }
  const found = pathEntries(value).find((dir) => isProgram(path.win32.join(dir, 'pwsh.exe')));
  if (pwshOnPath.size >= 64) pwshOnPath.clear();
  pwshOnPath.set(value, found);
  return found;
}

/** Where accounts/install.ts ensurePwsh puts PowerShell 7 for this user (Microsoft's per-user installer's own default). */
export function pwshUserDir(localAppData: string): string {
  return path.win32.join(localAppData, 'Microsoft', 'powershell');
}

/**
 * B-080 wave 3, Windows: the folder of the PowerShell 7 the shells use – a PATH entry holding pwsh.exe, else
 * %ProgramFiles%\PowerShell\7, else the per-user install (pwshUserDir under %LOCALAPPDATA%); undefined: none. Only `env`
 * counts (no default folder), so the answer is the env's own.
 */
export function pwshDir(env: NodeJS.ProcessEnv): string | undefined {
  const programs = env[keyOf(env, 'PROGRAMFILES', 'win32')];
  const local = env[keyOf(env, 'LOCALAPPDATA', 'win32')];
  const fixed = [programs ? path.win32.join(programs, 'PowerShell', '7') : undefined, local ? pwshUserDir(local) : undefined];
  return pathPwsh(env) ?? fixed.find((dir): dir is string => dir !== undefined && isFile(path.win32.join(dir, 'pwsh.exe')));
}

/**
 * B-080: `env` with PYTHONUTF8=1 and (wave 3) PYTHONUNBUFFERED=1 and POWERSHELL_TELEMETRY_OPTOUT=1 unless it sets its
 * own, and on Windows Codex's rg and PowerShell 7 at the end of PATH where no PATH entry holds them (codexRgDir,
 * pwshDir; `codex`: the codex.exe the app runs, when the caller knows it). The input stays as it was.
 */
export function withTools(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, codex?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of ['PYTHONUTF8', 'PYTHONUNBUFFERED', 'POWERSHELL_TELEMETRY_OPTOUT']) {
    const key = keyOf(out, name, platform);
    if (out[key] === undefined) out[key] = '1';
  }
  if (platform !== 'win32') return out;
  const key = keyOf(out, 'PATH', platform);
  const rg = codexRgDir(out, codex);
  const pwsh = pathPwsh(out) ? undefined : pwshDir(out); // a pwsh already on PATH wins
  const extra = [rg, pwsh].filter((dir): dir is string => Boolean(dir));
  if (extra.length) out[key] = [...(out[key] ?? '').split(';').filter(Boolean), ...extra].join(';');
  return out;
}

export interface AgentEnvOptions {
  env?: NodeJS.ProcessEnv; // default process.env
  platform?: NodeJS.Platform; // default process.platform
  executable?: string; // default process.execPath (the app's Electron, or node for the headless runtime)
  entry?: string; // default app/wf.mjs beside this bundle (wfEntry)
  agent?: string; // B-085: the agent whose process it is (AUTARK_AGENT); absent: a shared process, no agent
}

/**
 * The env for engine processes: AUTARK_DATA = `data`, and <data>/bin first on PATH once the shim is written there.
 * Without app/wf.mjs (unit tests, a runtime run from source) nothing is written and PATH keeps its folders.
 * B-080: plus withTools (PYTHONUTF8, PYTHONUNBUFFERED, POWERSHELL_TELEMETRY_OPTOUT, on Windows Codex's rg and pwsh last
 * on PATH). B-085: AUTARK_AGENT
 * only for `agent`.
 */
export function agentEnv(data: string, options: AgentEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const entry = options.entry ?? wfEntry(fileURLToPath(import.meta.url));
  const dir = shimDir(data);
  const ready = existsSync(entry) && writeShim(dir, shimFiles({ executable: options.executable ?? process.execPath, entry }, platform, dir));
  return withTools(withShim(options.env ?? process.env, data, ready ? dir : undefined, platform, options.agent), platform);
}
