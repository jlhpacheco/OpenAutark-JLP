// "## My environment": the stable part (this PC, workspace, the person's files and the data folder, how to search the
// web this turn, screen tools, the one line on instruction files) is deterministic and names only offered tools; the
// live part ("## My environment now") says only what moves on its own – free disk below 2 GB, the companies on this PC
// and the linked PCs (B-075), accounts needing a sign-in (labels only, every mode), connected apps – and is left out
// when there is nothing to say; the lines speak as the agent (first person); B-080: the Windows shell line;
// B-089: the models line is the volatile section 'models', no longer in the stable part.
// Owns: these assertions only. Never: real accounts, real OS facts in the asserted text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, route, VIDEO_MODE } from './fixture.ts';
import {
  ENVIRONMENT_HEADER, INSTRUCTION_FILES_LINE, companiesLine, diskLine, environmentNow, environmentSection, homeLine, memoryLine, notesLine, osName,
  windowsShellLine, workspaceLine, type SystemFacts,
} from '../../../src/runtime/context/environment.ts';
import { HELPER_NOTE } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { whereHint } from '../../../src/runtime/browser/place.ts';
import { volatileSections } from '../../../src/runtime/context/prompt-volatile.ts'; // B-089: the models section
import type { Account } from '../../../src/shared/model/providers.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const WIN: SystemFacts = { platform: 'win32', version: 'Windows 11 Pro', release: '10.0.26300', hostname: 'DESK-7' };
const GENERAL: ModeInfo = { key: 'general', name: 'General', description: '', skills: [], tools: ['*'], category: 'chat', instructions: '' };

function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, enabled: true, detected: true, createdAt: 0, ...extra };
}

/** The context fixture with a tool offer, paths, accounts and a permission mode of our choice. */
function setup(options: { tools?: string[]; accounts?: Account[]; data?: string; workspace?: string } = {}) {
  const f = fixture();
  const s = f.services as unknown as Record<string, unknown>;
  const names = options.tools ?? [];
  Object.assign(s, {
    tools: { get: () => undefined, specsFor: () => names.map((name) => ({ name, description: '', inputSchema: {} })) },
    paths: { resources: '/res', temp: '/tmp', workspace: options.workspace ?? path.resolve('/ws'), data: options.data ?? path.resolve('/appdata/Workforce') },
    accounts: { list: () => options.accounts ?? [] },
  });
  return f;
}

test('stable environment: this PC, the workspace, web and screen lines from the real offer; deterministic', () => {
  const f = setup({ tools: ['web.search', 'web.fetch', 'browser.act', 'browser.show', 'computer.act'] });
  const input = { agent: f.vid, mode: GENERAL, route: route() };
  const text = environmentSection(f.services, input, undefined, WIN);
  assert.ok(text.startsWith(`${ENVIRONMENT_HEADER}\nThis PC: Windows 11 Pro (10.0.26300), named "DESK-7"`), text);
  assert.ok(text.includes(`Workspace: ${path.resolve('/ws')}`));
  assert.ok(text.includes("Web: web_search (my engine's own search) finds current pages, web.fetch reads one."), text);
  assert.ok(!text.includes('web.search'), 'Codex searches with its own: web.search stands only in the tool list');
  assert.ok(/– I run inside the Autark system on it, whose language is set to \w+\./.test(text) && text.includes('(projects and the files I make)'), text); // B-076: the language as a fact (B-080: the instruction-file clause may follow)
  assert.ok(text.includes("Screen: browser.* browses websites (the person can watch and take over; where: 'chrome' is the person's own Chrome with their logins), computer.* operates this PC's screen, mouse and keyboard."), text);
  assert.ok(text.split('\n').includes(`Browser, where: ${whereHint(true)}`), 'B-080: with computer.* the Browser line names the person\'s own Chrome');
  assert.equal(environmentSection(f.services, input, undefined, WIN), text, 'deterministic');
  assert.ok(!/\d{1,2}:\d{2}|2026/.test(text.replace('10.0.26300', '')), 'no times in the stable part');

  // E1: a Codex or Claude Code agent turn keeps its engine's own web search (named first, in every mode); another
  // engine without web tools and without screen tools: the way to a colleague.
  const bare = setup({ tools: [] });
  const claude = environmentSection(bare.services, { agent: bare.vid, mode: GENERAL, route: { ...route(), engine: 'claude' } }, undefined, WIN);
  assert.ok(claude.includes("Web: WebSearch (my engine's own search) finds current pages.") && !claude.includes('web.search'), claude);
  const claudeWeb = environmentSection(f.services, { ...input, route: { ...route(), engine: 'claude' } }, undefined, WIN);
  assert.ok(claudeWeb.includes("Web: WebSearch (my engine's own search) finds current pages, web.fetch reads one.") && !claudeWeb.includes('web.search'), claudeWeb);
  const api = environmentSection(f.services, { ...input, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(api.includes('Web: web.search finds pages (title, link, snippet), web.fetch reads one.'), api);
  assert.ok(!text.includes('Results are outside content'), 'B-049 F5: the rules say once that outside content is data');
  // KI-Runde 17.11.2026: no line sends web or screen work to another mode or another agent – every tool is in reach.
  const none = environmentSection(bare.services, { agent: bare.vid, mode: GENERAL, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(!none.includes('Web:'), `no web tool registered: no web line – ${none}`);
  assert.ok(!none.includes('Screen:'), 'no screen tools registered: no screen line');
  assert.ok(!/colleague in (research|computer) mode/.test(none), none);
  const fetchOnly = setup({ tools: ['web.fetch'] });
  const fetchLine = environmentSection(fetchOnly.services, { agent: fetchOnly.vid, mode: GENERAL, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(fetchLine.includes('Web: web.fetch reads a page whose address I know.'), fetchLine);
  assert.ok(!none.includes('web.search') && !none.includes('browser.*'), 'never a tool the mode does not offer');
  // B-072 (live 03.11.2026: a social agent asked for a sign-in its person's own Chrome already had): a browser-only mode
  // names the person's own browsers and the way to them.
  const browserOnly = setup({ tools: ['browser.act', 'browser.show'] });
  const social = environmentSection(browserOnly.services, { agent: browserOnly.vid, mode: GENERAL, route: route() }, undefined, WIN);
  assert.ok(social.includes("Screen: browser.* browses websites in my own profile (the person can watch and take over); the person's own browsers on this screen keep their logins and autofill."), social);
  assert.ok(!/colleague in computer mode/.test(social), 'the person\'s own browsers need no other mode now');
  assert.ok(!social.includes('computer.*'), 'no computer tool named where the mode has none');
  assert.ok(social.split('\n').includes(`Browser, where: ${whereHint(false)}`), 'B-080: without computer.* the Browser line leaves the person\'s own Chrome out');
  assert.equal(osName({ platform: 'darwin', version: 'Darwin Kernel', release: '24.1.0', hostname: 'mac' }), 'macOS (Darwin 24.1.0)');
});

test('no engine adds an instructions file of the person (Codex in an Autark home, Claude without CLAUDE.md): one line says a folder\'s own is a file', () => {
  const f = setup({ tools: [] });
  for (const engine of ['codex', 'claude', 'openai'] as const) {
    const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: { ...route(), engine } }, undefined, WIN);
    assert.ok(!text.includes('# AGENTS.md instructions') && text.endsWith(`\n${INSTRUCTION_FILES_LINE}`), text);
  }
  assert.doesNotMatch(HELPER_NOTE, /AGENTS|Codex|exec|wait|request_user_input/, 'the helper thread\'s note names no engine\'s tools or files either');
});

test('B-080: the Windows shell line – off Windows none; the PowerShell 5.1 sentences only where pwsh 7 is missing', (t) => {
  const programs = mkdtempSync(path.join(os.tmpdir(), 'wf-env-pwsh-'));
  t.after(() => rmSync(programs, { recursive: true, force: true }));
  assert.equal(windowsShellLine('darwin', { ProgramFiles: programs }), '');
  assert.equal(windowsShellLine('linux', {}), '');
  const without = windowsShellLine('win32', { ProgramFiles: programs });
  // B-080 wave 3 (codex-native-shell-wrapper, live 09.11.2026: python -c "…" lost its inner quotes): the 5.1 line names it.
  assert.equal(without, 'Shells here: Python runs in UTF-8 (PYTHONUTF8=1) and finds the person\'s packages (tzdata …); `python -I` leaves both out, so my own scripts run as plain python and with -I I add -X utf8. PowerShell is Windows PowerShell 5.1: Get-Content and Set-Content read and write ANSI unless I pass -Encoding utf8, and text piped into a program arrives as ASCII (ä becomes ?) unless $OutputEncoding is UTF-8 – in my engine\'s own PowerShell a command that pipes such text starts with $OutputEncoding=[Text.UTF8Encoding]::new($false). Windows PowerShell 5.1 hands a program its arguments without their inner double quotes, so code with quotes reaches python or node whole from a file.');
  // B-080 review: shell.exec sets $OutputEncoding itself (files.ts windowsShell) – named where the turn offers it
  const withShell = windowsShellLine('win32', { ProgramFiles: programs }, true);
  assert.ok(withShell.includes('unless $OutputEncoding is UTF-8 – shell.exec sets it; in my engine\'s own PowerShell'), withShell);
  for (const line of [without, withShell]) assert.doesNotMatch(line, /\b(you|must|never|only if|allowed)\b/i, 'first person, facts');
  const offered = setup({ tools: ['shell.exec'] });
  const shellText = environmentSection(offered.services, { agent: offered.vid, mode: GENERAL, route: route() }, undefined, WIN);
  if (shellText.includes('PowerShell 5.1')) assert.ok(shellText.includes('shell.exec sets it'), shellText);
  const bare = setup({ tools: [] });
  const noShell = environmentSection(bare.services, { agent: bare.vid, mode: GENERAL, route: route() }, undefined, WIN);
  assert.ok(!noShell.includes('shell.exec'), 'no shell.exec named where the turn does not offer it');
  if (process.platform === 'win32') { // the pwsh lookup reads Windows paths
    mkdirSync(path.join(programs, 'PowerShell', '7'), { recursive: true });
    writeFileSync(path.join(programs, 'PowerShell', '7', 'pwsh.exe'), '');
    const pwsh = windowsShellLine('win32', { ProgramFiles: programs });
    assert.ok(pwsh.startsWith('Shells here: Python runs in UTF-8') && !pwsh.includes('PowerShell 5.1'), pwsh);
    assert.ok(pwsh.endsWith(' My shell is PowerShell 7: text piped into programs and written by Set-Content stays UTF-8.'), pwsh);
    assert.ok(!pwsh.includes('inner double quotes') && !pwsh.includes('shell.exec'), 'B-080 wave 3: no 5.1 quoting fact, no shell.exec where the turn does not offer it');
    assert.ok(windowsShellLine('win32', { ProgramFiles: programs }, true).endsWith(' My shell and shell.exec are PowerShell 7: text piped into programs and written by Set-Content stays UTF-8.'));
  }
  const f = setup({ tools: [] });
  const mac = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: route() }, undefined, { platform: 'darwin', version: '', release: '24.1.0', hostname: 'mac' });
  assert.ok(!mac.includes('Shells here'), mac);
  const win = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: route() }, undefined, WIN).split('\n');
  assert.ok(win[1].startsWith('This PC:') && win[2].startsWith('Shells here:'), 'right after the This PC line');
});

// B-080 wave 3 (live 08.–09.11.2026: pwsh 7 was looked for in %ProgramFiles% only): the line checks the same PowerShell 7
// the engines get on their PATH (engines/wf-shim.ts pwshDir) – the per-user install included.
test('B-080 wave 3: the engines\' per-user PowerShell 7 counts – the line states the PowerShell 7 fact and drops the 5.1 sentences', { skip: process.platform !== 'win32' ? 'Windows paths' : undefined }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-env-pwsh-user-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ProgramFiles: path.join(root, 'programs'), LOCALAPPDATA: path.join(root, 'local'), PATH: path.join(root, 'nothing') };
  assert.ok(windowsShellLine('win32', env).includes('PowerShell 5.1'), 'none yet: the 5.1 sentences');
  const user = path.join(root, 'local', 'Microsoft', 'powershell');
  mkdirSync(user, { recursive: true });
  writeFileSync(path.join(user, 'pwsh.exe'), '');
  const line = windowsShellLine('win32', env, true);
  assert.ok(line.endsWith(' My shell and shell.exec are PowerShell 7: text piped into programs and written by Set-Content stays UTF-8.'), line);
  assert.ok(!line.includes('5.1') && !line.includes('$OutputEncoding') && !line.includes('inner double quotes'), line);
  assert.doesNotMatch(line, /\b(you|must|never|only if|allowed)\b/i, 'first person, facts');
});

/** The folders above `dir`, nearest first. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let probe = path.dirname(dir); out.at(-1) !== probe; probe = path.dirname(probe)) out.push(probe);
  return out;
}

test('the workspace line is one plain fact', () => {
  const workspace = path.resolve('/team/Workforce');
  assert.equal(workspaceLine(workspace), `Workspace: ${workspace} – the team's working folder (projects and the files I make).`);
  assert.equal(workspaceLine(''), '');
});

test('B-080: below 2 GB free the volatile environment names the disk, rounded down to 0.1 GB; more, or unknown, gives no line', () => {
  const f = setup({ tools: ['files.read'] });
  const GB = 1024 ** 3;
  const line = (gb: string) => `This PC's disk has only ${gb} GB free. I make room before it is full – temp files, caches and build output that rebuilds itself – and keep everyone's work and data.`;
  assert.equal(diskLine(f.services, () => 1.45 * GB), line('1.4'));
  assert.equal(diskLine(f.services, () => 0.05 * GB), line('0.0'));
  assert.equal(diskLine(f.services, () => 5 * GB), '');
  assert.equal(diskLine(f.services, () => 2 * GB), '', 'from 2 GB on: nothing to say');
  assert.equal(diskLine(f.services, () => undefined), '');
  const now = (free: number) => environmentNow(f.services, { agent: f.vid, mode: GENERAL }, () => free);
  assert.ok(now(1.45 * GB).includes(`\n${line('1.4')}`), now(1.45 * GB));
  assert.equal(now(1.41 * GB), now(1.49 * GB), 'the same 0.1 GB step: the same section text, so the volatile delta sends nothing new');
  assert.notEqual(now(1.39 * GB), now(1.41 * GB), 'the next step down: a new text');
  assert.ok(!now(5 * GB).includes('disk'), now(5 * GB));
  const probed: string[] = [];
  environmentNow(f.services, { agent: f.vid, mode: GENERAL }, (dir) => { probed.push(dir); return undefined; });
  assert.deepEqual(probed, [path.resolve('/appdata/Workforce')], 'the data folder\'s disk');
});

test("H1: no line on Codex's sub-agent note in the environment (it stood before that note); the Codex adapter's app note says it", () => {
  const f = setup({ tools: ['agents.create', 'tasks.create'] });
  const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: { ...route(), engine: 'codex' } }, undefined, WIN);
  assert.ok(!/sub-agent|ordinary tools of yours/.test(text), text);
});

test('the stable prompt carries the environment after My SYSTEM.md and before the mode', () => {
  const f = setup({ tools: ['web.search', 'web.fetch'] });
  const { stable } = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() });
  assert.equal(ENVIRONMENT_HEADER, '## My environment', 'B-075: the agent\'s own environment');
  assert.ok(stable.includes(`${ENVIRONMENT_HEADER}\nThis PC:`), 'environment section present');
  assert.ok(stable.indexOf(ENVIRONMENT_HEADER) < stable.indexOf('## Mode: Video'), 'before the mode');
});

test('stable environment: the person\'s files, the data folder and its map; without file tools neither is promised; the live part has no PC reach', () => {
  const f = setup({ tools: ['files.read', 'files.list', 'files.search'] });
  const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(text.includes(`\nThe person's own files: ${os.homedir()} and its folders – files.search without a path searches the workspace, then this folder.\n`), text);
  assert.equal(environmentNow(f.services, { agent: f.vid, mode: GENERAL }, () => undefined), '', 'nothing moves on its own: no live section');
  // E1: where the person's files are – only with a file tool; the search remark (F2/G1: what a search without a path covers) only with files.search.
  assert.equal(homeLine(new Set(['files.read']), 'C:\\Users\\Ada'), "The person's own files: C:\\Users\\Ada and its folders.");
  assert.equal(homeLine(new Set(['web.fetch']), 'C:\\Users\\Ada'), '');
  assert.equal(homeLine(new Set(['files.read', 'files.search']), '/home/ada', true), "The person's own files: /home/ada and its folders.", 'an engine with file tools of its own: no Autark file tool named');
  assert.ok(text.includes(`Data folder: ${path.resolve('/appdata/Workforce')} – the Autark system's own files (settings.json`) && text.includes(`${path.join(path.resolve('/appdata/Workforce'), 'README.md')} maps them.`), text);
  assert.ok(!/Change them|to change the app/.test(text), `G1: the data folder is a fact, no instruction\n${text}`);
  const bare = setup({ tools: [] });
  const none = environmentSection(bare.services, { agent: bare.vid, mode: GENERAL, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(!none.includes('files.read') && !none.includes('Data folder') && !none.includes('PC reach'), none);
});

test('volatile environment: accounts needing a sign-in in every mode, labels only (no e-mail), the tool only when offered', () => {
  const accounts = [
    account('acc_1', { label: 'Codex · alex@example.com', email: 'alex@example.com', state: 'needs_login', home: '/home/alex/.codex' }),
    account('acc_2', { provider: 'claude', label: 'Claude Max', state: 'ok' }),
    account('acc_3', { label: 'Old', state: 'needs_login', enabled: false }),
  ];
  const f = setup({ tools: ['accounts.sign_in'], accounts });
  const text = environmentNow(f.services, { agent: f.vid, mode: VIDEO_MODE });
  assert.ok(text.includes('Accounts needing sign-in: Codex (codex, acc_1) – accounts.sign_in starts the official sign-in.'), text);
  assert.ok(!text.includes('alex@example.com') && !text.includes('.codex') && !text.includes('Old'), text);
  const without = setup({ tools: [], accounts });
  assert.ok(environmentNow(without.services, { agent: without.vid, mode: GENERAL }).includes('Accounts needing sign-in: Codex (codex).'));
});

test('stable environment: where memory is and what it holds, one fact line in every mode – knowledge.find named only where offered', () => {
  const f = setup({ tools: ['knowledge.find'] });
  const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  const root = path.join(path.resolve('/appdata/Workforce'), 'memory');
  assert.ok(text.includes(`\nMemory: ${root} – what we have learned and saved: people, partners, places, their rules and wishes, and how work is done here; one Markdown note per subject, in folders. knowledge.find finds a note by the names and words of a job.`), text);
  assert.equal(memoryLine(setup({ tools: [] }).services, new Set()), `Memory: ${root} – what we have learned and saved: people, partners, places, their rules and wishes, and how work is done here; one Markdown note per subject, in folders.`);
});

test('no memory list or count in the context, whatever is saved (constant cost at any size)', () => {
  const f = setup({ tools: ['knowledge.find'] });
  const before = environmentNow(f.services, { agent: f.vid, mode: GENERAL });
  f.knowledge.save({ title: 'Likes short answers', body: 'Alex prefers short answers.', scope: 'global', kind: 'preference', createdBy: 'human' });
  assert.equal(environmentNow(f.services, { agent: f.vid, mode: GENERAL }), before);
  assert.doesNotMatch(before, /already know|saved note|nothing saved/);
});


/** B-075 (owner 04.11.2026: an agent knew neither the person's other company nor the linked PC it was asked about). */
test('volatile environment: the companies on this PC and the linked PCs by name – only with more than one company or a linked PC', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-env-companies-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const first = path.join(tmp, 'Autark');
  const dir = path.join(tmp, 'Autark Companies');
  mkdirSync(first, { recursive: true });
  writeFileSync(path.join(first, 'settings.json'), '{ "profile": { "company": "Teydra lab" } }');
  const pcs = [
    { id: 'dev_self', name: 'office-pc', kind: 'pc', status: 'online', self: true },
    { id: 'dev_nb', name: 'laptop', kind: 'pc', status: 'online', self: false },
    { id: 'dev_old', name: 'attic', kind: 'pc', status: 'revoked', self: false },
    { id: 'dev_ph', name: 'Pixel', kind: 'phone', status: 'online', self: false },
  ];
  const wire = (f: ReturnType<typeof setup>, devices: typeof pcs) => Object.assign(f.services as unknown as Record<string, unknown>, {
    host: { app: { dataDir: first, companies: { first, dir } } },
    devices: { list: () => devices, online: (id: string) => id === 'dev_nb' },
  });

  const alone = setup({ tools: ['tools.call'] });
  wire(alone, pcs.slice(0, 1));
  assert.equal(companiesLine(alone.services, new Set(['tools.call'])), '', 'one company, no linked PC: no line');
  assert.ok(!environmentNow(alone.services, { agent: alone.vid, mode: GENERAL }).includes('Companies on this PC'));

  const linked = setup({ tools: ['tools.call'] });
  wire(linked, pcs);
  assert.equal(companiesLine(linked.services, new Set(['tools.call'])), 'Companies on this PC: Teydra lab (this one) · Linked PCs: laptop (online).');

  mkdirSync(path.join(dir, 'company-2'), { recursive: true });
  const two = setup({ tools: ['tools.call'] });
  wire(two, pcs);
  const text = environmentNow(two.services, { agent: two.vid, mode: GENERAL });
  // Umzug 21.11.2026: in the agent's own environment the linked PCs carry one clause on where its record goes.
  assert.ok(text.includes('Companies on this PC: Teydra lab (this one), company-2 – tools.call with company: "<name>" runs a tool in another one · Linked PCs: laptop (online) – my record goes with me to the PC I work on; while mine is off I wait for it – agents.update homes names the PCs that go on with me.'), text);
  assert.equal(companiesLine(two.services, new Set()), 'Companies on this PC: Teydra lab (this one), company-2 · Linked PCs: laptop (online).', 'the way only where tools.call is offered');
  wire(two, pcs.slice(0, 1));
  assert.equal(companiesLine(two.services, new Set()), 'Companies on this PC: Teydra lab (this one), company-2.', 'several companies, no linked PC');
  const headless = setup({ tools: [] });
  Object.assign(headless.services as unknown as Record<string, unknown>, { host: { app: { dataDir: first } }, devices: { list: () => { throw new Error('no devices'); } } });
  assert.equal(companiesLine(headless.services, new Set()), '', 'no company folders, no devices: nothing');
});

test('B-078: the person\'s profile.notes in the stable part (the language stance lives in How I work); B-089: the models line (price, smarts, how a turn is paid) is the volatile section after "My environment now"', () => {
  const f = setup({ accounts: [account('acc_claude', { provider: 'claude', label: 'Claude Code' })] });
  const s = f.services as unknown as Record<string, unknown>;
  const opus = { id: 'claude:claude-opus-5-5', provider: 'claude', model: 'claude-opus-5-5', name: 'Claude Opus 5.5', engine: 'claude', efforts: [], caps: {}, tier: 'frontier', relCost: 0.4, smarts: 94, price: { inputPerM: 4, outputPerM: 20, source: 'priors' }, strengths: { chat: 0.4 }, available: true, accounts: ['acc_claude'] };
  Object.assign(s, {
    settings: { get: () => ({ profile: { name: 'S', company: '', language: 'de', timezone: 'UTC', notes: 'English for code reviews,\nGerman for everything else; "du".' }, routing: {} }) },
    catalog: { list: () => [opus], get: () => opus },
  });
  const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: route() }, undefined, WIN);
  assert.ok(!text.includes('profile.language'), text);
  assert.ok(text.includes('How the person wants to be spoken to (profile.notes, kept by us agents): English for code reviews, German for everything else; "du".'), text);
  const line = 'Models I can use ($ in/out per 1M tokens · smarts 0–100 · how a turn is paid): Claude Opus 5.5 $4/$20 · 94 · plan. A plan costs me nothing per turn while its quota lasts';
  assert.ok(!text.includes('Models I can use'), 'B-089: no models line in the stable part');
  const sections = volatileSections(f.services, { agent: f.vid, route: route() });
  const names = sections.map((section) => section.name);
  const models = sections.find((section) => section.name === 'models');
  assert.ok(models?.text.startsWith(line), models?.text);
  assert.equal(names.indexOf('models'), names.indexOf('now') + 1 + (names.includes('environment') ? 1 : 0), 'right after "Now" and the live environment (owner 15.11.: its engines line)');
  assert.equal(notesLine('  '), '');
});
