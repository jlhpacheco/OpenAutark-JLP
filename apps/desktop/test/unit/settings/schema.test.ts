// The one place the settings are described (settings/schema.ts) and what the app does agree: every defined key is
// a known key, every option and both ends of every range the comments name are accepted, the value just outside a
// range is refused, the defaults the comments show are the defaults the app starts with, and the JSON Schema
// (settings.schema.json) carries the same keys, options, ranges, defaults and descriptions.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { pcOf } from '../../../src/runtime/settings/read.ts';
import { SECTIONS, defaultOf, commentOf, schemaText, type KeyDef } from '../../../src/runtime/settings/schema.ts';
import { checkPatchShape } from '../../../src/runtime/settings/validate.ts';
import { clock, recordingBus } from '../store/helpers.ts';
import { MAX_SCOPE_ITEMS, securityDefaults } from '../../../src/shared/model/security-settings.ts';

const env = { locale: 'de-DE', timezone: 'Europe/Berlin' };
const defaults = defaultSettings(env);
const pc = pcOf(defaults);
const store = () => new SettingsStore({ bus: recordingBus().bus, clock: clock(), env });

/** Every leaf key with its patch (`value` put at its place). */
function leaves(): Array<{ path: string; def: KeyDef; patch: (value: unknown) => Record<string, unknown> }> {
  const out: Array<{ path: string; def: KeyDef; patch: (value: unknown) => Record<string, unknown> }> = [];
  for (const section of SECTIONS) {
    for (const def of section.keys) {
      if (!def.keys) { out.push({ path: `${section.key}.${def.key}`, def, patch: (value) => ({ [section.key]: { [def.key]: value } }) }); continue; }
      for (const inner of def.keys) out.push({ path: `${section.key}.${def.key}.${inner.key}`, def: inner, patch: (value) => ({ [section.key]: { [def.key]: { [inner.key]: value } } }) });
    }
  }
  return out;
}

test('every defined key is a known key; every option and both range ends are accepted, just outside is refused', () => {
  for (const section of SECTIONS) for (const def of section.keys) checkPatchShape({ [section.key]: { [def.key]: null } });
  for (const { path, def, patch } of leaves()) {
    if (def.type === 'array' && def.options) store().update(patch(def.options) as never);
    else for (const option of def.options ?? []) store().update(patch(option) as never);
    if (def.type === 'integer') {
      store().update(patch(def.min) as never);
      store().update(patch(def.max) as never);
      assert.throws(() => store().update(patch(def.min! - 1) as never), new RegExp(path.replace(/\./g, '\\.')), path);
      assert.throws(() => store().update(patch(def.max! + 1) as never), new RegExp(path.replace(/\./g, '\\.')), path);
    }
  }
});

test('the defaults the comments name are the defaults the app starts with', () => {
  for (const section of SECTIONS) {
    const actual = (defaults as unknown as Record<string, Record<string, unknown> | undefined>)[section.key];
    assert.equal(actual === undefined, Boolean(section.optional), `${section.key}: optional sections have no defaults`);
    for (const def of section.keys) if (actual && !def.keys) assert.deepEqual(actual[def.key], defaultOf(def, pc), `${section.key}.${def.key}`);
  }
  assert.equal(defaultOf(SECTIONS[0].keys.find((def) => def.key === 'language')!, pc), 'en', 'owner 18.11.2026: English on a German PC too');
});

test('no monthly or spending limit is a setting', () => {
  for (const { path } of leaves()) assert.doesNotMatch(path, /budget|limit|spend|monthly/i, path);
});

test('settings.schema.json carries the same keys, options, ranges, defaults and descriptions', () => {
  const schema = JSON.parse(schemaText(pc)) as { allowComments: boolean; properties: Record<string, { properties: Record<string, Record<string, unknown>> }> };
  assert.equal(schema.allowComments, true);
  for (const { path, def } of leaves()) {
    const [section, key, inner] = path.split('.');
    const node = inner ? (schema.properties[section].properties[key].properties as Record<string, Record<string, unknown>>)[inner] : schema.properties[section].properties[key];
    assert.equal(node.description, commentOf(def, pc), path);
    const value = defaultOf(def, pc);
    assert.deepEqual(node.default, value === undefined ? null : value, path);
    if (def.type === 'integer') assert.deepEqual([node.minimum, node.maximum], [def.min, def.max], path);
    if (def.options && def.type === 'string') assert.deepEqual(node.enum, value === undefined ? [...def.options, null] : def.options, path);
    if (value === undefined) assert.ok(Array.isArray(node.type) && node.type.includes('null'), `${path}: null = not set`);
  }
});

test('B-078: profile.notes (up to 600 characters, line breaks fine) and library.publish (default on)', () => {
  assert.equal(defaults.profile.notes, '');
  assert.equal(defaults.library?.publish, true);
  assert.equal(defaults.feedback.includeDiagnostics, true, 'reports carry the redacted log lines');
  const s = store();
  assert.equal(s.update({ profile: { notes: 'English for code,\nGerman otherwise; "du".' } }).profile.notes, 'English for code,\nGerman otherwise; "du".');
  assert.throws(() => s.update({ profile: { notes: 'x'.repeat(601) } }), /profile\.notes/);
  assert.throws(() => s.update({ profile: { notes: 'bell \u0007' } }), /profile\.notes/);
  assert.equal(s.update({ library: { publish: false } }).library?.publish, false);
  assert.throws(() => s.update({ library: { publish: 'yes' as never } }), /library\.publish/);
});

test('owner 19.11.2026: the section security starts as Trust AI mode; lists take absolute folders and app names, each once', () => {
  assert.deepEqual(defaults.security, securityDefaults('trust'));
  assert.ok(!('pcAccess' in defaults.profile) && !('forEveryAgent' in defaults.profile), 'the two old keys are gone');
  assert.throws(() => checkPatchShape({ profile: { pcAccess: 'careful' } }), /profile\.pcAccess/);
  const s = store();
  const secure = s.update({ security: { ...securityDefaults('secure'), readFolders: [' C:\\Users\\Ada\\Docs\\ ', 'C:\\Users\\Ada\\Docs', '/home/ada/notes/', 'D:\\'], computerApps: ['Excel.EXE', 'excel', ' Chrome '] } }).security!;
  assert.equal(secure.mode, 'secure');
  assert.deepEqual(secure.readFolders, ['C:\\Users\\Ada\\Docs', '/home/ada/notes', 'D:\\'], 'trimmed, no trailing separator but a root, once');
  assert.deepEqual(secure.computerApps, ['excel', 'chrome'], 'lower case, without .exe, once');
  assert.throws(() => s.update({ security: { writeFolders: ['Documents'] } }), /security\.writeFolders/, 'a relative folder');
  assert.throws(() => s.update({ security: { readFolders: Array.from({ length: MAX_SCOPE_ITEMS + 1 }, (_, i) => `C:\\f${i}`) } }), /security\.readFolders/);
  assert.throws(() => s.update({ security: { computer: 'all' as never } }), /security\.computer/);
  assert.throws(() => s.update({ security: { mode: 'paranoid' as never } }), /security\.mode/);
  assert.throws(() => s.update({ security: { computerApps: ['ex\u0007cel'] } }), /security\.computerApps/);
  assert.equal(s.update({ security: { money: 'ask' } }).security?.readFolders.length, 3, 'a patch of one switch keeps the lists');
  assert.equal(s.update({ security: { mode: null as never } }).security?.mode, 'trust', 'null: the default');
});
