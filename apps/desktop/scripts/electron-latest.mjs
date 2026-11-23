// Keeps Electron (and with it the Chromium every window and the side browser run on) at the newest stable release.
// Owns: reading the newest stable Electron (npm's `latest` tag) and its Chromium, the pinned version in package.json,
// the bump (package.json + lock exact, then the binary through install.js, which Electron 44+ no longer runs itself) and,
// when a major is crossed, the headlines of every crossed major's breaking changes for the person or AI doing the bump.
// Never: edits source code, picks a beta or alpha, or changes anything in --check mode.
//
//   npm run electron:latest            bump to the newest stable (nothing to do when current)
//   npm run electron:latest -- --check report only; exit 1 when behind (the release gate), 2 when the network fails

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAGS_URL = 'https://registry.npmjs.org/-/package/electron/dist-tags';
const RELEASES_URL = 'https://releases.electronjs.org/releases.json';
const BREAKING_URL = tag => `https://raw.githubusercontent.com/electron/electron/${tag}/docs/breaking-changes.md`;

/** [major, minor, patch] of "45.4.1"; null for anything else (ranges, prereleases). */
export function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** What a bump from `current` to `latest` means. */
export function plan(current, latest) {
  const from = parse(current);
  const to = parse(latest);
  if (!from || !to) throw new Error(`Not an exact version: ${!from ? current : latest}`);
  const order = from[0] - to[0] || from[1] - to[1] || from[2] - to[2];
  const majors = [];
  for (let major = from[0] + 1; major <= to[0]; major++) majors.push(major);
  return { behind: order < 0, majors };
}

/** The "### ..." headlines of one major's section in docs/breaking-changes.md. */
export function headlines(markdown, major) {
  const lines = String(markdown).split('\n');
  const start = lines.findIndex(line => new RegExp(`^## (Planned )?Breaking API Changes \\(${major}\\.0\\)`).test(line));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('### ')) out.push(line.slice(4).trim());
  }
  return out;
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function pinned() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.devDependencies?.electron;
}

function chromium(releases, version) {
  return releases.find(release => release.version === version)?.chrome ?? '?';
}

async function main() {
  const check = process.argv.includes('--check');
  const current = pinned();
  let latest;
  let releases;
  try {
    latest = (await json(TAGS_URL)).latest;
    releases = await json(RELEASES_URL);
  } catch (error) {
    console.error(`electron-latest: could not read the newest Electron (${error.message}).`);
    process.exit(2);
  }
  const { behind, majors } = plan(current, latest);
  const newest = Math.max(...releases.map(release => parse(release.version)?.[0] ?? 0).filter(major => major <= parse(latest)[0]));
  const supported = parse(current)[0] > newest - 3;
  console.log(`Electron ${current} (Chromium ${chromium(releases, current)})${supported ? '' : ' – out of support'}; newest stable ${latest} (Chromium ${chromium(releases, latest)}).`);
  if (!behind) { console.log('Electron is current.'); return; }
  if (check) {
    console.error('Electron is behind. Bring it up with `npm run electron:latest` in apps/desktop, then run the gates.');
    process.exit(1);
  }
  // `latest` passed parse(), so it is digits and dots only.
  execSync(`npm install --save-exact --no-fund --no-audit electron@${latest}`, { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [join(ROOT, 'node_modules/electron/install.js')], { cwd: ROOT, stdio: 'inherit' });
  console.log(`Electron is now ${latest}.`);
  if (!majors.length) return;
  const markdown = await fetch(BREAKING_URL(`v${latest}`)).then(response => response.text()).catch(() => '');
  console.log(`\nNew major${majors.length > 1 ? 's' : ''} ${majors.join(', ')}. I go through each change below in the code before the gates (${BREAKING_URL(`v${latest}`)}):`);
  for (const major of majors) {
    console.log(`\n${major}.0`);
    for (const line of headlines(markdown, major)) console.log(`  - ${line}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
