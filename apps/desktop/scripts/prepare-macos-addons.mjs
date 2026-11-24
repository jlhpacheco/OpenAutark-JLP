// Owns: both pinned macOS speech addons for a universal binary distribution (run on the Mac runner before `npm run package -- --mac --universal`;
// from the 0.3.14 release payload into the repo 24.11.2026, since the release builds from the tag checkout).
// Never: runs package scripts, changes the lock or contacts an AI provider.
import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
assert.equal(process.platform, 'darwin');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
await mkdir('.native-packages', { recursive: true });
function run(command, args) {
  const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4e6 });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}
for (const arch of ['x64', 'arm64']) {
  const name = `sherpa-onnx-darwin-${arch}`;
  const expected = lock.packages[`node_modules/${name}`];
  assert.equal(expected.version, '2.0.1');
  const [packed] = JSON.parse(run('npm', ['pack', `${name}@${expected.version}`, '--json', '--ignore-scripts', '--pack-destination=.native-packages']));
  const file = `.native-packages/${packed.filename}`;
  assert.equal(packed.integrity, expected.integrity);
  assert.equal(`sha512-${createHash('sha512').update(await readFile(file)).digest('base64')}`, expected.integrity);
  assert.ok(run('tar', ['-tzf', file]).trim().split('\n').every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')));
  await mkdir(`node_modules/${name}`, { recursive: true });
  run('tar', ['-xzf', file, '--strip-components=1', '-C', `node_modules/${name}`]);
  console.log(`${name}@${expected.version}: integrity matches the release lock`);
}
await rm('.native-packages', { recursive: true });
