// The topic texts of the security mode (owner 19.11.2026: "jedes Textfeld ist einfach eine Datei"): one file per text,
// <data>/security/<mode>/<topic>.md; a topic without a file reads the shipped default resources/security/<mode>/<topic>.md
// ('' when there is none). `{{name}}` stands for the person's name (profile.name, else "the person"). The team reads the
// texts in its prompt (context/prompt-stable.ts, runtime/security/agreements.ts); Settings › Security shows and saves them
// (security.topics / security.saveTopic, rpc/handlers/security-mode.ts). A save that says what the default says removes
// the file, so the topic follows the shipped default again.
// The owner of the data folder entry `security` (root/watcher.ts): the texts the app accepted are kept in kv
// 'security.topics' (rel path → text, null = no file). An edit on disk – an agent, an editor, a script – of a Trust AI
// text (security/trust/) is taken over in Trust AI mode (the prompt reads the file anyway; the change log names it 'an
// edit of the file'); in Secure mode, and for the Secure texts (security/secure/) in every mode (FX1 H4: a text written
// ahead in Trust AI mode would rule once the person switches), it is put back (owner: "Einfach die Runtime blockiert
// es"): the edited text is kept once as <topic>.rejected.md and the accepted text written again (or the file removed).
// isAccepted() tells file sync (devices/sync/files.ts) whether a file says what the app accepted – only that travels. A copy from a linked PC is accepted before it is put in place
// (acceptSynced, devices/sync/files.ts). The first look records what is there. A file that cannot be read as text is
// moved aside the same way in both modes.
// One instance per runtime (securityTopics): made, registered and reconciled on first use – the prompt, the RPC or a
// synced copy, whichever comes first; the composition may call it at start.
// Owns: the folder, the files' read/write, the defaults, {{name}}, the accepted texts and the put-back. Never: decides a
// call (runtime/security/policy.ts), renders the prompt section (agreements.ts), or polls.

import { rmSync } from 'node:fs';
import path from 'node:path';
import type { Clock, Logger, RuntimeServices } from '../contracts.ts';
import '../contracts/root.ts'; // RuntimeServices.rootWatcher
import type { RootWatcher } from '../root/watcher.ts';
import { MAX_TOPIC_TEXT, SECURITY_DIR, SECURITY_MODES, SECURITY_TOPICS, topicPath, type SecurityMode, type SecurityTopic } from '../../shared/model/security-settings.ts';
import type { TopicText } from '../../shared/api/methods-security-mode.ts';
import type { SecurityActor, SecurityChange, SecurityField } from '../../shared/model/security-log.ts';
import { securityOf, type Settings } from '../../shared/model/system.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { TextDoc, readText } from '../root/text-doc.ts';
import { FILE_EDIT, LINKED_PC, noteSecurityChanges, type LogKv } from '../settings/security-log.ts';

const NS = 'security.topics';
/** A topic file larger than this is no text the app reads (MAX_TOPIC_TEXT characters fit many times). */
const LIMITS = { maxBytes: 64 * 1024 };
/** Control characters other than tab and line ends. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export interface TopicsDeps {
  dataDir: string;
  resourcesDir: string;
  settings: { get(): Settings };
  kv: LogKv;
  transaction?: <T>(run: () => T) => T;
  clock: Clock;
  log: Logger;
  root?: Pick<RootWatcher, 'register' | 'wrote'>;
}

/** The text as files and the accepted record keep it: LF, no white space around it. */
const norm = (text: string): string => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();

/** `{{name}}` filled with the person's name ("the person" without one). */
export function fillName(text: string, name: string): string {
  return text.replaceAll('{{name}}', name.trim() || 'the person');
}

/** 'security/<mode>/<topic>.md' → its mode and topic; undefined for any other path. */
export function topicOfRel(rel: string): { mode: SecurityMode; topic: SecurityTopic } | undefined {
  const match = /^security\/(trust|secure)\/([a-z]+)\.md$/.exec(rel);
  if (!match || !(SECURITY_TOPICS as readonly string[]).includes(match[2])) return undefined;
  return { mode: match[1] as SecurityMode, topic: match[2] as SecurityTopic };
}

/** The shipped defaults, read once per file (resources never change while the app runs). */
const DEFAULTS = new Map<string, string>();
function shippedDefault(resourcesDir: string, mode: SecurityMode, topic: SecurityTopic): string {
  const file = path.join(resourcesDir, SECURITY_DIR, mode, `${topic}.md`);
  let text = DEFAULTS.get(file);
  if (text === undefined) {
    const read = readText(file, LIMITS);
    text = read.kind === 'ok' ? norm(read.text) : '';
    DEFAULTS.set(file, text);
  }
  return text;
}

export class SecurityTopics {
  private readonly deps: TopicsDeps;
  private readonly docs = new Map<string, TextDoc>();
  private readonly off?: () => void;

  constructor(deps: TopicsDeps) {
    this.deps = deps;
    try { this.reconcile(); } catch (error) { deps.log.warn('security texts not checked', { error: String((error as Error)?.message ?? error) }); }
    try { this.off = deps.root?.register(SECURITY_DIR, () => this.reconcile()); } catch (error) { deps.log.warn('security folder not watched', { error: String((error as Error)?.message ?? error) }); }
  }

  close(): void {
    this.off?.();
  }

  /** The topic's own file text, or null without a usable file (then the default stands). */
  fileText(mode: SecurityMode, topic: SecurityTopic): string | null {
    const read = this.doc(mode, topic).safeCheck();
    return read.kind === 'ok' ? norm(read.text) : null;
  }

  /** The shipped default with {{name}} filled ('' when the topic has none). */
  defaultText(mode: SecurityMode, topic: SecurityTopic): string {
    return fillName(shippedDefault(this.deps.resourcesDir, mode, topic), this.name());
  }

  /** What the team reads for the topic: its file or the default, {{name}} filled, at most MAX_TOPIC_TEXT characters. */
  text(mode: SecurityMode, topic: SecurityTopic): string {
    const own = this.fileText(mode, topic);
    const text = own === null ? this.defaultText(mode, topic) : fillName(own, this.name());
    return text.length > MAX_TOPIC_TEXT ? text.slice(0, MAX_TOPIC_TEXT).trimEnd() : text;
  }

  /** Every topic of a mode as Settings › Security shows it. */
  list(mode: SecurityMode): TopicText[] {
    return SECURITY_TOPICS.map((topic) => this.entry(mode, topic));
  }

  /**
   * The person's save: `text` becomes the topic's file; null, or a text that says what the default says, removes it (the
   * default stands again). Logged with `by`. An edit on disk not handed over yet is looked at first.
   */
  save(mode: SecurityMode, topic: SecurityTopic, text: string | null, by: SecurityActor | (() => SecurityActor)): TopicText {
    if (text !== null && (text.length > MAX_TOPIC_TEXT || CONTROL.test(text))) {
      throw new WorkforceError('bad_request', `A security text is plain text of at most ${MAX_TOPIC_TEXT} characters.`, { details: { topic } });
    }
    this.reconcile();
    const before = this.fileText(mode, topic);
    const clean = text === null ? null : norm(text);
    const next = clean === null || clean === norm(this.defaultText(mode, topic)) || clean === shippedDefault(this.deps.resourcesDir, mode, topic) ? null : clean;
    const actor = typeof by === 'function' ? by() : by; // recheck after reconcile, synchronously at commit
    if (next !== before) {
      if (typeof by === 'function') {
        this.putAudited(mode, topic, before, next, actor);
      } else {
        this.put(mode, topic, next);
        this.record(mode, topic, next);
        this.log([this.change(mode, topic, before, next, actor)]);
      }
    }
    return this.entry(mode, topic);
  }

  /** A topic file a linked PC sends is accepted before it is put in place (null: it was removed there); other paths are ignored. */
  acceptSynced(rel: string, text: string | null): void {
    const topic = topicOfRel(rel);
    if (!topic) return;
    const next = text === null ? null : norm(text);
    const before = this.accepted(rel);
    this.record(topic.mode, topic.topic, next);
    if (before !== undefined && before.text !== next) this.log([this.change(topic.mode, topic.topic, before.text, next, LINKED_PC)]);
  }

  /**
   * True when the topic file at `rel` (text as on disk, null: no file) says what the app accepted – saved by the person,
   * taken over or put back by reconcile, or a linked PC's accepted copy. False for any other path's text, an edit not
   * looked at yet and one about to be put back (FX1 H5: file sync sends only what is true here).
   */
  isAccepted(rel: string, text: string | null): boolean {
    if (!topicOfRel(rel)) return false;
    const stored = this.accepted(rel);
    return stored !== undefined && stored.text === (text === null ? null : norm(text));
  }

  /** Looks at every topic file: takes an edit over (Trust AI mode, Trust texts) or puts it back; see the header. */
  reconcile(): void {
    const secure = securityOf(this.deps.settings.get()).mode === 'secure';
    const changes: SecurityChange[] = [];
    for (const mode of SECURITY_MODES) {
      for (const topic of SECURITY_TOPICS) {
        const rel = topicPath(mode, topic);
        const doc = this.doc(mode, topic);
        const read = doc.safeCheck();
        const stored = this.accepted(rel);
        if (read.kind === 'problem') {
          doc.keepRejected('move');
          this.put(mode, topic, stored?.text ?? null);
          this.deps.log.info('security text moved aside', { file: rel, problem: read.problem });
          continue;
        }
        const now = read.kind === 'ok' ? norm(read.text) : null;
        if (!stored) { this.record(mode, topic, now); continue; } // the first look: what is there is the start
        if (stored.text === now) continue;
        if (secure || mode === 'secure') { // FX1 H4: the Secure texts change only through the app, in every mode
          if (now !== null) doc.writeRejected(`${now}\n`);
          this.put(mode, topic, stored.text);
          this.deps.log.info('security text put back', { file: rel, in: secure ? 'secure' : 'trust' });
          continue;
        }
        this.record(mode, topic, now);
        changes.push(this.change(mode, topic, stored.text, now, FILE_EDIT));
      }
    }
    this.log(changes);
  }

  // ---------------------------------------------------------------- internals

  private name(): string {
    try { return this.deps.settings.get().profile.name ?? ''; } catch { return ''; }
  }

  private entry(mode: SecurityMode, topic: SecurityTopic): TopicText {
    const own = this.fileText(mode, topic);
    return { topic, text: own === null ? this.defaultText(mode, topic) : fillName(own, this.name()), isDefault: own === null };
  }

  private doc(mode: SecurityMode, topic: SecurityTopic): TextDoc {
    const rel = topicPath(mode, topic);
    let doc = this.docs.get(rel);
    if (!doc) {
      doc = new TextDoc({ file: path.join(this.deps.dataDir, ...rel.split('/')), limits: LIMITS, clock: this.deps.clock, writes: this.deps.root });
      this.docs.set(rel, doc);
    }
    return doc;
  }

  /** Writes the topic's file (null: removes it), as the app's own write. */
  private put(mode: SecurityMode, topic: SecurityTopic, text: string | null): void {
    const doc = this.doc(mode, topic);
    if (text !== null) { doc.write(`${text}\n`); return; }
    rmSync(doc.file, { force: true });
    doc.forget();
    this.deps.root?.wrote(doc.file, null);
  }

  /** A named agent save requires the audit and accepted state. Neither is best-effort on this path. */
  private putAudited(mode: SecurityMode, topic: SecurityTopic, before: string | null, next: string | null, actor: SecurityActor): void {
    const tx = this.deps.transaction;
    if (!tx) throw new WorkforceError('unavailable', 'The agreement change log is unavailable.');
    let putting = false;
    try {
      tx(() => {
        noteSecurityChanges(this.deps.kv, [this.change(mode, topic, before, next, actor)]);
        this.record(mode, topic, next);
        putting = true;
        this.put(mode, topic, next);
      });
    } catch (error) {
      // SQLite rolls back both writes. Restore the previous file on a write/commit error;
      // a process crash or failure of the restore itself is not an atomic FS/DB transaction.
      if (putting) {
        try {
          if (this.fileText(mode, topic) !== before) this.put(mode, topic, before);
        } catch (restoreError) {
          this.deps.log.error('security agreement could not be restored after an audit failure', { topic, error: String(restoreError) });
        }
      }
      throw error;
    }
  }

  private accepted(rel: string): { text: string | null } | undefined {
    const stored = this.deps.kv.get<{ text?: unknown }>(NS, rel);
    if (!stored || typeof stored !== 'object') return undefined;
    return { text: typeof stored.text === 'string' ? stored.text : null };
  }

  private record(mode: SecurityMode, topic: SecurityTopic, text: string | null): void {
    this.deps.kv.set(NS, topicPath(mode, topic), { text }, this.deps.clock.now());
  }

  /** One log entry: the text that applied before and after (a missing file: the default). */
  private change(mode: SecurityMode, topic: SecurityTopic, from: string | null, to: string | null, by: SecurityActor): SecurityChange {
    const shown = (text: string | null) => (text === null ? `(default) ${this.defaultText(mode, topic)}`.trim() : fillName(text, this.name()));
    return { at: this.deps.clock.now(), field: topicPath(mode, topic) as SecurityField, by, from: shown(from), to: shown(to) };
  }

  private log(changes: readonly SecurityChange[]): void {
    try { noteSecurityChanges(this.deps.kv, changes); } catch (error) { this.deps.log.warn('security text change not logged', { error: String(error) }); }
  }
}

type TopicServices = Pick<RuntimeServices, 'paths' | 'settings' | 'db' | 'clock' | 'log'> & { rootWatcher?: RootWatcher };
const BY_RUNTIME = new WeakMap<object, SecurityTopics>();

/** This runtime's topics: made, registered on the data folder watcher and reconciled on first use (see the header). */
export function securityTopics(s: TopicServices): SecurityTopics {
  let topics = BY_RUNTIME.get(s);
  if (!topics) {
    topics = new SecurityTopics({ dataDir: s.paths.data, resourcesDir: s.paths.resources, settings: s.settings, kv: new KvRepo(s.db), transaction: (run) => s.db.tx(run), clock: s.clock, log: s.log, root: s.rootWatcher });
    BY_RUNTIME.set(s, topics);
  }
  return topics;
}
