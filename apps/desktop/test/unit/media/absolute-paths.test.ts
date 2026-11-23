// B-080 (agents-guess-paths B; live: a colleague read `versand-2026-11-07/…` from its own folder and missed): a relative
// path in an agent message's text – a markdown link target, an inline code span with a separator, outside ``` fences –
// that exists under the workspace becomes its absolute path (media/outputs.ts absolutePaths); a missing path, a URL, an
// absolute path, a pattern, a path out of the workspace (`..`) and a path inside a fence stay as written; a posted line
// reaches its reader rewritten (chat/lifecycle.ts publish: stored before announce and delivery, at once – the send
// returns it so).
// Owns: these assertions only. Never: network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { absolutePaths, hasRelativePaths } from '../../../src/runtime/media/outputs.ts';
import type { Paths } from '../../../src/runtime/contracts.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { tempDir } from '../store/helpers.ts';
import { mediaSetup } from './setup.ts';

const F = '```';

function workspaceWith(files: string[], name = 'workspace') {
  const temp = tempDir();
  const workspace = path.join(temp.dir, name);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    writeFileSync(path.join(workspace, file), 'x');
  }
  return { temp, workspace, at: (file: string) => path.join(workspace, file) };
}

test('link targets and code spans that exist under the workspace become absolute; the rest stays as written', async () => {
  const w = workspaceWith(['versand/x.md', 'notes.md', 'a b/c.md'], 'workspace with spaces');
  try {
    const body = [
      'See [Bericht](versand/x.md) and `versand/x.md`, [notes](notes.md#part-2) and `a b/c.md`.',
      'Missing: [gone](versand/none.md) `versand/none.md`; web [site](https://example.com/x.md); absolute `C:/Users/x.md`;',
      'a pattern `versand/{x,y}.md`, a glob `versand/*.md`, a bare `x.md`.',
      F, 'cat versand/x.md `versand/x.md`', F,
    ].join('\n');
    assert.equal(hasRelativePaths(body), true);
    const out = absolutePaths(w.workspace, body).split('\n');
    assert.equal(out[0], `See [Bericht](<${w.at('versand/x.md')}>) and \`${w.at('versand/x.md')}\`, [notes](<${w.at('notes.md')}#part-2>) and \`${w.at('a b/c.md')}\`.`);
    assert.equal(out[1], body.split('\n')[1], 'a missing path, a URL and an absolute path stay');
    assert.equal(out[2], body.split('\n')[2], 'patterns and a span without a separator stay');
    assert.deepEqual(out.slice(3), [F, 'cat versand/x.md `versand/x.md`', F], 'a fence stays as written');
  } finally { w.temp.cleanup(); }
});

test('a link whose absolute path holds a space is written <…>; a body without candidates is untouched', async () => {
  const w = workspaceWith(['two words/r.md']);
  try {
    const out = absolutePaths(w.workspace, '[Report](two%20words/r.md) [Report](<two words/r.md>)');
    assert.equal(out, `[Report](two%20words/r.md) [Report](<${w.at('two words/r.md')}>)`);
    assert.equal(hasRelativePaths('Plain text, `npm test`, [site](https://example.com).'), false);
  } finally { w.temp.cleanup(); }
});

test('a path that leads out of the workspace with .. stays as written, also when it exists', async () => {
  const w = workspaceWith(['versand/x.md']);
  try {
    writeFileSync(path.join(w.temp.dir, 'outside.md'), 'x');
    const body = 'See [outside](../outside.md), `../outside.md` and `versand/../versand/x.md`.';
    assert.equal(absolutePaths(w.workspace, body), `See [outside](../outside.md), \`../outside.md\` and \`${w.at('versand/x.md')}\`.`);
  } finally { w.temp.cleanup(); }
});

test('a posted line reaches the chat and its reader with the absolute path', async () => {
  const s = mediaSetup();
  try {
    const workspace = path.join(s.temp.dir, 'workspace');
    mkdirSync(path.join(workspace, 'versand-2026-11-07'), { recursive: true });
    writeFileSync(path.join(workspace, 'versand-2026-11-07', 'abm.md'), '# ABM');
    s.h.services.paths = { workspace, accounts: path.join(s.temp.dir, 'accounts'), data: s.temp.dir, temp: path.join(s.temp.dir, 'tmp') } as Paths;
    let announced: Message | undefined;
    const off = s.h.bus.on('message.created', (message) => { if (message.authorId === 'ag_ada') announced = message; });
    const sent = s.h.chats.send({ conversationId: s.chat.id, authorId: 'ag_ada', body: 'Ready: `versand-2026-11-07/abm.md`' });
    off();
    const absolute = path.join(workspace, 'versand-2026-11-07', 'abm.md');
    assert.equal(sent.body, `Ready: \`${absolute}\``, 'the send returns it rewritten');
    assert.equal(announced?.body, sent.body, 'announced rewritten, at once');
    assert.equal(s.h.chats.message(sent.id)!.body, sent.body, 'stored');
  } finally { s.temp.cleanup(); }
});
