// Builds the macOS control helper (apps/mac-steuerung, Swift, universal arm64 + x86_64) and puts it where the app looks for it:
// resources/computer/darwin/autark-mac-helper (asarUnpack, signed with the app by electron-builder – same signature, so the
// person's Accessibility permission for Autark covers the helper). Run on a Mac before `npm run package`; elsewhere it does nothing.
// Owns: the build call and the copy. Never: signs, notarizes or commits the binary (resources/computer/darwin/ stays out of git).

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('build-mac-helper: skipped (macOS only)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const pkg = path.resolve(desktop, '..', 'mac-steuerung');
const flags = ['-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--package-path', pkg];

execFileSync('swift', ['build', ...flags, '--product', 'autark-mac-helper'], { stdio: 'inherit' });
const bin = execFileSync('swift', ['build', ...flags, '--show-bin-path']).toString().trim();
const target = path.join(desktop, 'resources', 'computer', 'darwin');
mkdirSync(target, { recursive: true });
copyFileSync(path.join(bin, 'autark-mac-helper'), path.join(target, 'autark-mac-helper'));
chmodSync(path.join(target, 'autark-mac-helper'), 0o755);
console.log(`build-mac-helper: ${path.join(target, 'autark-mac-helper')}`);
