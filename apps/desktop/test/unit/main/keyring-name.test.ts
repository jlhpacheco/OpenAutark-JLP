// The keyring name of a data folder from the old product name (src/main/keyring-name.ts), on real temp folders and a fake app.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEYRING_MARKER, applyKeyringName, readMarker } from '../../../src/main/keyring-name.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'wf-keyring-'));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function folder(marker?: string): string {
  counter += 1;
  const dir = path.join(root, `d${counter}`);
  mkdirSync(dir, { recursive: true });
  if (marker !== undefined) writeFileSync(path.join(dir, KEYRING_MARKER), marker);
  return dir;
}

function fakeApp(dir: string, packaged = true) {
  const calls: string[] = [];
  let ready: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => { ready = resolve; });
  return {
    calls, ready, whenReady: () => whenReady, isPackaged: packaged,
    getName: () => 'Autark',
    setName: (name: string) => { calls.push(`setName ${name}`); },
    getPath: (_name: 'userData') => dir,
    setPath: (_name: 'userData', value: string) => { calls.push(`setPath ${value}`); },
  };
}

test('the marker is one line of a name, or none', () => {
  assert.equal(readMarker(folder()), null);
  assert.equal(readMarker(folder('Old Name\n')), 'Old Name');
  assert.equal(readMarker(folder('two\nlines')), null);
  assert.equal(readMarker(folder('   ')), null);
});

test('a moved folder on macOS and Linux: the old name first, the folder pinned, the real name back at ready', async () => {
  for (const platform of ['darwin', 'linux']) {
    const dir = folder('Proactive Agent Workforce\n');
    const app = fakeApp(dir);
    applyKeyringName(app, platform);
    assert.deepEqual(app.calls, ['setName Proactive Agent Workforce', `setPath ${dir}`]);
    app.ready();
    await app.whenReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.calls.at(-1), 'setName Autark');
  }
});

test('Windows, development, a fresh folder and a marker with the own name call nothing on the app', () => {
  const moved = folder('Proactive Agent Workforce\n');
  for (const [app, platform] of [[fakeApp(moved), 'win32'], [fakeApp(moved, false), 'darwin'], [fakeApp(folder()), 'darwin'], [fakeApp(folder('Autark')), 'linux']] as const) {
    applyKeyringName(app, platform);
    assert.deepEqual(app.calls, []);
  }
});
