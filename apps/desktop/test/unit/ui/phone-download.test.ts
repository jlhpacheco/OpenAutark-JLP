// B-084 (decision 11) "Save to phone" (ui/pwa/phone-download.ts): the bytes go to the Android app in 512 KB base64
// chunks with seq and last, one file after the other; false outside the app and over 25 MB; names lose their folders;
// share text lands after the draft (ui/pwa/share.ts helpers).
// Owns: these assertions with a fake port. Never: a WebView.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptPort, resetNativePort } from '../../../src/ui/pwa/native-port.ts';
import { CHUNK_BYTES, PHONE_DOWNLOAD_MAX, safeName, saveToPhone } from '../../../src/ui/pwa/phone-download.ts';
import { toBase64 } from '../../../src/ui/lib/files.ts';
import { parseShare, shareWhat, withShared } from '../../../src/ui/pwa/share.ts';

interface Chunk { t: string; name: string; mime: string; data: string; seq: number; last: boolean }

function fakePort() {
  const sent: Chunk[] = [];
  adoptPort({ postMessage: (data: unknown) => sent.push(JSON.parse(String(data)) as Chunk), close: () => undefined, onmessage: null } as unknown as MessagePort);
  return sent;
}

test('no port: false and nothing sent', async () => {
  resetNativePort();
  assert.equal(await saveToPhone(new Blob(['x']), 'a.txt'), false);
});

test('chunks of 512 KB, base64, seq from 0, last only on the final one; the bytes join back', async () => {
  resetNativePort();
  const sent = fakePort();
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
  assert.equal(await saveToPhone(new Blob([bytes], { type: 'application/pdf' }), 'C:\\Users\\x\\Report.pdf'), true);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((chunk) => [chunk.t, chunk.seq, chunk.last, chunk.name, chunk.mime]), [
    ['download', 0, false, 'Report.pdf', 'application/pdf'],
    ['download', 1, false, 'Report.pdf', 'application/pdf'],
    ['download', 2, true, 'Report.pdf', 'application/pdf'],
  ]);
  const joined = Buffer.concat(sent.map((chunk) => Buffer.from(chunk.data, 'base64')));
  assert.equal(joined.length, bytes.length);
  assert.ok(joined.equals(Buffer.from(bytes)));
  assert.equal(Buffer.from(sent[0]!.data, 'base64').length, CHUNK_BYTES);
});

test('an empty file is one last chunk; no type is octet-stream', async () => {
  resetNativePort();
  const sent = fakePort();
  assert.equal(await saveToPhone(new Blob([]), ''), true);
  assert.deepEqual(sent, [{ t: 'download', name: 'download', mime: 'application/octet-stream', data: '', seq: 0, last: true }]);
});

test('two saves never interleave: the second waits for the first', async () => {
  resetNativePort();
  const sent = fakePort();
  const big = new Blob([new Uint8Array(CHUNK_BYTES + 1)]);
  const [a, b] = await Promise.all([saveToPhone(big, 'a.bin'), saveToPhone(new Blob(['b']), 'b.txt')]);
  assert.equal(a && b, true);
  assert.deepEqual(sent.map((chunk) => `${chunk.name}:${chunk.seq}`), ['a.bin:0', 'a.bin:1', 'b.txt:0']);
});

test('over 25 MB: false, nothing sent (the caller downloads as before)', async () => {
  resetNativePort();
  const sent = fakePort();
  const huge = { size: PHONE_DOWNLOAD_MAX + 1, type: '' } as Blob;
  assert.equal(await saveToPhone(huge, 'big.bin'), false);
  assert.equal(sent.length, 0);
  resetNativePort();
});

test('base64 and names', () => {
  assert.equal(toBase64(new TextEncoder().encode('Grüße')), Buffer.from('Grüße').toString('base64'));
  const large = new Uint8Array(100_000).fill(65);
  assert.equal(toBase64(large), Buffer.from(large).toString('base64'));
  assert.equal(safeName('folder/sub/a:b?.txt'), 'ab.txt');
  assert.equal(safeName('   '), 'download');
  assert.equal(safeName(`${'x'.repeat(200)}.pdf`).length, 120);
});

test('share: what the card names, and the text after the draft', () => {
  assert.deepEqual(parseShare({ t: 'share', text: '  hello ', files: 2 }), { text: 'hello', files: 2 });
  assert.deepEqual(parseShare({ t: 'share', files: 1.7 }), { text: '', files: 1 });
  assert.equal(parseShare({ t: 'share', files: 0 }), null);
  assert.equal(parseShare({ t: 'share', files: 'many' }), null);
  assert.equal(shareWhat({ text: '', files: 3 }), '3 files');
  assert.equal(shareWhat({ text: 'x', files: 1 }), 'the file');
  assert.equal(shareWhat({ text: 'x', files: 0 }), 'the text');
  assert.equal(withShared('', 'link'), 'link');
  assert.equal(withShared('Look:  \n', 'link'), 'Look:\n\nlink');
  assert.equal(withShared('draft', ''), 'draft');
});
