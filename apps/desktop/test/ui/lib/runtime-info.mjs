// The runtime's address for window tests (port and token from <profile>/runtime.json). The window can show its shell
// before a fresh profile's runtime has written the file (it runs its migrations first), so this waits for it – a few
// tries a second, up to a minute – instead of reading it once right after `.shell` appears. After a restart the file
// of the start before is still there until the new runtime listens: `since` (the time of the launch) waits for the
// file that start wrote (its `at`).
// Owns: that wait. Never: starts the app or connects (the test does).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** runtime.json of `profile` once the runtime wrote it – at `since` or later (throws after `ms`). */
export async function runtimeInfo(profile, ms = 60_000, since = 0) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
      if (!since || Date.parse(info.at) >= since) return info;
      if (Date.now() > end) throw new Error(`runtime.json of ${profile} is from a start before ${new Date(since).toISOString()} (${info.at})`);
    } catch (error) {
      if (Date.now() > end) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
