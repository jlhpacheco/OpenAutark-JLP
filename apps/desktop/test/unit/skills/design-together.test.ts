// B-081 (owner 08.11.2026: shape a look live with the person, pins, the AI rings the person): the standard skill
// design-together is tagged for the modes that offer every tool it names (registry rule), names only tools that exist,
// and is reached from web-dev-workflow as an offer the agent makes itself when a look comes down to taste; the call
// sentence stands in team-coordination's "Reaching the person"; chat areas and global read as decision 5 says, and the
// logins stay the ones the person made in those tabs (one sign-in for every area).
// The lines the skill quotes (a pin's first line, the person's pointer line and its 5 minutes) are checked against the
// code once that code is in (page-pick.ts, POINTER_PERSON_TTL_MS).
// Owns: these assertions only. Never: writes resources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import { parseMode } from '../../../src/runtime/modes/service.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import * as pointers from '../../../src/shared/model/pointers.ts';
import { browserShowTools } from '../../../src/runtime/browser/show-tool.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RESOURCES = path.join(APP, 'resources');
const skill = (name: string) => parseFrontMatter(readFileSync(path.join(RESOURCES, 'skills', name, 'SKILL.md'), 'utf8'));
const design = skill('design-together');
const tagged = (design.data.metadata as { modes?: string[] } | undefined)?.modes ?? [];
const named = (spaces: Set<string>) => [...design.body.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((match) => match[1]!).filter((name) => spaces.has(name.split('.')[0]!));
/** Tools defined in the runtime's source but registered later (tools/builtin/index.ts, B-081 wave 3). */
const WAVE_3 = new Set<string>(); // chat.call is registered since wave 3

/** Every tool name the runtime defines: `name: 'x.y'` in a tool definition or a `…_TOOL = 'x.y'` constant. */
function toolNames(): Set<string> {
  const names = new Set<string>();
  const src = path.join(APP, 'src', 'runtime');
  for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    for (const match of readFileSync(path.join(src, file), 'utf8').matchAll(/(?:\bname: |_TOOL = )'([a-z]+\.[a-z_]+)'/g)) names.add(match[1]!);
  }
  return names;
}

test('design-together: says when I read it (an offer when a look is taste), short enough for knowledge.find, tagged for modes that exist', () => {
  const description = String(design.data.description);
  assert.match(description, /^I read this when a look comes down to taste and I offer to shape it with the person, or we already do/);
  assert.ok(description.length <= 240, `${description.length} characters`);
  const modes = readdirSync(path.join(RESOURCES, 'modes')).filter((name) => name.endsWith('.md')).map((name) => name.replace(/\.md$/, ''));
  assert.deepEqual(tagged, ['web', 'browser']);
  assert.deepEqual(tagged.filter((key) => !modes.includes(key)), []);
});

test('design-together names only tools the runtime has (chat.call: T6, registered in wave 3)', () => {
  const names = toolNames();
  assert.ok(names.has('browser.show') && names.has('browser.eval') && names.has('files.search'), 'the scan finds tools');
  const used = named(new Set([...names].map((name) => name.split('.')[0]!)));
  assert.ok(used.length >= 5, used.join(', '));
  assert.deepEqual(used.filter((name) => !names.has(name) && !WAVE_3.has(name)), []);
  for (const name of ['browser.show', 'browser.eval', 'browser.screenshot', 'browser.tabs', 'chat.call']) assert.ok(used.includes(name), name);
  // the skills it points to exist
  for (const match of design.body.matchAll(/skill ([a-z][a-z-]+[a-z])/g)) assert.ok(existsSync(path.join(RESOURCES, 'skills', match[1]!, 'SKILL.md')), match[1]);
});

test('every mode the skill is tagged for offers each tool it names (device tools: the registry rule)', () => {
  const registry = new Registry({ services: () => ({}) as RuntimeServices });
  const agent = { id: 'ag_x', mode: 'web', permissions: {} } as unknown as Agent;
  const defs = new Map([...builtinTools(), ...browserTools({} as never)].map((tool) => [tool.name, tool]));
  const used = named(new Set([...defs.keys()].map((name) => name.split('.')[0]!))).filter((name) => !WAVE_3.has(name));
  assert.ok(used.includes('browser.eval') && used.includes('browser.show') && used.includes('files.search'), used.join(', '));
  assert.deepEqual(used.filter((name) => !defs.has(name)), [], 'each named tool is registered');
  for (const key of tagged) {
    const mode = parseMode(key, readFileSync(path.join(RESOURCES, 'modes', `${key}.md`), 'utf8'));
    assert.deepEqual(used.filter((name) => !registry.allowed(defs.get(name)!, agent, mode)), [], `${key} offers every tool the skill names`);
  }
  // KI-Runde 17.11.2026: every mode reaches the browser tools through tools.call; the skill's index is the mode's own tags.
  const general = parseMode('general', readFileSync(path.join(RESOURCES, 'modes', 'general.md'), 'utf8'));
  assert.equal(registry.allowed(defs.get('browser.eval')!, agent, general), true);
  assert.ok(!tagged.includes('general'), 'the skill still rides only in the modes it is tagged for');
});

/** A phrase of the skill, whatever its line breaks (the file wraps at 120 columns). */
const phrase = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));

test('design-together: the loop as one principle, the offer, pins, the pointer line, one change per step, variants, a call', () => {
  const body = design.body;
  assert.match(body, phrase('So the work is a loop: they show me the exact spot on the live page, I change exactly that, they see it at once and judge.'));
  assert.match(body, phrase('When a result comes down to taste and they have not asked for this yet, I offer it in one line'));
  assert.match(body, phrase('Pin button ("Pin an element"; Esc ends)'));
  assert.match(body, /`Pinned on <page> \(tab <id>\):`/);
  assert.match(body, phrase("In a running call a pin is a line of the call. Otherwise it lands in the chat's draft"));
  assert.match(body, phrase('`<name> (person) rests on <element>, last move <n> s ago` (or `is moving over …`), kept for 5 minutes'));
  assert.match(body, phrase('their words are relative to it'));
  assert.match(body, phrase("I open the page in this chat's area with `browser.show` (`where: 'chat'`)"));
  assert.match(body, phrase('One change per step, so the person can tie what they see to what I did'));
  assert.match(body, phrase("each its own tab in this chat's area (`browser.show` with `where: 'chat'` and `newTab: true`"));
  assert.match(body, phrase('I ring them with `chat.call`: `why` is the line their ringing screen shows, `say` my first sentence'));
  // Owner 08.11.: the principle, not example cases (no invented names, values or addresses to anchor on)
  assert.doesNotMatch(body, /Lukas|Buy now|localhost:\d|2 px|\?v=|## Pitfalls/);
});

test('web-dev-workflow offers design-together when a look is taste; team-coordination rings the person with chat.call', () => {
  const web = skill('web-dev-workflow').body;
  assert.match(web, /When a look comes down to taste, I offer to shape it with the person while they watch/);
  assert.match(web, phrase('when they ask for it themselves, I load design-together.'));
  assert.doesNotMatch(web, /2 px smaller/);
  const reaching = /## Reaching the person\n([\s\S]*?)\n## /.exec(skill('team-coordination').body)?.[1] ?? '';
  assert.match(reaching, phrase('When talking settles it faster than writing and they likely have time, I ring them with `chat.call`'));
});

test("decision 5: a chat's work goes in its area, global is the person's own across chats, logins made there hold in every area", () => {
  const guide = skill('app-guide').body;
  const model = skill('app-data-model').body;
  assert.match(guide, /each chat's area above its messages \(where I\s+put that chat's work – everyone in it finds it there, `where: 'chat'`\) and the global pane \(`where: 'global'`, the\s+person's own across chats\)/);
  assert.match(guide, /a login the person makes once in any of them holds in all of them/);
  assert.match(model, /A tab for a chat's work – a page, file, folder or media – I put in that chat's space \(`chat:<id>`/);
  assert.match(model, /with the logins the person made in them \(one sign-in for every area\)/);
  const showWhere = (browserShowTools[0]!.inputSchema.properties as Record<string, { description: string }>).where!.description;
  // 21.11.2026 (owner: "Ein Agent ist nicht ein Chat"): browser.show gives a person's pane by default; a chat's area is where: 'chat'
  assert.match(showWhere, /^chat: a chat's area instead of a person's pane; agent: my area on my agent page \(pages only\)\.$/);
  assert.match(browserShowTools[0]!.description, /where: 'chat' puts it in a chat's area instead \(this chat or chatId: everyone in that chat\)/);
  const readme = readFileSync(path.join(APP, 'src', 'runtime', 'root', 'readme.ts'), 'utf8');
  assert.match(readme, /\(global, the person\\'s own across chats\)/);
  assert.match(readme, /\(chat:<chat id>, shared by everyone in that chat – where that chat\\'s pages, files and media go\)/);
  // the logins stay the ones made in those tabs (B-080: not the person's other browsers')
  for (const text of [guide, model, showWhere, readme]) assert.doesNotMatch(text, /where the person works|with the person's logins/);
});

test('the lines the skill quotes are the ones the app writes, once that code is in', async () => {
  const exported = pointers as unknown as Record<string, unknown>;
  if (exported.POINTER_PERSON_TTL_MS !== undefined) {
    assert.equal(exported.POINTER_PERSON_TTL_MS, 5 * 60_000, 'the skill says 5 minutes');
    const now = 1_000_000;
    const point = { surface: 'side:web-3', actor: { kind: 'person' as const, id: 'human', name: 'Lukas' }, x: 10, y: 20, target: { role: 'button', name: 'Buy now' }, at: now - 40_000 };
    assert.match(pointers.pointersLine([point], 'ag_x', now), /^Lukas \(person\) rests on button "Buy now".*, last move 40 s ago$/);
  }
  const pickFile = path.join(APP, 'src', 'shared', 'model', 'page-pick.ts');
  if (existsSync(pickFile)) {
    const { pickText } = await import(pathToFileURL(pickFile).href) as { pickText: (pick: unknown) => string };
    const pick = { tab: 'web-3', url: 'http://localhost:5173/pricing', selector: 'button.buy', tag: 'button', box: { x: 100, y: 120, width: 200, height: 40 }, styles: {} };
    assert.match(pickText(pick).split('\n')[0]!, /^Pinned on \S+ \(tab web-3\):$/);
  }
});
