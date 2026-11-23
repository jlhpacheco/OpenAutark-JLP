// The main AI's memory search (Runde „Halb“ 21.11.2026, replacing the owner's rule (f) of 03.11. "the whole tree"): knowledge.find
// without `in` reads what is the agent's – company, its branch, its own folder, its chats, the references and free top folders –,
// with `in` the folders it names; the subconscious's thoughts file is never a hit. Rule (e) – "without an embedder it says it matched words" – ended
// with the word index (lane find 14.11.2026): every find matches by words now, so its output carries no such note.
// Owns: these assertions only. Never: real models, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { fixture } from '../context/fixture.ts';
import { findTools } from '../../../src/runtime/tools/builtin/find.ts';
import { memoryTools } from '../../../src/runtime/tools/builtin/memory.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const tool = (name: string) => findTools.find((item) => item.name === name)!;
const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

function world() {
  const f = fixture();
  const vera = f.org.add(agent('ag_vera', 'Vera', { role: 'Video editor' }));
  const wes = f.org.add(agent('ag_wes', 'Wes', { role: 'Web developer' }));
  const ctxOf = (who: Agent): ToolContext => ({ agent: who, runId: 'run_mem', mode: 'general', services: f.services, signal: new AbortController().signal, status: () => {} });
  return { ...f, vera, wes, ctxOf };
}

test("Runde „Halb“: knowledge.find without `in` reads what is the agent's – company, a free top folder, its own folder – not another agent's own folder; `in` names any", async () => {
  const f = world();
  f.knowledge.memoryWrite({ folder: 'agents/ag_vera', title: 'Schnittliste Brenner', text: 'Die Schnittliste für die Kanzlei Brenner liegt beim Projekt.' });
  f.knowledge.memoryWrite({ folder: 'agents/ag_wes', title: 'Formular Kanzlei Brenner', text: 'Das Kontaktformular der Kanzlei Brenner baue ich mit Tailwind.' });
  f.knowledge.memoryWrite({ folder: 'company/kunden', title: 'Versandregel Kanzlei Brenner', text: 'Die Kanzlei Brenner nimmt Unterlagen nur per Einschreiben an.' });
  f.knowledge.memoryWrite({ folder: 'kunden', title: 'Adresse Kanzlei Brenner', text: 'Die Kanzlei Brenner sitzt am Markt 3.' });
  f.knowledge.memoryWrite({ folder: '', title: 'Telefon Kanzlei Brenner', text: 'Die Kanzlei Brenner ist unter 0441 12345 erreichbar.' });
  // On the code before 21.11.2026 the whole tree: Wes found Vera's own notes as hits.
  const mine = textOf(await tool('knowledge.find').run({ query: 'Kanzlei Brenner', kinds: ['note'] }, f.ctxOf(f.wes)));
  assert.doesNotMatch(mine, /Schnittliste Brenner/, "another agent's own folder");
  assert.match(mine, /Versandregel Kanzlei Brenner/);
  assert.match(mine, /Formular Kanzlei Brenner/, 'my own folder');
  assert.match(mine, /Adresse Kanzlei Brenner/, 'a free top folder counts as company-wide');
  assert.match(mine, /Telefon Kanzlei Brenner/, 'a note directly in memory/ too');
  const named = textOf(await tool('knowledge.find').run({ query: 'Kanzlei Brenner', in: ['memory/agents/ag_vera'] }, f.ctxOf(f.wes)));
  assert.match(named, /Schnittliste Brenner/, 'the folder the caller named');
  assert.doesNotMatch(named, /Versandregel/);
});

test("the subconscious's thoughts file is no note: no find returns it, memory.browse does not list it", async () => {
  const f = world();
  f.knowledge.memoryWrite({ path: 'agents/ag_wes/thoughts.md', title: 'Thoughts', text: '2026-11-20 Kanzlei Brenner Formular wieder offen?' });
  f.knowledge.memoryWrite({ folder: 'agents/ag_wes', title: 'Formular Kanzlei Brenner', text: 'Das Kontaktformular der Kanzlei Brenner baue ich mit Tailwind.' });
  const found = textOf(await tool('knowledge.find').run({ query: 'Kanzlei Brenner Formular', kinds: ['note'] }, f.ctxOf(f.wes)));
  assert.match(found, /Formular Kanzlei Brenner/);
  assert.doesNotMatch(found, /thoughts/);
  const browse = memoryTools.find((item) => item.name === 'memory.browse')!;
  const listed = textOf(await browse.run({ folder: 'agents/ag_wes' }, f.ctxOf(f.wes)));
  assert.match(listed, /formular-kanzlei-brenner/);
  assert.doesNotMatch(listed, /thoughts\.md/);
});

test('without an embedder knowledge.find matches the words – an inflection and a compound too – and says nothing about an embedder', async () => {
  const f = world();
  Object.assign(f.services, { vectors: { available: () => false } });
  f.knowledge.memoryWrite({ folder: 'company/kunden', title: 'Zahlungsregel Hartwig Gießerei', text: 'Die Hartwig Gießerei bekommt Angebote nur gegen Vorkasse.' });
  const none = textOf(await tool('knowledge.find').run({ query: 'Segelboot Winterlager', kinds: ['note'] }, f.ctxOf(f.wes)));
  assert.match(none, /^Nothing fits\./);
  const found = textOf(await tool('knowledge.find').run({ query: 'Angebotspreis für die Gießereien von Hartwig', kinds: ['note'] }, f.ctxOf(f.wes)));
  assert.match(found, /^- \[note:company:kunden:[^\]]+\] memory note "Zahlungsregel Hartwig Gießerei"/m);
  assert.doesNotMatch(found, /embedder/);
});
