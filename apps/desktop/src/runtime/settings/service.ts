// SettingsStore: every setting of the app – <data>/settings.json, the one store. The app writes the file whole:
// every key with its current value and a comment line above it (what it does, the allowed values, the default –
// schema.ts), and settings.schema.json beside it. The person, an agent or a script edits the file with any editor;
// the data folder watcher hands the edit over (fromDisk) and it applies like an update (a missing key or null: the
// default). Each section is checked on its own: one that is not valid is not applied – its last good value stays,
// the file keeps it as written with the reason above it – and a quiet notice names it ('settings.notice'; held() lists
// such sections, so a writer of one key can leave a section alone that an update would replace); a key no
// section knows is left out. After every read and change the file is written again when its text differs from the
// whole, current one (comments never stale; an older file holding only the values that differ from the defaults
// becomes whole once, every value kept). update() merges (null: the default, as in the file), validates, writes the file atomically and emits
// 'settings.updated'; one stat before makes sure an edit not handed over yet comes first. A missing file is
// written again from the current values; a file that is no JSON object at all is copied to settings.rejected.json
// before the app writes over it (until then nothing is written).
// Without a data folder (tests) the settings live in memory only.
// Sicher-Runde 19.11.2026: a disk edit of the `security` section is refused in every mode (keepSecurity; FX1 H4: Trust AI
// mode's three Ask switches and the Secure lists kept ready in it are the person's too). REVIEW-2 9: the section last applied
// is also kept in the database (kv 'settings.security'), so the first read after a start puts back an edit made while the
// app was closed; with no record yet (the first start of this version, a new company) the file's section is taken.
// Owns: these rules and the 'settings.updated' / 'settings.notice' events. Never: secret values (only ids such as
// calendar.googleSecretId), a partial write of an invalid result, or polling.

import { KvRepo } from '../store/kv.ts';
import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { Clock, Logger, SettingsService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { type Settings, type SettingsPatch } from '../../shared/model/system.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { ROOT_SETTINGS } from '../root/layout.ts';
import { TextDoc, canonical, readText, writeAtomic, type TextProblem, type TextRead } from '../root/text-doc.ts';
import type { RootWatcher } from '../root/watcher.ts';
import { defaultSettings, type SystemEnvironment } from './defaults.ts';
import { SETTINGS_SCHEMA_FILE, parseText, schemaText, settingsText, type PcDefaults } from './schema.ts';
import { noticeText, pcOf, sameSettings, settingsFrom, settled, type FileProblem } from './read.ts';
import { checkPatchShape, deepMerge, validateSettings } from './validate.ts';

/** Where the security section last applied is kept (keepSecurity). */
const SECURITY_NS = 'settings.security';
const SECURITY_KEY = 'applied';

/** settings.json is never larger (1000 learned words fit many times). */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

export interface SettingsDeps {
  bus: Bus;
  clock: Clock;
  /** Where the security section last applied is kept (kv; absent: not kept – tests, fakes). */
  db?: Db;
  env?: SystemEnvironment; // OS locale/timezone (tests pass fixed values)
  /** <data>, home of settings.json (absent: memory only – tests, fakes). */
  dataDir?: string;
  /** The data folder watcher: own writes and the owner of settings.json. */
  root?: RootWatcher;
  log?: Logger;
}

type Plain = Record<string, unknown>;

const READ_PROBLEM: Record<TextProblem, string> = {
  'too-large': 'settings.json is too large to use',
  'not-text': 'settings.json is not a text file',
  unreadable: 'settings.json cannot be read',
};

/** What a read found, as one comparable key. */
const readKey = (read: TextRead): string => (read.kind === 'ok' ? `text:${read.text}` : read.kind === 'missing' ? 'missing' : `sig:${read.sig}`);

export class SettingsStore implements SettingsService {
  private readonly deps: SettingsDeps;
  private readonly defaults: Settings;
  /** This PC's language and time zone (the defaults' comments show them). */
  private readonly pc: PcDefaults;
  private readonly doc?: TextDoc;
  /** settings.schema.json is current (checked once per start). */
  private schemaDone = false;
  private cache: Settings | undefined;
  /** What the file held when the app last took it over or wrote it (readKey). */
  private seen: string | undefined;
  /** Sections of the file that are not applied, as written (kept in the file until fixed). */
  private rejected: Plain = {};
  /** What the notice says was not applied. */
  private problems: FileProblem[] = [];
  /** The file is no usable JSON object (copied aside before the app writes over it). */
  private unusable = false;
  private noticeText: string | undefined;
  private offWatch?: () => void;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.defaults = defaultSettings(deps.env);
    this.pc = pcOf(this.defaults);
    if (deps.dataDir) {
      this.doc = new TextDoc({ file: path.join(deps.dataDir, ROOT_SETTINGS), limits: { maxBytes: SETTINGS_FILE_MAX_BYTES }, clock: deps.clock, writes: deps.root });
      this.offWatch = deps.root?.register(ROOT_SETTINGS, () => this.fromDisk());
    }
  }

  get(): Settings {
    this.cache ??= this.load();
    return structuredClone(this.cache);
  }

  /** The quiet notice of settings.json (a part not applied), when there is one. */
  notice(): string | undefined {
    return this.noticeText;
  }

  /** The sections of settings.json not applied right now, kept there as written; an update of one replaces it. */
  held(): string[] {
    if (this.cache) this.fromDisk(); // an edit not handed over yet counts
    this.cache ??= this.load();
    return Object.keys(this.rejected);
  }

  /** Stops hearing about edits of settings.json (the runtime's stop). */
  close(): void {
    this.offWatch?.();
    this.offWatch = undefined;
  }

  update(patch: SettingsPatch): Settings {
    checkPatchShape(patch);
    if (this.doc) {
      this.deps.root?.ensure();
      if (this.cache && this.changedOnDisk()) this.cache = this.load(); // an edit on disk not handed over yet comes first
    }
    const next = deepMerge(this.get(), patch, this.defaults); // null: the key's default, as the file and a restart read it
    validateSettings(next);
    settled(next, this.pc);
    for (const section of Object.keys(patch)) delete this.rejected[section]; // the change replaces what was not applied
    if (this.doc) this.write(next, true);
    this.cache = next;
    this.applied(next);
    this.problems = this.problems.filter((problem) => !(problem.section in patch) && problem.section in this.rejected);
    this.setNotice(undefined);
    const result = this.get();
    this.deps.bus.emit('settings.updated', result);
    return result;
  }

  /** The watcher saw settings.json change: the edit is taken over and announced (nothing when it says the same). */
  fromDisk(): void {
    if (!this.doc || !this.changedOnDisk(true)) return;
    const before = this.cache;
    this.cache = this.load();
    if (before && sameSettings(before, this.cache)) return;
    this.deps.bus.emit('settings.updated', this.get());
  }

  // ---------------------------------------------------------------- internals

  private changedOnDisk(fresh = false): boolean {
    if (fresh) this.doc!.forget();
    return readKey(this.doc!.safeCheck()) !== this.seen;
  }

  private load(): Settings {
    const base = this.cache ?? this.defaults;
    if (!this.doc) return settingsFrom({}, base, this.defaults).settings;
    const read = this.doc.safeCheck();
    this.seen = readKey(read);
    if (read.kind === 'missing') {
      const settings = this.cache ?? this.withKept(settingsFrom({}, base, this.defaults).settings);
      this.rejected = {};
      this.problems = [];
      this.unusable = false;
      this.setNotice(undefined);
      this.write(settings, false);
      return settings;
    }
    const parsed = read.kind === 'ok' ? parseText(read.text) : { whole: READ_PROBLEM[read.problem] };
    if (!parsed.data) { // nothing of it can be used: the last good values stay
      this.unusable = true;
      this.rejected = {};
      this.problems = [];
      this.setNotice(parsed.whole);
      return this.cache ? structuredClone(base) : this.withKept(structuredClone(base));
    }
    const { settings, problems, rejected, dropped } = settingsFrom(parsed.data, base, this.defaults);
    this.keepSecurity(settings, rejected, problems); // Sicher-Runde: the security section changes only through update()
    this.unusable = false;
    this.rejected = rejected;
    this.problems = problems;
    this.setNotice(parsed.whole);
    if (dropped.length) this.deps.log?.info('unknown settings left out of settings.json', { keys: dropped });
    // Whole and current: written only when the text differs – never over a file whose sections only fail together.
    if (!problems.some((problem) => problem.section === 'settings')) this.write(settings, false);
    this.applied(settings);
    return settings;
  }

  /**
   * Sicher-Runde 19.11.2026 (FX1 H4: in every mode): an edit of settings.json that changes the `security` section is not applied –
   * the section in force stays, the file is written back with it and the edit is kept as settings.rejected.json, with a
   * quiet notice. The person changes it in Settings › Security (update()); a linked PC's copy comes through update() too.
   */
  private keepSecurity(settings: Settings, rejected: Plain, problems: FileProblem[]): void {
    const before = this.cache ? { security: this.cache.security } : this.lastApplied(); // REVIEW-2 9: the first read too
    if (!before) return;
    if (sameSettings(before.security, settings.security) && !Object.hasOwn(rejected, 'security')) return;
    this.doc?.keepRejected('copy');
    if (before.security === undefined) delete settings.security; else settings.security = structuredClone(before.security);
    delete rejected.security;
    problems.push({ section: 'security', detail: 'the security settings change only in Settings › Security; the edit is kept in settings.rejected.json' });
  }

  /** The security section last applied (kv; undefined: no record – the first start of this version or a new company). */
  private lastApplied(): { security: Settings['security'] } | undefined {
    if (!this.deps.db) return undefined;
    try {
      const kept = new KvRepo(this.deps.db).get<{ security: Settings['security'] | null }>(SECURITY_NS, SECURITY_KEY);
      return kept ? { security: kept.security ?? undefined } : undefined;
    } catch { return undefined; }
  }

  /** `settings` with the security section last applied, when there is a record (a first read without a usable file). */
  private withKept(settings: Settings): Settings {
    const kept = this.lastApplied();
    if (!kept) return settings;
    if (kept.security === undefined) delete settings.security; else settings.security = structuredClone(kept.security);
    return settings;
  }

  /** Keeps the security section now in force (written only when it changed). */
  private applied(settings: Settings): void {
    if (!this.deps.db) return;
    const kept = this.lastApplied();
    if (kept && sameSettings(kept.security, settings.security)) return;
    try { new KvRepo(this.deps.db).set(SECURITY_NS, SECURITY_KEY, { security: settings.security ?? null }, this.deps.clock.now()); } catch (error) {
      this.deps.log?.warn('security section not kept', { error: String(error) });
    }
  }

  /** Writes `settings` (sections not applied stay as written); `strict` throws when it fails, else it is logged. */
  private write(settings: Settings, strict: boolean): void {
    const doc = this.doc!;
    this.writeSchema();
    const why = Object.fromEntries([...this.problems].reverse().map((problem) => [problem.section, problem.detail]));
    const text = settingsText(settings, this.pc, this.rejected, why);
    const read = doc.safeCheck();
    if (read.kind === 'ok' && read.text === canonical(text)) { this.seen = readKey(read); return; } // it already says this
    try {
      if (this.unusable && read.kind !== 'missing') doc.keepRejected('copy');
      doc.write(text);
    } catch (error) {
      this.deps.log?.warn('settings.json not written', { error: String(error) });
      if (strict) throw new WorkforceError('unavailable', 'The settings could not be saved: settings.json in the Autark folder cannot be written.');
      return;
    }
    this.seen = `text:${canonical(text)}`;
    this.unusable = false;
  }

  /** settings.schema.json beside the file, written when missing or out of date (once per start; a failure is logged). */
  private writeSchema(): void {
    if (this.schemaDone) return;
    this.schemaDone = true;
    const file = path.join(path.dirname(this.doc!.file), SETTINGS_SCHEMA_FILE);
    const text = schemaText(this.pc);
    try {
      const read = readText(file, { maxBytes: SETTINGS_FILE_MAX_BYTES });
      if (read.kind === 'ok' && read.text === canonical(text)) return;
      writeAtomic(file, text, this.deps.root);
    } catch (error) {
      this.deps.log?.warn('settings.schema.json not written', { error: String(error) });
    }
  }

  /** The notice for the problems now (and `whole`: the file cannot be used at all); told only when it changes. */
  private setNotice(whole: string | undefined): void {
    const text = whole || this.problems.length ? noticeText(this.problems, whole) : undefined;
    if (text === this.noticeText) return;
    this.noticeText = text;
    if (text) this.deps.log?.warn('settings.json not fully applied', { detail: text });
    this.deps.bus.emit('settings.notice', text ? { text } : {});
  }
}
