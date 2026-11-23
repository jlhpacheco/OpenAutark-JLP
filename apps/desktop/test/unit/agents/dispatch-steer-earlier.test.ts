// Live 09.11.2026 20:33: the owner's "Speicher dir das nicht als komische Regel" was folded as one line into Konrad's
// turn in an unrelated chat – his read cursor in the owner chat had been moved past the lines "das" meant by another
// thread's done turn. A fold of another chat now carries up to three lines just before the new ones, the agent's own
// too, marked as earlier and answered already; none when the chat has none or this turn already had them; bounded in
// characters (agents/dispatch-steer.ts). They reach up to the first new line (my own answer after the cursor comes
// along), leave out this turn's own lines and rows without text, and read as the delta (mini-app, failed/stopped note).
// Owns: these assertions only. Never: real engines or the dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../context/fixture.ts';
import { NEW_LINES, steerInput, steerOther, type RunningWork } from '../../../src/runtime/agents/dispatch-steer.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';

const EARLIER = 'Earlier in that chat, already answered – the context of what is new:';

/** 13.11.2026: a line's label "[ch_… "T" · Name · HH:MM #n] " read back as "[HH:MM] Name: " (the owner without "(CEO)"), so these checks read the lines' content. */
const said = (text: string) => text.split('\n').map((line) => line.replace(/^\[[^\]]*? · ([^·\]]+?) · (\d\d:\d\d) #\d+\] /, (_all, who: string, at: string) => `[${at}] ${who.replace(/ \(CEO\)/, '')}: `)).join('\n');

function running(conversationId: string): { run: RunningWork; texts: string[] } {
  const texts: string[] = [];
  const engine = { id: 'codex', steer: async (_runId: string, text: string) => { texts.push(said(text)); return true; } } as unknown as Engine;
  return { run: { agentId: 'ag_vid', runId: 'run_work', conversationId, control: { engine, lastSeq: 0, steeredSeq: 0 } }, texts };
}

test('a short line from another chat comes with the lines just before it, marked as earlier, when the read cursor is past them (live 09.11.2026 20:33)', async () => {
  const f = fixture();
  const work = f.chats.create({ title: 'Netlify', agentIds: [f.vid.id], createdBy: 'human' });
  const owner = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  f.chats.send({ conversationId: owner.id, body: 'Wie war das mit der Doris-Mail?', authorId: 'human' });
  f.chats.send({ conversationId: owner.id, body: 'Fehlender Beleg heißt nicht, dass nichts passiert ist.', authorId: 'human' });
  f.chats.send({ conversationId: owner.id, body: 'Verstanden, ich speichere das als Vereinbarung.', authorId: f.vid.id, authorKind: 'agent' });
  const answered = f.chats.send({ conversationId: owner.id, body: 'Ok, danke.', authorId: 'human' });
  f.chats.markRead(owner.id, f.vid.id, answered.seq); // another thread's done turn read them
  const line = f.chats.send({ conversationId: owner.id, body: 'Speicher dir das nicht als komische Regel', authorId: 'human' });
  const { run, texts } = running(work.id);

  assert.equal(await steerOther(f.services, run, owner.id, () => true), 'all');
  const shown = texts[0].split('\n');
  assert.equal(shown[0], NEW_LINES, 'the frame stays: the lines name their chat themselves');
  assert.equal(shown[1], EARLIER);
  assert.deepEqual(shown.slice(2, 5).map((text) => text.replace(/^\[[^\]]+\] /, '')), [
    'Alex: Fehlender Beleg heißt nicht, dass nichts passiert ist.',
    'Vic (me): Verstanden, ich speichere das als Vereinbarung.',
    'Alex: Ok, danke.',
  ], 'the three lines just before, my own among them; the fourth stays out');
  assert.equal(shown[5], 'New:');
  assert.match(shown[6], /^\[[^\]]+\] Alex: Speicher dir das nicht als komische Regel$/);
  assert.equal(shown.length, 7);
  assert.equal(run.control.others?.get(owner.id)?.seq, line.seq);
  assert.equal(f.chats.members(owner.id).find((member) => member.memberId === f.vid.id)!.readSeq, answered.seq, 'the cursor there stays');

  f.chats.send({ conversationId: owner.id, body: 'Ich nehme sie raus.', authorId: f.vid.id, authorKind: 'agent', runId: 'run_work' }); // this turn's chat.send there
  f.chats.send({ conversationId: owner.id, body: 'Und sag es Nora.', authorId: 'human' });
  assert.equal(await steerOther(f.services, run, owner.id, () => true), 'all');
  assert.equal(texts[1].split('\n').length, 2, 'this turn has the earlier lines already: only the new one');
  assert.match(texts[1], /\] Alex: Und sag es Nora\.$/);
  assert.doesNotMatch(texts[1], /Earlier in that chat|Speicher dir das/);
});

const unstamped = (text: string) => text.replace(/^\[[^\]]+\] /, '');

test('my own answer that a done turn posted before it moved the cursor comes along; this turn\'s own lines there stay out, another lane\'s come (live 09.11.2026 20:33)', async () => {
  const f = fixture();
  const work = f.chats.create({ title: 'Netlify', agentIds: [f.vid.id], createdBy: 'human' });
  const owner = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  f.chats.send({ conversationId: owner.id, body: 'Wie war das mit der Doris-Mail?', authorId: 'human' });
  const asked = f.chats.send({ conversationId: owner.id, body: 'Fehlender Beleg heißt nicht, dass nichts passiert ist.', authorId: 'human' });
  f.chats.postAgentMessage(owner.id, f.vid.id, 'run_done', { body: 'Verstanden, ich speichere das als Vereinbarung.' }); // the answer first …
  f.chats.markRead(owner.id, f.vid.id, asked.seq); // … then that turn moves the cursor to the line it read (agents/turn-finish.ts)
  f.chats.send({ conversationId: owner.id, body: 'Speicher dir das nicht als komische Regel', authorId: 'human' });
  const { run, texts } = running(work.id);

  assert.equal(await steerOther(f.services, run, owner.id, () => true), 'all');
  assert.deepEqual(texts[0].split('\n').slice(1).map(unstamped), [
    EARLIER,
    'Alex: Wie war das mit der Doris-Mail?',
    'Alex: Fehlender Beleg heißt nicht, dass nichts passiert ist.',
    'Vic (me): Verstanden, ich speichere das als Vereinbarung.',
    'New:',
    'Alex: Speicher dir das nicht als komische Regel',
  ], 'the answer "das" means is there, right before the new line');

  f.chats.send({ conversationId: owner.id, body: 'Ich nehme sie raus.', authorId: f.vid.id, authorKind: 'agent', runId: 'run_work' }); // this turn wrote it
  f.chats.send({ conversationId: owner.id, body: 'Nora weiß es schon.', authorId: f.vid.id, authorKind: 'agent', runId: 'run_side' }); // another lane of mine
  f.chats.send({ conversationId: owner.id, body: 'Und sag es Nora.', authorId: 'human' });
  assert.equal(await steerOther(f.services, run, owner.id, () => true), 'all');
  assert.deepEqual(texts[1].split('\n').slice(1).map(unstamped), [EARLIER, 'Vic (me): Nora weiß es schon.', 'New:', 'Alex: Und sag es Nora.']);
});

test('earlier lines read as the delta: a mini-app by its title, a failed row with its note, a stop without text takes no place', async () => {
  const f = fixture();
  const work = f.chats.create({ title: 'Netlify', agentIds: [f.vid.id], createdBy: 'human' });
  const owner = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  f.chats.send({ conversationId: owner.id, body: 'Mach mir einen Plan.', authorId: 'human' });
  f.chats.send({ conversationId: owner.id, body: 'Als Mini-App bitte.', authorId: 'human' });
  const app = f.chats.postAgentMessage(owner.id, f.vid.id, 'run_a', { body: '```app title="Plan"\n<!doctype html><html><head><style>body{margin:0}</style></head><body>Plan</body></html>\n```', state: 'final' });
  const stopped = f.chats.postAgentMessage(owner.id, f.vid.id, 'run_b', { body: '', state: 'stopped', silent: true }); // the person's Stop before any text (agents/turn-finish.ts)
  const last = f.chats.postAgentMessage(owner.id, f.vid.id, 'run_c', { body: 'Ich schicke ihn auch an', state: 'failed' });
  f.chats.markRead(owner.id, f.vid.id, last.seq);
  f.chats.send({ conversationId: owner.id, body: 'Und jetzt?', authorId: 'human' });
  const { run, texts } = running(work.id);

  assert.equal(await steerOther(f.services, run, owner.id, () => true), 'all');
  const shown = texts[0].split('\n');
  assert.deepEqual(shown.slice(shown.indexOf(EARLIER) + 1, shown.indexOf('New:')).map(unstamped), [
    'Alex: Als Mini-App bitte.',
    'Vic (me): [mini-app "Plan"]',
    'Vic (me): Ich schicke ihn auch an',
    '(this message failed)',
  ], 'no HTML, no empty quiet line; the oldest gives way to the line before the mini-app');
});

test('nothing earlier when the chat has no earlier lines; the group frame carries them the same way', async () => {
  const f = fixture();
  const work = f.chats.create({ title: 'Netlify', agentIds: [f.vid.id], createdBy: 'human' });
  const fresh = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  f.chats.send({ conversationId: fresh.id, body: 'Hallo Vic', authorId: 'human' });
  const { run, texts } = running(work.id);
  assert.equal(await steerOther(f.services, run, fresh.id, () => true), 'all');
  assert.equal(texts[0].split('\n').length, 2, 'the frame and the line, as before');
  assert.doesNotMatch(texts[0], /Earlier in that chat|\nNew:/);
  assert.equal(steerInput(f.services, f.vid.id, fresh.id, 0, 'Heading:', { after: 0 })!.text.split('\n').length, 2);

  const group = f.chats.create({ title: 'Kernteam', agentIds: [f.manager.id, f.vid.id], createdBy: 'human' });
  f.chats.send({ conversationId: group.id, body: 'Plan für morgen steht.', authorId: f.manager.id, authorKind: 'agent' });
  const seen = f.chats.send({ conversationId: group.id, body: 'Gut so.', authorId: 'human' });
  f.chats.markRead(group.id, f.vid.id, seen.seq);
  f.chats.send({ conversationId: group.id, body: 'Ihr sollt das jetzt autonom versenden', authorId: 'human' });
  assert.equal(await steerOther(f.services, run, group.id, () => true), 'all');
  const shown = texts[1].split('\n');
  assert.equal(shown[0], NEW_LINES);
  assert.equal(shown[1], EARLIER);
  assert.match(shown[2], /\] Mia: Plan für morgen steht\.$/);
  assert.match(shown[3], /\] Alex: Gut so\.$/);
  assert.equal(shown[4], 'New:');
  assert.match(shown[5], /\] Alex: Ihr sollt das jetzt autonom versenden$/);
});

test('the earlier lines are bounded in characters: each body is cut, older ones give way, the new line stays whole', async () => {
  const f = fixture();
  const work = f.chats.create({ title: 'Netlify', agentIds: [f.vid.id], createdBy: 'human' });
  const owner = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  let last = 0;
  for (const letter of ['a', 'b', 'c']) last = f.chats.send({ conversationId: owner.id, body: letter.repeat(5000), authorId: 'human' }).seq;
  f.chats.markRead(owner.id, f.vid.id, last);
  const long = `Und das hier ${'x'.repeat(2500)}`;
  f.chats.send({ conversationId: owner.id, body: long, authorId: 'human' });
  const { run, texts } = running(work.id);
  assert.equal(await steerOther(f.services, run, owner.id, () => true), 'all');
  const shown = texts[0].split('\n');
  const head = shown.indexOf(EARLIER);
  const tail = shown.indexOf('New:');
  const earlier = shown.slice(head + 1, tail);
  assert.ok(earlier.join('\n').length <= 1500, `the earlier block stays within its bound (${earlier.join('\n').length})`);
  assert.deepEqual(earlier.map((text) => /: ([abc])\1+…$/.exec(text)?.[1]), ['b', 'c'], 'the newest kept, each body cut; the oldest gives way');
  assert.match(shown[tail + 1], new RegExp(`Alex: Und das hier x{1987}…$`), 'the new line keeps its own bound (2000)');
});
