// 21.11.2026 (owner: "Ein Agent ist nicht ein Chat … er wählt einen User und deren PC … wenn er nichts angibt, auf dem
// einzigen PC oder dem, wo er gerade ist … und kann es mit anderen teilen … und wieder zurückholen"): browser.show
// (src/runtime/browser/show-tool.ts) gives a page or the agent's own browser to the pane of the person it works for (its
// manager when that is a person, else the CEO) on their PC, or to the person and PC named; share gives others a view;
// back takes the agent's browser out of every pane it put it in, here and on the other PCs.
// Owns: these assertions only. Never: a real mesh, Electron or browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserShowTools } from '../../../src/runtime/browser/show-tool.ts';
import { shareOf } from '../../../src/runtime/pane/shares.ts';
import { paneRig } from './rig.ts';

const show = browserShowTools[0]!;
const textOf = (out: { content: Array<{ type: string; text?: string }> }) => out.content.find((part) => part.type === 'text')?.text ?? '';
const PCS: Array<[string, Record<string, unknown>]> = [['dev_note', { name: 'Notebook' }], ['dev_mac', { name: 'MacBook', personId: 'per_momo1234' }]];

function ctxOf(r: ReturnType<typeof paneRig>) {
  return { agent: { id: 'ag_ada', name: 'Ada' }, services: r.services, signal: new AbortController().signal, conversationId: 'ch_1' } as never;
}

test('by default my own browser goes into the CEO\'s pane on the PC I am on – not into a chat', async (t) => {
  const r = paneRig({ pcs: PCS });
  t.after(r.cleanup);
  const out = textOf(await show.run({}, ctxOf(r)));
  assert.match(out, /^My browser is now in the CEO's pane on Tower \(and their other PCs and phones\): they watch it live and can take it over/);
  assert.deepEqual(r.spaces(), { global: { shown: 'agent:ag_ada', tabs: [{ id: 'agent:ag_ada', panel: 'agent', agentId: 'ag_ada' }] } });
  assert.deepEqual(shareOf(r.services, 'agent:ag_ada'), { people: [], places: [{ person: 'human', pc: 'dev_tower', space: 'global' }] });
});

test('an agent of Momo\'s gives its browser to Momo\'s MacBook, shares it with everyone else, and takes it back from all of them', async (t) => {
  const r = paneRig({ pcs: PCS, manager: 'per_momo1234' });
  t.after(r.cleanup);
  const out = textOf(await show.run({ share: ['all'] }, ctxOf(r)));
  assert.match(out, /^My browser is now in Momo's pane on MacBook .* Also shared with the CEO, Lena\.$/s);
  assert.deepEqual(r.calls.map((call) => [call.device, call.method]), [['dev_mac', 'pane.put']]);
  assert.deepEqual(r.spaces()['person:per_lena1234']!.shown, 'agent:ag_ada', "Lena has no PC: her pane on the company's PCs");
  assert.equal(r.spaces().global!.shown, 'agent:ag_ada', "the CEO's pane here");
  assert.deepEqual(shareOf(r.services, 'agent:ag_ada'), {
    people: ['per_momo1234', 'per_lena1234'],
    places: [{ person: 'per_momo1234', pc: 'dev_mac', space: 'global' }, { person: 'human', pc: 'dev_tower', space: 'global' }, { person: 'per_lena1234', pc: 'dev_tower', space: 'person:per_lena1234' }],
  });
  assert.match(textOf(await show.run({ back: true }, ctxOf(r))), /^Took my browser back \(3 places\)/);
  assert.deepEqual(r.calls.at(-1), { device: 'dev_mac', method: 'pane.remove', params: { id: 'agent:ag_ada', space: 'global' } });
  assert.deepEqual(r.spaces(), {});
  assert.equal(shareOf(r.services, 'agent:ag_ada'), undefined, 'nobody reaches it any more');
});

test('a page opens on the PC named – there, with that PC\'s logins – and the agent names a PC by its name', async (t) => {
  const r = paneRig({ pcs: PCS });
  t.after(r.cleanup);
  const out = textOf(await show.run({ url: 'example.com', pc: 'Notebook' }, ctxOf(r)));
  assert.equal(out, "Opened https://example.com/ in the CEO's pane on Notebook (tab web-far).");
  assert.deepEqual(r.calls[0], { device: 'dev_note', method: 'pane.put', params: { entry: { id: '', url: 'https://example.com/' }, by: { id: 'ag_ada', name: 'Ada' } } });
  const here = textOf(await show.run({ url: 'example.com/a' }, ctxOf(r)));
  assert.equal(here, "Opened https://example.com/a in the CEO's pane on Tower (tab web-new).");
  assert.equal(r.opened[0]!.space, 'global');
});
