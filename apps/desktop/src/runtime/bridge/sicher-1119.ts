// bridge 0.3.16 of the Sicher-Runde 19.11.2026 (owner: Trust AI mode and Secure mode): the one-time conversions of data from
// before it, each part idempotent. This file is deleted in the version after the bridge.
// - settings (runSicher1119Files, at runtime start BEFORE the settings store first reads settings.json – it would drop
//   the two keys no section knows any more): profile.pcAccess and profile.forEveryAgent leave the profile (one name).
//   Existing profiles default to Trust AI; the old 'careful' preference is carried into its guidance and kept as
//   a preset for an explicit switch to Secure. Upgrading never selects Secure automatically. A file that
//   already has a security section (a linked PC's copy came first) keeps it. forEveryAgent: the old default "I'm not a
//   robot" line (German or English) is dropped – security/<mode>/captcha.md carries it now; any other text is appended
//   below the text of security/trust/general.md AND security/secure/general.md (the default with the person's name when
//   there is no file yet), where the person sees it and decides. The topic files are written before settings.json, so a
//   stop in between repeats the step and finds the text already there.
// - SYSTEM.md (runSicher1119, with the services, beside the other bridges): the old shipped PC line under "What I have
//   here" – "all of it" or the careful one, for any name – becomes today's line (resources/prompts/standard-*.md), in
//   each agent at home on this PC; an agent's own wording stays.
// Owns: those conversions. Never: changes another part of settings.json or of a SYSTEM.md, or a topic file beyond the
// appended text.

import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { AGENT_CORE_DIR, humanDefault } from '../../shared/model/agent-core.ts';
import { MAX_SCOPE_ITEMS, SECURITY_DIR, SECURITY_MODES, securityDefaults, type SecurityMode, type SecuritySettings } from '../../shared/model/security-settings.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { ROOT_SETTINGS } from '../root/layout.ts';
import { readText, writeAtomic } from '../root/text-doc.ts';
import { parseText } from '../settings/schema.ts';
import { fillName } from '../security/topics.ts';

const LIMITS = { maxBytes: 1024 * 1024 };
type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What "careful" PC access promised, as Secure mode's switches: all open but changes outside its own and the released folders. */
export function carefulSecurity(released: readonly string[] = []): SecuritySettings {
  return {
    ...securityDefaults('trust'), mode: 'secure', write: 'chosen', writeFolders: [...released], readFolders: [], computerApps: [],
  };
}

/** Where a path starts in free text: a drive (C:\ or C:/), a share (\\server) or a / after a space, quote or the start. */
const PATH_START = /[A-Za-z]:[\\/]|\\\\(?=[^\\\s])|(?<=^|[\s"'`(,;])\/(?=[^\s/])/g;

/** A path cut out of a sentence: the words and marks that join it to the next one off, a trailing separator off (not a root's). */
function tidyPath(raw: string): string {
  let value = raw.trim();
  for (let next = ''; next !== value; ) {
    next = value;
    value = value.replace(/\s+(?:and|und|or|oder|&)$/i, '').replace(/[\s,;:"'`()]+$/, '').replace(/\.$/, '');
  }
  return /[\\/]$/.test(value) && !/^(?:[A-Za-z]:)?[\\/]$/.test(value) ? value.slice(0, -1) : value;
}

/** Every absolute path in a "Released folders: …" line, whatever words stand around them (none: []). */
export function releasedFolders(line: string): string[] {
  const starts = [...line.matchAll(PATH_START)].map((match) => match.index);
  return starts.map((start, index) => tidyPath(line.slice(start, starts[index + 1] ?? line.length))).filter((value) => value.length >= 2 && value.length <= 1024);
}

/** The folders every agent at home here had released in its old careful line (agents/<id>/SYSTEM.md), each once. */
export function releasedOfAgents(dataDir: string): string[] {
  const found = new Map<string, string>();
  let ids: string[] = [];
  try { ids = readdirSync(path.join(dataDir, AGENT_CORE_DIR)); } catch { return []; }
  for (const id of ids) {
    const read = readText(path.join(dataDir, AGENT_CORE_DIR, id, 'SYSTEM.md'), LIMITS);
    if (read.kind !== 'ok') continue;
    for (const match of read.text.matchAll(/Released folders:([^\n]*)/g)) {
      for (const folder of releasedFolders(match[1])) {
        const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
        if (!found.has(key) && found.size < MAX_SCOPE_ITEMS) found.set(key, folder);
      }
    }
  }
  return [...found.values()];
}

/** The old text for every agent without the old default robot line ('' when nothing else is in it). */
export function ownLines(text: unknown): string {
  if (typeof text !== 'string') return '';
  const robot = new Set([humanDefault('de'), humanDefault('en')]);
  return text.replace(/\r\n?/g, '\n').split('\n').filter((line) => !robot.has(line.trim())).join('\n').trim();
}

/** Appends `extra` below the mode's general text (its file, else the default with the name); false when it is there already. */
function appendGeneral(dataDir: string, resourcesDir: string, mode: SecurityMode, extra: string, name: string): boolean {
  const file = path.join(dataDir, SECURITY_DIR, mode, 'general.md');
  const own = readText(file, LIMITS);
  const shipped = readText(path.join(resourcesDir, SECURITY_DIR, mode, 'general.md'), LIMITS);
  const base = own.kind === 'ok' ? own.text.trim() : fillName(shipped.kind === 'ok' ? shipped.text.trim() : '', name);
  if (base.includes(extra)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${[base, extra].filter(Boolean).join('\n\n')}\n`);
  return true;
}

/** The settings part (see the header); returns what it did. Runs before the settings store reads the file. */
export function runSicher1119Files(dataDir: string, resourcesDir: string, log?: Logger): 'none' | 'moved' {
  try {
    const file = path.join(dataDir, ROOT_SETTINGS);
    const read = readText(file, LIMITS);
    if (read.kind !== 'ok') return 'none';
    const data = parseText(read.text).data;
    if (!data || !isPlain(data.profile)) return 'none';
    const profile = data.profile;
    if (!('pcAccess' in profile) && !('forEveryAgent' in profile)) return 'none';
    const legacyCareful = !isPlain(data.security) && profile.pcAccess === 'careful';
    if (!isPlain(data.security)) data.security = legacyCareful
      ? { ...carefulSecurity(releasedOfAgents(dataDir)), mode: 'trust' }
      : securityDefaults('trust');
    const extra = ownLines(profile.forEveryAgent);
    const name = typeof profile.name === 'string' ? profile.name : '';
    if (extra) for (const mode of SECURITY_MODES) appendGeneral(dataDir, resourcesDir, mode, extra, name);
    if (legacyCareful) {
      const folders = (data.security as SecuritySettings).writeFolders;
      const released = folders.length ? ' Released folders: ' + folders.join(', ') + '.' : '';
      appendGeneral(dataDir, resourcesDir, 'trust',
        'I can read and look where it helps. I change, install and delete on my own only in our workspace, my home project, this company’s data folder and released folders, or at the person’s request. For other changes I ask first.' + released, name);
    }
    delete profile.pcAccess;
    delete profile.forEveryAgent;
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`); // the settings store writes it whole again, with its comments
    log?.info('sicher-1119 bridge', { part: 'settings', mode: (data.security as Plain).mode, appended: Boolean(extra) });
    return 'moved';
  } catch (error) {
    log?.warn('sicher-1119 bridge failed', { part: 'settings', error: String((error as Error)?.message ?? error) });
    return 'none';
  }
}

const NAME = '\u0001';
/** The rest of the careful line: "none yet." or the folders an agent had released (FX1 M1: any wording). */
const REST = '\u0002';
const OLD_LINES = [
  `- This PC is my workplace, all of it: the files and apps on it, the browser with ${NAME}'s logins and the secrets catalog with their passwords and keys.`,
  `- This PC is my workplace, the way ${NAME} chose at the start (careful): I read and look wherever it helps, use the browser with their logins and the secrets catalog with their passwords and keys; in my workspace, my home project, this app's data folder and the released folders I change, install and delete as my own call, and anywhere whatever ${NAME} asks me to. Only a change elsewhere that nobody asked for I check with ${NAME} in one line first; a folder they release for good I add here. Released folders:${REST}`,
];
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OLD = OLD_LINES.map((line) => new RegExp(`^[ \\t]*${line.split(NAME).map(escaped).join('.+?').replace(REST, '[^\\n]*')}[ \\t]*$`, 'gm'));

/** Today's PC line for `owner`. */
export const pcLine = (owner: string): string => `- This PC is my workplace: its files and apps, the browser with ${owner}'s logins and the secrets catalog with their passwords and keys; how far I go on my own here stands under "What ${owner} and I agreed".`;

/** `text` with every old shipped PC line as today's line (the text itself when it has none). */
export function withTodaysPcLine(text: string, owner: string): string {
  return OLD.reduce((out, pattern) => out.replace(pattern, () => pcLine(owner)), text);
}

/** The SYSTEM.md part (see the header); returns how many agents changed. */
export function pcLinePart(s: Pick<RuntimeServices, 'org' | 'db' | 'settings'>): number {
  const owner = s.settings.get().profile.name.trim() || 'the person';
  let changed = 0;
  for (const agent of s.org.list({ includeArchived: true })) {
    if (homeElsewhere(s, agent.id)) continue;
    const next = withTodaysPcLine(agent.instructions, owner);
    if (next === agent.instructions) continue;
    s.org.update(agent.id, { instructions: next }, { by: HUMAN_ID, reason: 'The PC line names the security agreements now (19.11.2026).' });
    changed++;
  }
  return changed;
}

/** The parts that need the services; a part that fails is logged and tried again at the next start. */
export function runSicher1119(s: RuntimeServices): void {
  try {
    const changed = pcLinePart(s);
    if (changed) s.log.info('sicher-1119 bridge', { part: 'pc-line', changed });
  } catch (error) {
    s.log.warn('sicher-1119 bridge failed', { part: 'pc-line', error: String((error as Error)?.message ?? error) });
  }
}
