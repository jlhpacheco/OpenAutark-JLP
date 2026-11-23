// The one rule of every layer for a served file (src/shared/files): the type by extension (the runtime's HTTP server and
// the desktop's app:// protocol), a blob's type from its first bytes alone (the desktop's wf-file:// and media jobs) and
// the blob store's layout.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimeForPath, sniffMime } from '../../../src/shared/files/mime.ts';
import { blobParts } from '../../../src/shared/files/serving.ts';

const bytes = (text: string) => new Uint8Array(Array.from(text, (ch) => ch.charCodeAt(0)));

test('a served file\'s type by its extension, case-free; anything else is octet-stream', () => {
  assert.equal(mimeForPath('C:\\app\\ui\\index.HTML'), 'text/html; charset=utf-8');
  assert.equal(mimeForPath('/ui/assets/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeForPath('ort/ort-wasm-simd.wasm'), 'application/wasm');
  assert.equal(mimeForPath('sounds/done.mp3'), 'audio/mpeg');
  assert.equal(mimeForPath('fonts/inter.ttf'), 'font/ttf');
  assert.equal(mimeForPath('ui.v2/README'), 'application/octet-stream', 'a dot in a folder name is no extension');
  assert.equal(mimeForPath('archive.tar.zst'), 'application/octet-stream');
});

test('a blob\'s type from its first bytes: a binary signature, SVG markup, else octet-stream', () => {
  assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(sniffMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])), 'video/webm');
  assert.equal(sniffMime(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
  assert.equal(sniffMime(bytes('<?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(sniffMime(bytes('hello')), 'application/octet-stream');
  assert.equal(sniffMime(new Uint8Array(0)), 'application/octet-stream');
});

test('the blob store keeps a file at ab/cd/<sha256>', () => {
  const id = 'ab'.repeat(32).replace(/^abab/, 'abcd');
  assert.deepEqual(blobParts(id), ['ab', 'cd', id]);
});
