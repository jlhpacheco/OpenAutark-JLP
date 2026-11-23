// Paths written bare in agent text (src/ui/workspace/path-text.ts, 20.11.2026 FCMWO5R5: the owner on the phone found
// nothing to tap on a path): where a bare path starts and ends – spaces inside Windows folders, umlauts, closing
// punctuation outside, Program Files (x86) kept –, file: URLs, local-network hosts only, and no chip in ordinary text
// (und/oder, times, web addresses, words with a colon). Rendered through marked with the app's own path parts.
// Owns: these assertions only. Never: a DOM or a PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { pathExtension, pathRenderer, pathTokenizer } from '../../../src/ui/workspace/path-links.ts';
import { lanHost, looksLikeFolder, pathAt, pathName, pathStart } from '../../../src/ui/workspace/path-text.ts';

const marked = new Marked({ gfm: true, breaks: false, async: false }, { renderer: pathRenderer, tokenizer: pathTokenizer, extensions: [pathExtension] });
/** The paths a text's chips carry, in order. */
const chips = (text: string): string[] => [...(marked.parse(text) as string).matchAll(/data-path="([^"]*)"/g)].map((match) => match[1]!.replace(/&amp;/g, '&'));

test('bare Windows paths: spaces inside folders, umlauts, closing punctuation outside, a folder with its closing backslash', () => {
  assert.deepEqual(chips('Datei: C:\\Users\\Heess\\AppData\\Roaming\\Autark Companies\\company-2\\workspace\\podcast-ki-power\\Einwilligungserklaerung_Stanislaus_Hees.pdf.'),
    ['C:\\Users\\Heess\\AppData\\Roaming\\Autark Companies\\company-2\\workspace\\podcast-ki-power\\Einwilligungserklaerung_Stanislaus_Hees.pdf'], 'Paula\'s path, the full stop outside');
  assert.deepEqual(chips('Öffne „C:\\Users\\Jörg\\Übersicht März.xlsx“ bitte'), ['C:\\Users\\Jörg\\Übersicht'],
    'a space in the last name ends a bare path (backticks keep it whole); umlauts stay');
  assert.deepEqual(chips('Öffne „C:\\Users\\Jörg\\Übersicht.xlsx“, bitte'), ['C:\\Users\\Jörg\\Übersicht.xlsx']);
  assert.deepEqual(chips('Liegt in C:\\Users\\me\\zur-unterschrift\\ und wartet.'), ['C:\\Users\\me\\zur-unterschrift\\']);
  assert.deepEqual(chips('(siehe C:\\Program Files (x86)\\App\\app.exe), dann D:\\a\\.git\\_q.md; fertig'),
    ['C:\\Program Files (x86)\\App\\app.exe', 'D:\\a\\.git\\_q.md'], 'escapes stay separators; a balanced bracket stays');
  assert.deepEqual(chips('Ich habe C:\\temp\\a.txt und den Ordner D:\\b\\ gelesen'), ['C:\\temp\\a.txt', 'D:\\b\\'], 'two paths, the words between them are no folder');
  assert.deepEqual(chips('**C:\\a\\b.pdf** and C:/w/x.md!'), ['C:\\a\\b.pdf', 'C:/w/x.md'], 'in bold; forward slashes');
  assert.deepEqual(chips('Auf C:\\ ist wenig Platz'), ['C:\\'], 'a drive root');
  assert.deepEqual(chips('| Datei | Ort |\n|---|---|\n| a | C:\\w\\a b\\c.md |'), ['C:\\w\\a b\\c.md'], 'in a table cell');
  assert.deepEqual(chips('- erst C:\\a\\1.md\n- dann C:\\a\\2.md'), ['C:\\a\\1.md', 'C:\\a\\2.md'], 'a line break ends a path');
});

test('bare POSIX paths from the usual top folders, file: URLs and local-network paths', () => {
  assert.deepEqual(chips('Notizen in /home/me/notes.txt und /Users/ann/Desktop/'), ['/home/me/notes.txt', '/Users/ann/Desktop/']);
  assert.deepEqual(chips('Siehe file:///C:/a%20b/c.pdf.'), ['C:/a b/c.pdf']);
  assert.deepEqual(chips('Siehe file:///home/me/a.md und file://nas/share/x.pdf'), ['/home/me/a.md', '\\\\nas\\share\\x.pdf']);
  assert.deepEqual(chips('Netz \\\\nas\\share\\a.jpg, \\\\192.168.1.5\\s\\b.png, \\\\wsl$\\Ubuntu\\home\\x.md und \\\\evil.example\\share\\x.pdf'),
    ['\\\\nas\\share\\a.jpg', '\\\\192.168.1.5\\s\\b.png', '\\\\wsl$\\Ubuntu\\home\\x.md'], 'a public host is no path');
  for (const host of ['nas', 'wsl$', 'wsl.localhost', 'fileserver.local', '10.0.0.2', '172.20.1.1', '192.168.0.10', 'box.home.arpa']) assert.ok(lanHost(host), host);
  for (const host of ['evil.example', 'files.example.com', '8.8.8.8', '172.32.0.1', '.', '?']) assert.ok(!lanHost(host), host);
});

test('no chip in ordinary text', () => {
  for (const text of [
    'und/oder, km/h, 1/2, 15:00, Re: Angebot, Note:/x',
    'https://x.example/home/a and www.example.com/tmp/x and a@b.example',
    'the route /api/v1/users and /rpc and /compact',
    'xC:\\a\\b.pdf and 3:/x and ratio a:b',
    '~/notes/a.md and ./a.md and notes/a.md',
    'C:\\Users\\<name>\\x and C:/x/*.md',
    '[C:\\x\\y.md](https://a.example)',
    '```\nC:\\in\\a\\fence.md\n```',
    '    C:\\indented\\code.md',
  ]) assert.deepEqual(chips(text), [], text);
  assert.equal(pathStart('nothing here at all'), -1);
  assert.equal(pathStart('see C:\\a\\b.md'), 3, 'the space before it');
  assert.equal(pathAt('xC:\\a'), undefined, 'inside a word');
});

test('names and folders as the chip shows them', () => {
  assert.equal(pathName('C:\\a\\Einwilligung.pdf'), 'Einwilligung.pdf');
  assert.equal(pathName('C:\\a\\Ordner\\'), 'Ordner');
  assert.equal(pathName('C:\\'), 'C:\\');
  assert.equal(pathName('/home/me/x.md'), 'x.md');
  assert.equal(pathName('\\\\nas\\share'), 'share');
  assert.ok(looksLikeFolder('C:\\a\\Ordner\\'));
  assert.ok(looksLikeFolder('C:\\a\\zur-unterschrift'));
  assert.ok(!looksLikeFolder('C:\\a\\Übersicht.xlsx'));
});

test('a long text stays fast: each candidate start is checked once', () => {
  const text = `${'Wort und/oder 15:00 '.repeat(4000)} C:\\a\\b.md`;
  const started = performance.now();
  assert.deepEqual(chips(text), ['C:\\a\\b.md']);
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms`);
});
