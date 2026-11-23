// A SettingsStore over a data folder whose settings.json already holds `content` – what an earlier start or the person
// left there (stored values are read through the file only: the old settings table moved into it long ago).
// Owns: this fixture. Never: imported by src/.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { ROOT_SETTINGS } from '../../../src/runtime/root/layout.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

export function storedSettings(content: unknown, env: { locale: string; timezone: string }): { settings: SettingsStore; done: () => void } {
  const temp = tempDir('wf-settings-stored-');
  writeFileSync(path.join(temp.dir, ROOT_SETTINGS), JSON.stringify(content), 'utf8');
  const settings = new SettingsStore({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), env, dataDir: temp.dir });
  return { settings, done: () => { settings.close(); temp.cleanup(); } };
}
