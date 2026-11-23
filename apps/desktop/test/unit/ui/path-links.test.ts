// Paths in agent messages (src/ui/workspace/path-links.ts, B-081; 20.11.2026 FCMWO5R5: every path a file chip): which
// link targets and code spans are absolute paths (local-network paths and file: URLs too, never a public host), the
// marked tokenizers and renderers that make them a chip with data-path (never an href; Windows targets as written; the
// enclosing link or control wins), and what a click opens – on the author agent's home PC first, then this PC, as a
// folder, media or file tab in the global pane, on the phone a file that is no text saved like an attachment; on neither
// PC the tab on the PC asked first (its not-found page); an offline or unlinked home PC one toast; without
// files.readPath nothing asked, one toast why. The file block's and review's Open use it on every device (16.11.2026).
// Bare paths in text: path-text.test.ts.
// Owns: these assertions only. Never: a DOM, a real PC or a socket (rpc.call is stubbed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import type { PathRead } from '../../../src/shared/api/methods-files.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { SystemInfo } from '../../../src/shared/model/system.ts';
import { rpc, RpcError } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { agents, systemInfo } from '../../../src/ui/lib/store.ts';
import { toasts } from '../../../src/ui/lib/toasts.ts';
import { tabsOf } from '../../../src/ui/workspace/pages.ts';
import { NO_PATH_READ, openPathLink, pathIn, pathRenderer, pathTokenizer, plainInControl } from '../../../src/ui/workspace/path-links.ts';
import { readFileSync } from 'node:fs';

test('pathIn: absolute Windows and posix paths; a code span needs two posix segments; globs, placeholders and public network paths are text', () => {
  for (const path of ['C:\\Users\\ann\\Workforce\\a.md', 'C:/Users/ann/Workforce/openautark/README.md', 'C:/Users/ann/Workforce/', 'd:\\', 'C:\\w\\.git\\_draft\\a.md', '/home/me/report.txt', 'C:/My Docs/R&D.md']) {
    assert.equal(pathIn(path, false), path, path);
    assert.equal(pathIn(path, true), path, `${path} (span)`);
  }
  assert.equal(pathIn('C:/x/a.md\nC:/y/b.md', false), undefined, 'a line break is no path');
  assert.equal(pathIn('  C:/x/a.md  ', true), 'C:/x/a.md', 'trimmed');
  assert.equal(pathIn('/Users/me/x', true), '/Users/me/x');
  assert.equal(pathIn('/rpc', false), '/rpc', 'a link target may be one segment');
  for (const text of ['/rpc', '/compact', '/ok/']) assert.equal(pathIn(text, true), text === '/ok/' ? '/ok/' : undefined, `${text} (span)`);
  assert.equal(pathIn('file:///C:/x', false), 'C:/x', 'a file URL names its path');
  assert.equal(pathIn('\\\\nas\\share\\a.jpg', true), '\\\\nas\\share\\a.jpg', 'a network path on the local network');
  for (const text of ['notes/a.md', './a.md', 'https://x.example/a', 'mailto:a@b.example', '#/tasks', '~/x', '//cdn.example/a.js',
    'C:\\Users\\<name>\\x', 'C:/x/{README.md,handoff.json}', 'C:/x/*.md', 'C:/x/a?.md', 'C:/x/a.md | head', '"C:/x/a.md"', '', '   ', 'C:',
    `C:/${'a'.repeat(1030)}`,
    // a public host: a click would make this PC dial (and sign in to) the host the message names
    '\\\\evil.example\\share\\report.pdf', 'file://evil.example/share/x', '\\\\?\\UNC\\evil\\s\\x', '//evil.example/share/x', '/\\evil.example\\share\\x', '/\\evil/share/x']) {
    assert.equal(pathIn(text, false), undefined, text);
    assert.equal(pathIn(text, true), undefined, `${text} (span)`);
  }
});

test('the renderers: a path link or code span is a chip – data-path, the path as title, no href; everything else renders as before', () => {
  const marked = new Marked({ gfm: true, breaks: false, async: false }, { renderer: pathRenderer, tokenizer: pathTokenizer });
  const md = (text: string) => marked.parse(text) as string;
  assert.equal(md('[Prüfbericht](C:/Users/ann/Workforce/a.md)'),
    '<p><a data-path="C:/Users/ann/Workforce/a.md" title="C:/Users/ann/Workforce/a.md">Prüfbericht</a></p>\n', 'a link keeps its label');
  assert.equal(md('[**fett**](</srv/R&D notes/a.md> "old")'),
    '<p><a data-path="/srv/R&amp;D notes/a.md" title="/srv/R&amp;D notes/a.md"><strong>fett</strong></a></p>\n', 'label markup kept, escaped, the path as title');
  // FCMWO5R5: Paula's inline code – the file's name shows, the folders before it are hidden text
  assert.equal(md('Datei: `C:\\Users\\Heess\\AppData\\Roaming\\Autark Companies\\company-2\\workspace\\podcast-ki-power\\Einwilligungserklaerung_Stanislaus_Hees.pdf`'),
    '<p>Datei: <a data-path="C:\\Users\\Heess\\AppData\\Roaming\\Autark Companies\\company-2\\workspace\\podcast-ki-power\\Einwilligungserklaerung_Stanislaus_Hees.pdf"'
    + ' title="C:\\Users\\Heess\\AppData\\Roaming\\Autark Companies\\company-2\\workspace\\podcast-ki-power\\Einwilligungserklaerung_Stanislaus_Hees.pdf">'
    + '<span data-dir="">C:\\Users\\Heess\\AppData\\Roaming\\Autark Companies\\company-2\\workspace\\podcast-ki-power\\</span>Einwilligungserklaerung_Stanislaus_Hees.pdf</a></p>\n');
  assert.equal(md('See `C:\\Users\\ann\\Workforce\\` now'),
    '<p>See <a data-path="C:\\Users\\ann\\Workforce\\" title="C:\\Users\\ann\\Workforce\\" data-folder=""><span data-dir="">C:\\Users\\ann\\</span>Workforce<span data-dir="">\\</span></a> now</p>\n',
    'a folder: its icon, its name without the closing separator');
  assert.equal(md('[site](https://x.example/a) and [day](#/day)'), '<p><a href="https://x.example/a">site</a> and <a href="#/day">day</a></p>\n');
  assert.equal(md('`/rpc` and `npm test` and `C:/x/*.md`'), '<p><code>/rpc</code> and <code>npm test</code> and <code>C:/x/*.md</code></p>\n');
  assert.equal(md('[rel](notes/a.md)'), '<p><a href="notes/a.md">rel</a></p>\n', 'a relative target keeps the default (the sanitizer drops its href)');
  assert.equal(marked.parseInline('`/srv/a/b.txt`') as string, '<a data-path="/srv/a/b.txt" title="/srv/a/b.txt"><span data-dir="">/srv/a/</span>b.txt</a>', 'inline strings too');
  assert.match(md('`file:///C:/My%20Docs/a.pdf`'), /data-path="C:\/My Docs\/a\.pdf"/, 'a file URL opens the path it names');
  assert.doesNotMatch(md('[a](C:/x/a.md) `D:/y/`'), /href/, 'a path is never an href');
});

test('the renderers: a Windows link target keeps its backslashes; the enclosing link wins over a code span in its label; network paths stay text', () => {
  const marked = new Marked({ gfm: true, breaks: false, async: false }, { renderer: pathRenderer, tokenizer: pathTokenizer });
  const target = (text: string) => /data-path="([^"]*)"/.exec(marked.parse(text) as string)?.[1];
  // CommonMark reads `\.` and `\_` as escapes; a Windows path keeps them as separators
  assert.equal(target('[notes](C:\\Users\\ann\\code\\.cache\\b081\\notes\\T5.md)'), 'C:\\Users\\ann\\code\\.cache\\b081\\notes\\T5.md');
  assert.equal(target('[x](C:\\a\\.git\\b)'), 'C:\\a\\.git\\b');
  assert.equal(target('[x](C:\\a\\.git\\b "a title")'), 'C:\\a\\.git\\b', 'with a title');
  assert.equal(target('[x](<C:\\a b\\_c\\d.md>)'), 'C:\\a b\\_c\\d.md', 'in angle brackets');
  assert.equal(target('See [x][notes].\n\n[notes]: C:\\a\\.x'), 'C:\\a\\.x', 'a reference link');
  assert.equal(target('[x](C:/w/a.md) [y](/srv/a/b.md)'), 'C:/w/a.md', 'forward slashes as before');
  // a web link labelled with a path keeps its URL; a path link labelled with another path opens its own target
  assert.equal(marked.parse('See [`/v1/messages`](https://docs.example.com/api/messages)') as string,
    '<p>See <a href="https://docs.example.com/api/messages"><code>/v1/messages</code></a></p>\n');
  assert.equal(marked.parse('[`C:\\x\\a.md`](C:\\y\\b.md) then `/srv/a/b.txt`') as string,
    '<p><a data-path="C:\\y\\b.md" title="C:\\y\\b.md"><code>C:\\x\\a.md</code></a> then <a data-path="/srv/a/b.txt" title="/srv/a/b.txt"><span data-dir="">/srv/a/</span>b.txt</a></p>\n',
    'one path per link; a code span after the link is a path again');
  // network paths: one on the local network keeps both leading backslashes; a public host is no path
  assert.equal(target('[share](\\\\nas\\share\\a.jpg)'), '\\\\nas\\share\\a.jpg');
  assert.doesNotMatch(marked.parse('`\\\\evil.example\\share\\report.pdf` [w](//evil.example/x) [v](\\\\evil.example\\s\\x)') as string, /data-path/);
});

test('plainInControl: inside a button or label a path is plain text again; elsewhere it stays a path', () => {
  const removed: string[] = [];
  const el = { removeAttribute: (name: string) => removed.push(name) };
  const span = (control: boolean) => ({ parentElement: { closest: (selector: string) => (selector === 'button, label' && control ? {} : null) }, querySelectorAll: () => [el] }) as unknown as Element;
  plainInControl(span(false));
  plainInControl(null);
  assert.deepEqual(removed, [], 'outside a control nothing changes');
  plainInControl(span(true));
  assert.deepEqual(removed, ['data-path', 'data-folder', 'role', 'tabindex', 'title'], 'the option, card or checklist item keeps its one click');
});

type Answer = Partial<PathRead> | Error;

/** Stubs rpc.call: answers by `${device}|${path}`, records each files.readPath call. */
function stubRpc(answers: Record<string, Answer>): Array<{ path: string; device?: string }> {
  const calls: Array<{ path: string; device?: string }> = [];
  (rpc as unknown as { call: unknown }).call = async (method: string, params: { path: string; device?: string }) => {
    assert.equal(method, 'files.readPath');
    calls.push(params);
    const answer = answers[`${params.device ?? ''}|${params.path}`] ?? { state: 'missing' };
    if (answer instanceof Error) throw answer;
    return { path: params.path, size: 0, stamp: '', ...answer };
  };
  return calls;
}

const lastTab = () => tabsOf('global').at(-1);

test('openPathLink: home PC first, then this PC; folder, media or file tab in the global pane; not found anywhere: the home PC\'s tab', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // toasts expire by timer
  const real = rpc.call;
  t.after(() => { (rpc as unknown as { call: unknown }).call = real; session.value = null; agents.value = []; systemInfo.value = null; });
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };
  systemInfo.value = { deviceId: 'dev_here' } as SystemInfo;
  agents.value = [
    { id: 'ag_far', name: 'Far', deviceId: 'dev_note' } as Agent,
    { id: 'ag_here', name: 'Here' } as Agent,
    { id: 'ag_same', name: 'Same', deviceId: 'dev_here' } as Agent,
  ];

  let calls = stubRpc({ 'dev_note|C:/w/a.md': { state: 'text', path: 'C:\\w\\a.md' } });
  await openPathLink('C:/w/a.md', 'ag_far');
  assert.deepEqual(calls, [{ path: 'C:/w/a.md', device: 'dev_note' }], 'found on the home PC: one read');
  assert.deepEqual(lastTab(), { id: 'file@dev_note:C:\\w\\a.md', kind: 'file', path: 'C:\\w\\a.md', device: 'dev_note' });

  calls = stubRpc({ '|C:/w/out/': { state: 'folder', path: 'C:\\w\\out' } });
  await openPathLink('C:/w/out/', 'ag_far');
  assert.deepEqual(calls, [{ path: 'C:/w/out/', device: 'dev_note' }, { path: 'C:/w/out/' }], 'missing there, then this PC');
  assert.deepEqual(lastTab(), { id: 'folder:C:\\w\\out', kind: 'folder', path: 'C:\\w\\out' });

  calls = stubRpc({ '|C:/w/shot.png': { state: 'binary' }, 'dev_note|C:/w/doc.pdf': { state: 'large' }, '|C:/w/clip.mp4': { state: 'large' } });
  await openPathLink('C:/w/shot.png', 'ag_here');
  assert.deepEqual(lastTab(), { id: 'media:C:/w/shot.png', kind: 'media', path: 'C:/w/shot.png' }, 'an image: the media tab');
  await openPathLink('C:/w/doc.pdf', 'ag_far');
  assert.deepEqual(lastTab(), { id: 'media@dev_note:C:/w/doc.pdf', kind: 'media', path: 'C:/w/doc.pdf', device: 'dev_note' }, 'a PDF of the home PC');
  await openPathLink('C:/w/clip.mp4', 'ag_same');
  assert.equal(lastTab()?.kind, 'media', 'a video');
  assert.deepEqual(calls, [{ path: 'C:/w/shot.png' }, { path: 'C:/w/doc.pdf', device: 'dev_note' }, { path: 'C:/w/clip.mp4' }], 'home = this PC: one local read');

  calls = stubRpc({});
  await openPathLink('C:/w/gone.md', 'ag_far');
  assert.equal(calls.length, 2);
  assert.deepEqual(lastTab(), { id: 'file@dev_note:C:/w/gone.md', kind: 'file', path: 'C:/w/gone.md', device: 'dev_note' }, 'on neither PC: the home PC\'s file tab');
  await openPathLink('C:/w/gone-dir\\', 'human');
  assert.deepEqual(lastTab(), { id: 'folder:C:/w/gone-dir\\', kind: 'folder', path: 'C:/w/gone-dir\\' }, 'a person\'s message: this PC; a closing separator: the folder tab');
  assert.deepEqual(calls.at(-1), { path: 'C:/w/gone-dir\\' });

  calls = stubRpc({ '|/srv/x.md': new Error('bad path') });
  await openPathLink('/srv/x.md', 'ag_far');
  assert.deepEqual(lastTab(), { id: 'file@dev_note:/srv/x.md', kind: 'file', path: '/srv/x.md', device: 'dev_note' }, 'the home PC answered: its tab, whatever this PC says');
  assert.equal(toasts.value.length, 0, 'no toast while a tab opens');
});

test('openPathLink: an offline or unlinked home PC is one toast, no tab; without files.readPath nothing is asked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = rpc.call;
  t.after(() => { (rpc as unknown as { call: unknown }).call = real; session.value = null; agents.value = []; systemInfo.value = null; toasts.value = []; });
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };
  systemInfo.value = { deviceId: 'dev_here' } as SystemInfo;
  agents.value = [{ id: 'ag_far', name: 'Far', deviceId: 'dev_note' } as Agent];
  toasts.value = [];

  const before = tabsOf('global').length;
  let calls = stubRpc({ 'dev_note|C:/w/a.md': new Error('notebook is offline.') });
  await openPathLink('C:/w/a.md', 'ag_far');
  assert.equal(calls.length, 2, 'this PC is asked too');
  assert.equal(tabsOf('global').length, before, 'no tab');
  assert.deepEqual(toasts.value.map((toast) => [toast.title, toast.body, toast.tone]), [['Could not open a.md', 'notebook is offline.', 'error']]);

  toasts.value = [];
  calls = stubRpc({ 'dev_note|C:/w/b.md': new Error('That PC is not linked here.'), '|C:/w/b.md': { state: 'text' } });
  await openPathLink('C:/w/b.md', 'ag_far');
  assert.equal(lastTab()?.id, 'file:C:/w/b.md', 'found on this PC after all: its tab, no toast');
  assert.equal(toasts.value.length, 0);

  calls = stubRpc({});
  for (const path of ['\\\\evil.example\\share\\x.pdf', '//evil.example/share/x', 'notes/a.md']) await openPathLink(path, 'ag_far');
  assert.equal(calls.length, 0, 'a network path or a relative one: nothing asked on any PC');

  session.value = { kind: 'device', capabilities: [], secure: false, allowedMethods: [] };
  toasts.value = [];
  calls = stubRpc({});
  await openPathLink('C:/w/c.md', 'ag_far');
  assert.equal(calls.length, 0, 'no files.readPath here: nothing asked, nothing opened');
  assert.deepEqual(toasts.value.map((toast) => [toast.title, toast.body]), [['Could not open c.md', NO_PATH_READ]], '16.11.: one toast says why instead of nothing');
});

// 20.11.2026 (FCMWO5R5): on the phone a path to a file that is no text goes the way such an attachment goes – the PC
// that holds it stores it (files.uploadPath, served like an attachment) and the phone saves it; the desktop keeps its tab.
test('openPathLink on the phone: a file that is no text is saved to the phone, no tab; a picture or PDF still opens in the area', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = rpc.call;
  t.after(() => { (rpc as unknown as { call: unknown }).call = real; session.value = null; toasts.value = []; });
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };
  toasts.value = [];
  const asked: string[] = [];
  (rpc as unknown as { call: unknown }).call = async (method: string, params: { path: string }) => {
    asked.push(`${method} ${params.path}`);
    if (method === 'files.uploadPath') throw new Error('stored, then the phone saves it');
    return { path: params.path, size: 9, stamp: '1:9', state: params.path.endsWith('.txt') ? 'text' : 'binary' };
  };
  const before = tabsOf('global').length;
  await openPathLink('C:\\w\\Vertrag.docx', undefined, false);
  assert.deepEqual(asked, ['files.readPath C:\\w\\Vertrag.docx', 'files.uploadPath C:\\w\\Vertrag.docx']);
  assert.equal(tabsOf('global').length, before, 'no tab');
  assert.deepEqual(toasts.value.map((toast) => [toast.title, toast.body]), [['Could not open Vertrag.docx', 'stored, then the phone saves it']], 'a failed save says so');
  await openPathLink('C:\\w\\Vertrag.pdf', undefined, false);
  assert.equal(lastTab()?.kind, 'media', 'a PDF: the Media tab, as an attachment');
  await openPathLink('C:\\w\\notes.txt', undefined, false);
  assert.equal(lastTab()?.kind, 'file', 'text: the file tab');
  await openPathLink('C:\\w\\Vertrag.docx', undefined, true);
  assert.deepEqual(lastTab(), { id: 'file:C:\\w\\Vertrag.docx', kind: 'file', path: 'C:\\w\\Vertrag.docx' }, 'the desktop: the file tab (Open with system there)');
});

// 20.11.2026 (review): a network host the runtime has not been told yes for is one question naming the host; no opens
// nothing and says nothing, yes is remembered (files.allowHost) and the path opens.
test('openPathLink: a network host is asked once by name; no opens nothing, yes confirms it and opens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = rpc.call;
  t.after(() => { (rpc as unknown as { call: unknown }).call = real; session.value = null; toasts.value = []; });
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };
  toasts.value = [];
  const share = '\\\\nas\\share\\Vertrag.pdf';
  let allowed = false;
  const asked: string[] = [];
  (rpc as unknown as { call: unknown }).call = async (method: string, params: { path?: string; host?: string }) => {
    asked.push(method === 'files.allowHost' ? `allow ${params.host}` : `${method} ${params.path}`);
    if (method === 'files.allowHost') { allowed = true; return { host: params.host }; }
    if (!allowed) throw new RpcError({ code: 'forbidden', message: 'nas is another computer on the network.', details: { netHost: 'nas' } });
    return { path: params.path, size: 9, stamp: '1:9', state: 'binary' };
  };
  const hosts: string[] = [];
  const before = tabsOf('global').length;
  await openPathLink(share, undefined, true, async (host) => { hosts.push(host); return false; });
  assert.deepEqual(hosts, ['nas'], 'the question names the host');
  assert.deepEqual(asked, [`files.readPath ${share}`], 'no: nothing confirmed, nothing read');
  assert.equal(tabsOf('global').length, before);
  assert.equal(toasts.value.length, 0, 'no toast after a no');
  await openPathLink(share, undefined, true, async () => true);
  assert.deepEqual(asked.slice(1), [`files.readPath ${share}`, 'allow nas', `files.readPath ${share}`]);
  assert.equal(lastTab()?.kind, 'media', 'yes: the PDF opens');
});

// 16.11.2026 (owner on the phone: a document an agent sent did not open in the side pane): a file block's and a review's
// Open take the chat link's way on every device, read on the asking agent's home PC first. node --test cannot import .tsx,
// so the wiring is read from the sources.
test('file block and review: Open goes through openPathLink on every device; the to-do\'s creator names the PC to read on', () => {
  const read = (file: string) => readFileSync(new URL(`../../../src/ui/${file}`, import.meta.url), 'utf8');
  const file = read('blocks/ui/FileBlock.tsx');
  assert.match(file, /openPathLink\(path, /, 'a path opens like a chat link');
  assert.doesNotMatch(file, /\{desktop && \(path \|\| fileId\)/, 'Open is no longer desktop-only');
  assert.match(file, /desktop && onPc && <button[^\n]*Show in folder/, 'Show in folder stays on the desktop');
  const review = read('blocks/ui/Review.tsx');
  assert.match(review, /openPathLink\(src, author\)/);
  assert.doesNotMatch(review, /platform === 'desktop'/, 'no desktop-only Open');
  assert.match(review, /props\.authorId \?\? \(event\.currentTarget as HTMLElement\)\.closest<HTMLElement>\('\[data-author\]'\)/);
  assert.match(read('blocks/AskBlock.tsx'), /authorId=\{props\.authorId\}/);
  assert.match(read('tasks/TodoWidget.tsx'), /authorId=\{task\.createdBy\}/, 'the Tasks page: the to-do\'s creator');
});
