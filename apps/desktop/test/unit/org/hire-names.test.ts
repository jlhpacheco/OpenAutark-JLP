// B-047 (contract D9) hiring as colleagues: a hire without a name gets a free human first name, a name given stands
// as given (feedback 1b136d01, 19.11.2026: "Firmenberater" too),
// and every result returns the new agent's SYSTEM.md (path when the agent core is wired, the text) and – B-078 – one
// line that the file is the new agent's own and how I start them (a first line or task). agents.update writes my own
// SYSTEM.md whole.
// first-names.ts: the free-name pick.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { systemMdValues } from '../../../src/runtime/org/hire.ts';
import { FIRST_NAMES, freeFirstName } from '../../../src/runtime/org/first-names.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
settings.profile.name = 'Ada';
const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));

function setup(core = true) {
  const systemMd = (values: Readonly<Record<string, string>>, kind: 'manager' | 'agent' = 'agent') => prompts.renderText(`standard-${kind}`, { ...systemMdValues(settings), ...values });
  const org = new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents'), systemMd });
  const agentCore = core ? { folder: (id: string) => path.join('/data', 'agents', id) } : undefined;
  const services = { org, settings: { get: () => settings }, modes: { list: () => [{ key: 'research', name: 'Research' }] }, agentCore } as unknown as RuntimeServices;
  const manager = org.ensureSeed()!;
  const create = (args: Record<string, unknown>, as: Agent = manager): Promise<ToolOutput> =>
    agentOrgTools.find((tool) => tool.name === 'agents.create')!.run(args, { agent: as, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext);
  return { org, manager, create };
}
const data = (out: ToolOutput) => out.structured as Record<string, any>;

test('agents.update: my instructions are my whole SYSTEM.md – written as I send them', async () => {
  const { org, manager } = setup();
  const services = { org, settings: { get: () => settings }, prompts } as unknown as RuntimeServices;
  const update = (args: Record<string, unknown>): Promise<ToolOutput> =>
    agentTools.find((tool) => tool.name === 'agents.update')!.run(args, { agent: manager, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext);
  const text = '## My role\nChief of staff for Ada.\n\n## What I have here\n- Budget 50 EUR a month (Ada, 05.11.).';
  await update({ instructions: text });
  assert.equal(org.require(manager.id).instructions, text);
  const mine = `# How I work\nMy own way.\n\n${text}`;
  await update({ instructions: mine });
  assert.equal(org.require(manager.id).instructions, mine, 'an own How I work on top stays mine');
});

test('agents.update (B-078): another agent\'s SYSTEM.md is theirs – instructions are left out with a chat hint, other fields still apply', async () => {
  const { org, manager, create } = setup();
  const services = { org, settings: { get: () => settings }, prompts } as unknown as RuntimeServices;
  const update = (args: Record<string, unknown>, as: Agent = manager): Promise<ToolOutput> =>
    agentTools.find((tool) => tool.name === 'agents.update')!.run(args, { agent: as, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext);
  const mara = org.require(data(await create({ name: 'Mara', role: 'Researcher', instructions: 'Find sources.' })).agentId);
  const only = await update({ agentId: mara.id, instructions: 'Something else.' });
  assert.equal(only.isError, true);
  assert.match(String(only.content.map((part) => ('text' in part ? part.text : '')).join('')), /Nothing written\. SYSTEM\.md is Mara's own – they write it themselves\. I tell Mara in a chat what I would change/);
  assert.equal(org.require(mara.id).instructions, mara.instructions, 'her text stays');
  const mixed = data(await update({ agentId: mara.id, instructions: 'Something else.', role: 'Research lead' }));
  assert.match(mixed.instructions, /^Left as it is\. SYSTEM\.md is Mara's own/);
  assert.equal(org.require(mara.id).role, 'Research lead', 'the other fields apply');
  assert.equal(org.require(mara.id).instructions, mara.instructions);
});

test('the free first name is stable per seed and skips taken names', () => {
  assert.equal(freeFirstName('ag_1', () => false), freeFirstName('ag_1', () => false));
  const taken = new Set(FIRST_NAMES.slice(0, -1));
  assert.equal(freeFirstName('ag_1', (name) => taken.has(name)), FIRST_NAMES.at(-1));
  assert.equal(freeFirstName('ag_1', () => true), undefined);
});

test('agents.create: a name given stands as given, a missing name becomes a first name, the result carries the SYSTEM.md to adapt', async () => {
  const { org, manager, create } = setup();
  const named = data(await create({ template: 'researcher', name: 'Firmenberater' }));
  assert.equal(named.name, 'Firmenberater', 'a role as the name, when that is the name wanted');

  const team = data(await create({ agents: [{ template: 'researcher', name: 'Mara' }, { template: 'writer', name: 'Writer 2' }, { template: 'designer' }] }));
  assert.deepEqual(team.results.map((result: { ok: boolean }) => result.ok), [true, true, true], 'every hire of the team happens');
  const mara = team.results[0];
  assert.equal(mara.name, 'Mara');
  assert.equal(mara.role, 'Researcher');
  assert.equal(mara.system.path, path.join('/data', 'agents', mara.agentId, 'SYSTEM.md'));
  // The result carries the hire's own part of SYSTEM.md (its role and what it has here); the standard's How I work above it is the same for every hire.
  assert.ok(mara.system.text.startsWith('## My role\nResearcher.'), mara.system.text.slice(0, 80));
  assert.match(mara.system.text, /\n## What I have here\n- This PC is my workplace/);
  assert.doesNotMatch(mara.system.text, /# How I work|<<|Still open|<!--/, 'no standard text and no slots in the result');
  assert.match(mara.system.next, /^Mara starts from the team's standard SYSTEM\.md with the "who you are" I gave under "## My role" \(above: that part\) and makes the file their own in their first turn \(skill system-prompt\)\. I start Mara now with the brief for it: a first line in our 1:1 \(chat\.direct\)/);
  assert.match(mara.system.next, /\(tasks\.add for Mara\)\. Then I read what they wrote/, 'the field tasks.add takes');
  assert.match(org.get(mara.agentId)!.instructions, /^# How I work\n[\s\S]*\n\n## My role\nResearcher\./, 'the hire itself starts from the whole standard');
  const designer = org.get(team.results[2].agentId)!;
  assert.ok(FIRST_NAMES.includes(designer.name), `a free first name: ${designer.name}`);
  assert.equal(designer.role, 'Designer');
  assert.equal(designer.managerId, manager.id);
});

test('agents.create: a long own part is cut for the result only; every hire result starts the new agent instead of rewriting it (B-078)', async () => {
  const { create } = setup();
  const long = data(await create({ name: 'Theo', role: 'Archivist', instructions: `Archive well. ${'z'.repeat(6500)}` }));
  assert.equal(long.ok, true);
  assert.ok(long.system.text.endsWith('…') && long.system.text.length === 6000, 'the text is cut for the result');
  const short = data(await create({ name: 'Ida', role: 'Editor', instructions: 'Edit tight.' }));
  assert.equal(short.system.next, long.system.next.replaceAll('Theo', 'Ida'), 'one start line for every hire');
  assert.doesNotMatch(short.system.next, /agents\.update/, 'no rewrite of another agent\'s SYSTEM.md');
});

test('agents.create (B-078): a head stands beside me and reports to the person; a named manager still wins', async () => {
  const { org, manager, create } = setup();
  const head = data(await create({ template: 'head', name: 'Paula', role: 'Head of programming', instructions: 'I lead the software work.' }));
  assert.equal(head.ok, true);
  assert.equal(org.get(head.agentId)!.managerId, undefined, 'reports to the person');
  assert.equal(org.get(head.agentId)!.mode, 'manager');
  const text = org.get(head.agentId)!.instructions;
  assert.match(text, /## My role\nHead of programming\.\n[^\n]+\n\nI lead one area of the person's work[\s\S]*\(skill head-of-staff\)\.\n\nI lead the software work\.\n\n## What I have here\n/, 'head.md stays, the creator\'s "who you are" below it');
  const own = data(await create({ template: 'head', name: 'Rosa', role: 'Head of design', instructions: '## My role\nHead of design.\n\nI lead the look.\n\n## What I have here\n- The Figma account.' }));
  assert.match(org.get(own.agentId)!.instructions, /\n\n## My role\nHead of design\.\n\nI lead the look\.\n\nI lead one area of the person's work[\s\S]*\(skill head-of-staff\)\.\n\n## What I have here\n- The Figma account\.$/, 'an own part with its headings keeps them; head.md goes into the role');
  const under = data(await create({ template: 'head', name: 'Quinn', role: 'Head of video', managerId: manager.id }));
  assert.equal(org.get(under.agentId)!.managerId, manager.id);
});

test('agents.create: the secretary works for the person; she is started like any hire; no agent core, no path', async () => {
  const { create } = setup(false);
  const secretary = data(await create({ template: 'secretary', name: 'Ella' }));
  assert.equal(secretary.ok, true);
  assert.equal(secretary.system.path, undefined);
  assert.match(secretary.system.next, /^Ella starts from the team's standard SYSTEM\.md/);
  assert.match(secretary.system.text, /I report to the person directly/);
});
