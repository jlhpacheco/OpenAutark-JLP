// B-066: skill routes (a viewer sees its own, each manager's up its chain, shared, built in; an own copy hides nothing
// from anyone outside its tree), always-visible skills in the prompt section, skills from any folder (knowledge.find
// with `in`, knowledge.open folder:<path>/<name>) and the shipped money and writing-skills descriptions.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '../fakes.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { findTools } from '../../../src/runtime/tools/builtin/find.ts';
import { lastPromptText, writeLastPrompt } from '../../../src/runtime/context/last-prompt.ts';
import { RESOURCES } from '../store/helpers.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

function writeSkill(dir: string, name: string, description: string, extra = '') {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${description}.\n`);
}

const agent = (id: string): Agent => ({ id, name: id, role: '', avatar: { kind: 'initials', value: 'A' }, instructions: '', mode: 'general', skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0 });

/** top manages mid manages low; other stands apart. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-routes-'));
  const resources = path.join(root, 'resources');
  const workspace = path.join(root, 'workspace');
  const chains: Record<string, string[]> = { low: ['mid', 'top'], mid: ['top'], top: [], other: [] };
  const own = (id: string) => path.join(workspace, 'agents', id, 'skills');
  writeSkill(path.join(resources, 'skills'), 'money', 'Built-in money', 'metadata:\n  always: true\n');
  writeSkill(path.join(resources, 'skills'), 'plain', 'Built-in plain');
  writeSkill(path.join(resources, 'skills'), 'shelf', 'Built-in shelf');
  writeSkill(path.join(workspace, 'skills'), 'shelf', 'Shared shelf');
  writeSkill(own('top'), 'money', 'Top money', 'metadata:\n  always: true\n');
  writeSkill(own('mid'), 'plain', 'Mid plain');
  writeSkill(own('low'), 'plain', 'Low plain');
  writeSkill(own('other'), 'money', 'Other money');
  writeSkill(own('other'), 'trick', 'Other trick');
  const skills = new SkillLibrary({ paths: { workspace, resources }, clock: new ManualClock(), home: '', chain: (id) => chains[id] ?? [] });
  return { root, workspace, own, skills };
}

test('a viewer gets its own skill, then each manager\'s up its chain, then shared, then built in', () => {
  const { root, skills } = fixture();
  try {
    const seen = (name: string, viewer?: string) => skills.get(name, viewer)?.info.description;
    assert.equal(seen('plain', 'low'), 'Low plain', 'own first');
    assert.equal(seen('plain', 'mid'), 'Mid plain');
    assert.equal(seen('plain', 'top'), 'Built-in plain', 'a report\'s copy does not reach upward');
    assert.equal(seen('plain', 'other'), 'Built-in plain', 'nor sideways');
    assert.equal(seen('money', 'low'), 'Top money', 'the tree under the manager');
    assert.equal(seen('money', 'other'), 'Other money');
    assert.equal(seen('money'), 'Built-in money', 'the person\'s view: an agent\'s copy hides nothing');
    assert.equal(seen('shelf', 'low'), 'Shared shelf', 'shared before built in');
    assert.equal(seen('trick', 'low'), 'Other trick', 'another agent\'s skill stays loadable by name');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the index holds what the route reaches: no colleague\'s skill', () => {
  const { root, skills } = fixture();
  try {
    const index = skills.indexFor(agent('low'), GENERAL_MODE);
    assert.deepEqual(index.map((info) => [info.name, info.description]), [['money', 'Top money'], ['plain', 'Low plain'], ['shelf', 'Shared shelf']]);
    assert.ok(!skills.indexFor(agent('top'), GENERAL_MODE).some((info) => info.name === 'trick'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('always-visible skills follow the route, and a mode-tagged one stays in its mode', () => {
  const { root, own, skills } = fixture();
  try {
    assert.deepEqual(skills.alwaysFor(agent('low'), GENERAL_MODE).map((info) => info.description), ['Top money']);
    assert.deepEqual(skills.alwaysFor(agent('other'), GENERAL_MODE).map((info) => info.description), [], 'its own copy has no always flag');
    writeSkill(own('low'), 'only-video', 'Video only', 'metadata:\n  always: true\n  modes: [video]\n');
    skills.invalidate();
    assert.ok(!skills.alwaysFor(agent('low'), GENERAL_MODE).some((info) => info.name === 'only-video'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saving: an own copy of a built-in or manager\'s skill keeps the always flag and reaches only the saver\'s tree', () => {
  const { root, workspace, skills } = fixture();
  try {
    const copy = skills.save({ name: 'money', description: 'Low money', body: 'Mine.', ownerAgentId: 'low' });
    assert.equal(copy.path, path.join(workspace, 'agents', 'low', 'skills', 'money'));
    assert.equal(copy.always, true, 'a copy stays always-visible');
    assert.equal(skills.get('money', 'low')!.info.description, 'Low money');
    assert.equal(skills.get('money', 'mid')!.info.description, 'Top money', 'above and beside it nothing changed');
    const shared = skills.save({ name: 'shelf', description: 'Shared shelf 2', body: 'Team.', ownerAgentId: 'low' });
    assert.equal(shared.path, path.join(workspace, 'skills', 'shelf'), 'a shared skill is improved where it is');
    const again = skills.save({ name: 'plain', description: 'Low plain 2', body: 'Mine.', ownerAgentId: 'low' });
    assert.equal(again.path, path.join(workspace, 'agents', 'low', 'skills', 'plain'), 'the own one is updated');
    assert.equal(skills.get('plain', 'mid')!.info.description, 'Mid plain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('knowledge.find with `in` and knowledge.open folder: read a folder of another provider as data', async () => {
  const { root } = fixture();
  try {
    const project = path.join(root, 'project');
    writeSkill(path.join(project, '.agents', 'skills'), 'deploy-steps', 'How this project deploys');
    writeSkill(path.join(project, '.agent', 'skills'), 'review-style', 'How reviews read here');
    const ctx = { services: { paths: { workspace: root } }, agent: agent('low') } as never;
    const tool = (name: string) => findTools.find((entry) => entry.name === name)!;
    const listed = JSON.stringify(await tool('knowledge.find').run({ in: [project] } as never, ctx));
    assert.match(listed, /deploy-steps/);
    assert.match(listed, /review-style/);
    assert.match(listed, /written outside this app/);
    assert.doesNotMatch(JSON.stringify(await tool('knowledge.find').run({ in: [project], query: 'reviews' } as never, ctx)), /deploy-steps/);
    assert.match(JSON.stringify(await tool('knowledge.open').run({ id: `folder:${project}/deploy-steps` } as never, ctx)), /Body of How this project deploys/);
    assert.equal((await tool('knowledge.open').run({ id: `folder:${project}/nothing` } as never, ctx) as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(await tool('knowledge.find').run({ in: [path.join(root, 'workspace', 'nowhere')] } as never, ctx)), /plain text: read them/);
    assert.equal((await tool('knowledge.find').run({ in: ['project'] } as never, ctx) as { isError?: boolean }).isError, true, 'a relative folder is neither memory nor a PC folder');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('knowledge.open loads a skill by its bare name on my route, with its folder; home: needs a home project', async () => {
  const skills = new SkillLibrary({ paths: { workspace: path.join(os.tmpdir(), 'wf-no-workspace'), resources: RESOURCES }, clock: new ManualClock(), home: '' });
  const ctx = { services: { skills, modes: { get: () => GENERAL_MODE }, paths: { workspace: os.tmpdir() } }, agent: agent('any'), mode: 'general' } as never;
  const open = findTools.find((entry) => entry.name === 'knowledge.open')!;
  const text = JSON.stringify(await open.run({ id: 'writing-skills' } as never, ctx));
  assert.match(text, /Skill loaded – how I work where it fits my task/);
  assert.match(text, /\(folder: [^)]*writing-skills\)/);
  const home = await open.run({ id: 'home:deploy' } as never, ctx) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(home.isError, true);
  assert.match(home.content[0].text, /Home projects are not available/);
});

test('the shipped chats, money and writing-skills skills are always visible and say when to read them', () => {
  const skills = new SkillLibrary({ paths: { workspace: path.join(os.tmpdir(), 'wf-no-workspace'), resources: RESOURCES }, clock: new ManualClock(), home: '' });
  const always = skills.alwaysFor(agent('any'), GENERAL_MODE);
  assert.deepEqual(always.map((info) => info.name), ['chats', 'money', 'writing-skills']);
  // B-075 (owner 04.11.2026): skill descriptions speak in the reader's own voice.
  assert.match(always[1].description, /^I read this before I spend or commit money/);
  assert.match(always[2].description, /^I read this before I write or change a skill, a memory or a brief/);
  assert.match(always[0].description, /^I read this when I am unsure where a line of mine belongs/);
});

test('last-prompt.md: written each turn into the agent\'s folder, never creating one, never failing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-last-'));
  try {
    const parts = { system: 'STABLE', input: 'INPUT' };
    writeLastPrompt(root, 'ag_gone', parts);
    mkdirSync(path.join(root, 'agents', 'ag_here'), { recursive: true });
    writeLastPrompt(root, 'ag_here', parts);
    assert.equal(readFileSync(path.join(root, 'agents', 'ag_here', 'last-prompt.md'), 'utf8'), lastPromptText(parts));
    assert.match(lastPromptText(parts), /# System prompt\n\nSTABLE\n\n# Input\n\nINPUT\n$/);
    writeLastPrompt(undefined, 'ag_here', parts);
    writeLastPrompt(root, '../escape', parts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
