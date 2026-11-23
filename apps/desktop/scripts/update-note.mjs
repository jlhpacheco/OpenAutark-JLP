// The release gate for the update note (Fest round 22.11.2026): every released version ships its own section in
// resources/updates.md – the note the personal manager reads after an update (src/runtime/system/update-note.ts). A release
// without one would leave that PC's AI with nothing to check, so the release kit's step `update-note` stops it.
// Owns: reading the section headings of updates.md the way update-note.ts reads them, and the check against package.json.
// Never: writes the file or decides its content.
//
//   node scripts/update-note.mjs --check   exit 0 when updates.md has "## <package.json version>", 1 when not

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The same heading rule as src/runtime/system/update-note.ts. */
const HEADING = /^## +v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]*$/;

/** The versions updates.md has a section for, in file order. */
export function sectionVersions(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => HEADING.exec(line)?.[1]).filter(Boolean);
}

if (process.argv.includes('--check')) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  let text = '';
  try { text = readFileSync(join(ROOT, 'resources', 'updates.md'), 'utf8'); } catch { /* missing: no sections */ }
  const versions = sectionVersions(text);
  if (versions.includes(version)) {
    console.log(`update-note: resources/updates.md has the section for ${version}`);
  } else {
    console.error(`update-note: resources/updates.md has no "## ${version}" section (it has: ${versions.join(', ') || 'none'}). Write what changed and what an older install may still carry, then release.`);
    process.exit(1);
  }
}
