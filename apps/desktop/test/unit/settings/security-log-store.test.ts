// Owns: the Security change log against the real SettingsStore (Noah's review 16.11.2026, finding A): an edit of
// settings.json that an update takes over before the watcher handed it over is not written down as the caller's.
// Never: the RPC server or the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_SETTINGS } from '../../../src/runtime/root/layout.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { actingAs, readSecurityChanges, startSecurityLog } from '../../../src/runtime/settings/security-log.ts';
import type { SettingsPatch } from '../../../src/shared/model/system.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

function rig() {
  const temp = tempDir('security-log-');
  const db = memoryDb();
  const { bus } = recordingBus();
  const time = clock();
  const root = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const settings = new SettingsStore({ db, bus, clock: time, env: { locale: 'de-AT', timezone: 'Europe/Vienna' }, dataDir: temp.dir, root });
  settings.get();
  const kv = new KvRepo(db);
  const stop = startSecurityLog({ bus, settings, kv, now: () => time.now() });
  const file = path.join(temp.dir, ROOT_SETTINGS);
  return { settings, kv, file, done: () => { stop(); settings.close(); root.stop(); temp.cleanup(); } };
}
const OWNER = { kind: 'person', name: 'Alex' } as const;

test('an agent edits settings.json, the person then saves another setting before the watcher fires: the edit is not the person\'s', () => {
  const h = rig();
  try {
    const doc = parseText(readFileSync(h.file, 'utf8')).data as { security: Record<string, unknown> };
    doc.security.money = 'ask';
    writeFileSync(h.file, JSON.stringify(doc, null, 2), 'utf8'); // no nudge: the watcher has not handed it over yet
    const patch = { profile: { name: 'Alex Example' } } as SettingsPatch;
    actingAs(OWNER, patch, () => h.settings.update(patch));
    // FX1 H4: a disk edit of the security section is put back in every mode – never applied, so never the person's
    const entry = readSecurityChanges(h.kv).find((change) => change.field === 'security.money');
    assert.equal(entry, undefined, 'nothing changed, nothing written down as the person');
    assert.equal(h.settings.get().security?.money, 'yes', 'the section in force stays');
    assert.equal(h.settings.get().profile.name, 'Alex Example', 'the person\'s own save went through');
  } finally { h.done(); }
});

test('the person changing the mode through settings.update is named', () => {
  const h = rig();
  try {
    const patch = { security: { mode: 'secure' } } as SettingsPatch;
    actingAs(OWNER, patch, () => h.settings.update(patch));
    assert.deepEqual(readSecurityChanges(h.kv).map((change) => [change.field, change.by.kind, change.to]), [['security.mode', 'person', 'secure']]);
  } finally { h.done(); }
});
