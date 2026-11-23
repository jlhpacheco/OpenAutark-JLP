// Hire seed (org/hire.ts): every new agent starts from the team's standard SYSTEM.md of its kind (org/standard.ts:
// standard-manager.md for mode manager, else standard-agent.md), rendered with the person's name and the hire's role –
// "# How I work", "## My role" with its template's or creator's instructions right below the role lines, then
// "## What I have here". A text that begins with "# How I work" is a whole SYSTEM.md; one that begins with "## My role"
// is the whole own part and keeps the standard's "# How I work" above it. Without the standard (no prompt, a fake) a hire
// is unchanged.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { systemMdValues, withSystemMd } from '../../../src/runtime/org/hire.ts';
import type { StandardKind } from '../../../src/runtime/org/standard.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
settings.profile.name = 'Ada';
const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
const systemMd = (values: Readonly<Record<string, string>>, kind: StandardKind = 'agent') => prompts.renderText(`standard-${kind}`, { ...systemMdValues(settings), ...values });
const HAVE = /\n\n## What I have here\n- This PC is my workplace: its files and apps, [^\n]*Ada's logins[^\n]*\n- Money: how I handle it stands in what Ada and I agreed; within that I weigh a purchase the way my skill money does\.\n- Under Ada's name: [^\n]*\n- Agreements with Ada: none yet\.$/;
const START = 'I start from the team\'s standard text. In my first turn I take my name';

function setup(template: (values: Readonly<Record<string, string>>, kind: StandardKind) => string | undefined = systemMd) {
  return new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents'), systemMd: template });
}

test('owner 14.11.: a hire starts from the whole standard of its kind – How I work, its role with the template text, what it has here', () => {
  const org = setup();
  const manager = org.ensureSeed()!;
  assert.match(manager.instructions, /^# How I work\nThis company is my own work – Ada,/, 'the standard\'s How I work on top');
  assert.ok(manager.instructions.includes('\n## Leading\n'), 'the manager standard leads');
  assert.ok(manager.instructions.includes(`## My role\nPersonal manager.\n${START}`), 'its role line, then the line about making it its own');
  assert.match(manager.instructions, /\n\nI am the person's personal manager – their right hand/, 'the template text follows its role lines');
  assert.match(manager.instructions, HAVE, 'what it has here closes the text');
  assert.doesNotMatch(manager.instructions, /This is my SYSTEM\.md|\{\{|\}\}/, 'no preface, no placeholder');
  const writer = org.create({ template: 'writer', name: 'Wes', createdBy: manager.id });
  assert.ok(writer.instructions.startsWith('# How I work\n'));
  assert.ok(!writer.instructions.includes('## Leading'), 'a writer leads no one: the agent standard');
  assert.ok(writer.instructions.includes(`\n\n${org.template('writer')!.instructions.trim()}\n\n## What I have here`));
  assert.doesNotMatch(writer.instructions, /report to (Ada|Manager)/, 'the name of its manager is not frozen into the text');
  const own = org.create({ name: 'Quill', role: 'Editor', instructions: 'Edit tight.', createdBy: HUMAN_ID });
  assert.ok(own.instructions.includes(`## My role\nEditor.\n${START}`) && own.instructions.includes('\n\nEdit tight.\n\n## What I have here\n'));
  assert.match(own.instructions, HAVE);
});

test('an own what-I-have part, a whole own part and a whole SYSTEM.md are taken as they are', () => {
  const org = setup();
  const ownWhat = org.create({ name: 'Rio', role: 'Researcher', instructions: 'Find sources.\n\n## What I have here\n- Only the shared drive.', createdBy: HUMAN_ID });
  assert.equal((ownWhat.instructions.match(/## What I have here/g) ?? []).length, 1, 'an own what-I-have part replaces the standard\'s');
  assert.match(ownWhat.instructions, /- Only the shared drive\.$/);
  const whole = org.create({ name: 'Clara', role: 'Writer', instructions: '## My role\nI am Clara.', createdBy: HUMAN_ID });
  assert.match(whole.instructions, /^# How I work\n[\s\S]*\n\n## My role\nI am Clara\.\n\n## What I have here\n/, 'one role heading, How I work above, what I have here below');
  assert.equal((whole.instructions.match(/## My role/g) ?? []).length, 1);
  const mine = org.create({ name: 'Mo', role: 'Writer', instructions: '# How I work\nMy own way.\n\n## My role\nWriter.', createdBy: HUMAN_ID });
  assert.equal(mine.instructions, '# How I work\nMy own way.\n\n## My role\nWriter.', 'an own How I work keeps the whole text');
  const refined = org.update(ownWhat.id, { instructions: `${ownWhat.instructions}\n- Hosting renewals are settled (Ada, 05.11.).` }, { by: HUMAN_ID });
  assert.match(refined.instructions, /Hosting renewals are settled/);
});

test('without the standard a hire is unchanged; a text that would not fit beside it stays the person\'s', () => {
  const bare = setup(() => undefined).create({ name: 'Bo', role: 'Helper', instructions: 'Help.', createdBy: HUMAN_ID });
  assert.equal(bare.instructions, 'Help.');
  assert.equal(withSystemMd('Help.', ''), 'Help.');
  assert.equal(withSystemMd('Mine.', '## My role\nR.\n\n## What I have here\n- this PC'), '## My role\nR.\n\nMine.\n\n## What I have here\n- this PC', 'the own text sits between the role line and what I have here');
  assert.equal(withSystemMd('## My role\nMine.', '# How I work\nH.\n\n## My role\nR.\n\n## What I have here\n- this PC'), '# How I work\nH.\n\n## My role\nMine.\n\n## What I have here\n- this PC');
  assert.equal(withSystemMd('x'.repeat(59_990), '## My role\nR.\n\n## What I have here\n- this PC'), 'x'.repeat(59_990));
  assert.deepEqual(systemMdValues(settings), { owner: 'Ada', user_name: 'Ada' });
  // 19.11.2026: one PC line for every mode – the mode itself is the stable prompt's "What Ada and I agreed"
  assert.match(systemMd({ role: 'Helper' }), /\n\n## My role\nHelper\.\n[^\n]+\n\n## What I have here\n- This PC is my workplace: its files and apps, [^\n]*stands under "What Ada and I agreed"\./);
});

test('B-047: a hire without a name gets a free human first name and keeps the template role', () => {
  const org = setup();
  const manager = org.ensureSeed()!;
  assert.equal(manager.name, 'Manager', 'the seed keeps its role as a name until it names itself');
  const first = org.create({ template: 'researcher', createdBy: manager.id });
  const second = org.create({ template: 'researcher', createdBy: manager.id });
  for (const hire of [first, second]) {
    assert.match(hire.name, /^\p{Lu}\p{Ll}+$/u, `a first name, not a role: ${hire.name}`);
    assert.equal(hire.role, 'Researcher');
  }
  assert.notEqual(first.name, second.name, 'names stay unique');
  assert.equal(org.create({ template: 'writer', name: 'Writer', createdBy: HUMAN_ID }).name, 'Writer', 'an explicit name is the creator\'s choice (agents.create checks it)');
});
