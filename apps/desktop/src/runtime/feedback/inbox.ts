// The team inbox (B-055 Q2/Q3) on every PC and company whose vault holds the team's private key: a fetch lists the
// mailbox, opens each letter it does not have yet (seal.ts, checked by letter.ts) and stores it as
// <data>/feedback-inbox/<id>.json (+ its images <id>.png|jpg|webp, <id>.2.…, owner 21.11.2026: several per report; an
// item an older build stored with `screenshot` has that file as its first image). No new table: plain files. Owner
// 20.11.2026: a report is its words – a recording in an older letter is not kept, and removing a report takes every file
// of it (also the <id>.a<n>.* recordings older inboxes stored beside it).
// 16.11.2026: a fetch no longer deletes a readable letter. The team key travels to the owner's linked PCs, and every
// company of a PC can hold it, so whoever fetched first took the letters away from all the others (three reports of the
// morning sat on the notebook only). Now every team PC sees every letter; a letter leaves the mailbox when the team
// removes the report or its mark's keep time passes (remove/purge), or – checked at every fetch by Google's createTime,
// whatever its id – once it is older than LETTER_TTL_MS (no TTL policy or rules v2 needed, the listing stays bounded);
// an old letter this PC does not have yet is opened and stored first.
// A removed report leaves a 0-byte <id>.gone beside the reports, so a letter whose mailbox delete failed (offline)
// does not come back; it goes LETTER_TTL_MS + 1 day later, when the age deletion took the letter for sure.
// A fetch runs once at app start (receiving PCs only), when the inbox opens (Settings › Feedback › Inbox) and on Refresh / wf feedback
// receive – never on a timer. A letter this key cannot open (an earlier key, damaged) is kept as it came under
// unreadable/ (that copy marks it seen) and stays in the mailbox, where a team PC with the newer key still opens it;
// ids no sender of ours makes are left alone until the age deletion.
// Feedback 16.11.2026 (owner): the team marks a report done or not relevant (mark); a marked report goes by itself
// FEEDBACK_HANDLED_KEEP_MS later – checked whenever the inbox is listed or fetched (start, open, Refresh), still no timer.
// Marks stay per PC.
// Spam guard: at most UNREADABLE_KEEP letters are kept under unreadable/ (each lives UNREADABLE_KEEP_MS); a flood of
// letters nobody of ours sealed beyond that is counted and deleted in the mailbox instead of filling this PC.
// Owns: the fetch order (open → images → JSON last), the local files, the tombstones, deleting a removed report's
// letter and the age deletion. Never: deletes a readable young letter at a fetch, logs a key, a token or a letter's
// text, or polls.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { FEEDBACK_HANDLED_KEEP_MS, inboxImageFile, INBOX_DIR, type FeedbackHandled, type FeedbackImageType, type FeedbackInboxFetch, type FeedbackInboxItem } from '../../shared/model/feedback-delivery.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { DOCUMENT_ID, LETTER_TTL_MS } from './drop.ts';
import { Mailbox, parseServiceAccount } from './google.ts';
import { itemOf } from './letter.ts';
import { readReceiver } from './receiver.ts';
import { openReport } from './seal.ts';
import { TOKEN_URL } from './transport.ts';

export const RECEIVER_KEY_ID = 'feedback-receiver-key';
export const SERVICE_ACCOUNT_ID = 'feedback-service-account';
/** Letters this PC's key cannot open, kept as they came (<data>/feedback-inbox/unreadable/<id>.wfb). */
export const UNREADABLE_DIR = 'unreadable';
/** kv feedback/receiver: { project, publicKey, apiKey } of the last `wf feedback setup` (public values only). */
export const SETUP_KEY = { ns: 'feedback', key: 'receiver' } as const;
/** Letters one fetch takes at most (the mailbox is writable by anyone with the build: a flood must not stall the PC). */
export const MAX_PER_FETCH = 200;
/** Unopenable letters kept on this PC at most, and how long each stays (a rotated key's last letters, not a flood). */
export const UNREADABLE_KEEP = 20;
export const UNREADABLE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** A removed report's tombstone (<id>.gone); swept TOMBSTONE_KEEP_MS after it was written. */
export const GONE = '.gone';
export const TOMBSTONE_KEEP_MS = LETTER_TTL_MS + 24 * 60 * 60 * 1000;
const LIST_MAX = 500;

export interface InboxDeps {
  services: () => RuntimeServices;
  fetch?: typeof fetch;
  /** Tests: Google's endpoints. Default: the receiver's loopback `endpoint` (tests) or Google. */
  firestore?: string;
  tokenUrl?: string;
}

function countFiles(dir: string, ext: string): number {
  try { return readdirSync(dir).filter((name) => name.endsWith(ext)).length; } catch { return 0; }
}

function writeAtomic(file: string, data: string | Buffer): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, file);
}

function checkId(id: string): string {
  if (!DOCUMENT_ID.test(id)) throw new WorkforceError('bad_request', 'Invalid report id.');
  return id;
}

export class FeedbackInbox {
  private readonly deps: InboxDeps;
  private running: Promise<FeedbackInboxFetch> | undefined;

  constructor(deps: InboxDeps) {
    this.deps = deps;
  }

  /** This PC holds the team's private key (the vault's entry; its value is not read here). */
  receiving(): boolean {
    try { return this.deps.services().secrets.list().some((entry) => entry.id === RECEIVER_KEY_ID); } catch { return false; }
  }

  dir(): string {
    return path.join(this.deps.services().paths.data, INBOX_DIR);
  }

  /** The stored reports, newest first; marked reports past their keep time go first (purge). */
  list(): FeedbackInboxItem[] {
    this.purge();
    return this.stored();
  }

  private stored(): FeedbackInboxItem[] {
    let names: string[];
    try { names = readdirSync(this.dir()); } catch { return []; }
    const items: FeedbackInboxItem[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!DOCUMENT_ID.test(id)) continue;
      const item = this.read(id);
      if (item) items.push(item);
    }
    return items.sort((a, b) => b.receivedAt - a.receivedAt || b.createdAt - a.createdAt).slice(0, LIST_MAX);
  }

  private read(id: string): FeedbackInboxItem | undefined {
    try {
      const stored = JSON.parse(readFileSync(path.join(this.dir(), `${id}.json`), 'utf8')) as FeedbackInboxItem & { audio?: unknown; screenshot?: { mime: FeedbackImageType; size: number } };
      if (!stored || stored.id !== id || typeof stored.text !== 'string') return undefined;
      const { audio: _recordings, screenshot, ...item } = stored; // an older inbox's list of recordings: not part of a report
      return screenshot && !item.images ? { ...item, images: [screenshot] } : item; // an older build's one screenshot: <id>.<ext>
    } catch {
      return undefined;
    }
  }

  /** Image `index` (0-based) of a stored report. */
  image(id: string, index: number): { mime: FeedbackImageType; dataBase64: string } {
    const image = this.read(checkId(id))?.images?.[index];
    if (!image) throw new WorkforceError('not_found', 'This report has no such image.');
    try {
      return { mime: image.mime, dataBase64: readFileSync(path.join(this.dir(), inboxImageFile(id, index, image.mime))).toString('base64') };
    } catch {
      throw new WorkforceError('not_found', 'This report has no such image.');
    }
  }

  /** Marks a stored report done or not relevant – or clears the mark (null). */
  mark(id: string, as: FeedbackHandled | null): FeedbackInboxItem {
    const item = this.read(checkId(id));
    if (!item) throw new WorkforceError('not_found', 'This report is not in the inbox.');
    const { handled: _old, ...rest } = item;
    const next: FeedbackInboxItem = as ? { ...rest, handled: { as, at: this.deps.services().clock.now() } } : rest;
    writeAtomic(path.join(this.dir(), `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /**
   * Removes marked reports whose keep time passed, unopenable letters past UNREADABLE_KEEP_MS (oldest beyond
   * UNREADABLE_KEEP too) and tombstones past TOMBSTONE_KEEP_MS; answers how many reports went. Never touches an
   * unmarked report.
   */
  purge(): number {
    const now = this.deps.services().clock.now();
    let removed = 0;
    for (const item of this.stored()) {
      if (item.handled && now - item.handled.at >= FEEDBACK_HANDLED_KEEP_MS) { this.remove(item.id); removed += 1; }
    }
    const aged = (dir: string, ext: string) => {
      try {
        return readdirSync(dir).filter((name) => name.endsWith(ext)).map((name) => ({ file: path.join(dir, name), at: statSync(path.join(dir, name)).mtimeMs }));
      } catch { return []; }
    };
    const letters = aged(path.join(this.dir(), UNREADABLE_DIR), '.wfb').sort((a, b) => b.at - a.at);
    letters.forEach((letter, index) => { if (index >= UNREADABLE_KEEP || now - letter.at >= UNREADABLE_KEEP_MS) rmSync(letter.file, { force: true }); });
    for (const stone of aged(this.dir(), GONE)) if (now - stone.at >= TOMBSTONE_KEEP_MS) rmSync(stone.file, { force: true });
    return removed;
  }

  /**
   * Deletes a stored report and every file of it on this PC (<id>.*) and its letter in the mailbox; the tombstone keeps
   * the next fetch from bringing it back when that delete fails (offline).
   */
  remove(id: string): { ok: true } {
    checkId(id);
    const dir = this.dir();
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* no inbox folder yet */ }
    for (const name of names) if (name.startsWith(`${id}.`)) rmSync(path.join(dir, name), { force: true }); // ids have no ".": only this report's
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, `${id}${GONE}`), '', { mode: 0o600 });
    } catch (error) {
      this.deps.services().log.warn('feedback tombstone not written', { error: error instanceof Error ? error.message : String(error) });
    }
    void this.forget(id);
    return { ok: true };
  }

  /** The letter of a removed report leaves the mailbox; offline or refused, the age deletion takes it later (the tombstone holds till then). */
  private async forget(id: string): Promise<void> {
    const s = this.deps.services();
    try {
      const { mailbox } = await this.mailbox(s);
      await mailbox.remove(id);
    } catch (error) {
      s.log.warn('feedback letter not deleted in the mailbox', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Fetches now; a second call while one runs shares it. */
  fetch(): Promise<FeedbackInboxFetch> {
    this.running ??= this.fetchOnce().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async mailbox(s: RuntimeServices): Promise<{ mailbox: Mailbox; privateKey: string }> {
    if (!this.receiving()) throw new WorkforceError('not_found', 'This PC has no team key for feedback. Run wf feedback setup first.');
    const privateKey = await s.secrets.use(RECEIVER_KEY_ID, SYSTEM_ID);
    let accountText: string;
    try { accountText = await s.secrets.use(SERVICE_ACCOUNT_ID, SYSTEM_ID); } catch {
      throw new WorkforceError('not_found', 'The feedback service account is missing. Run wf feedback setup again.');
    }
    const account = parseServiceAccount(accountText);
    const receiver = readReceiver(s);
    const project = new KvRepo(s.db).get<{ project?: string }>(SETUP_KEY.ns, SETUP_KEY.key)?.project ?? receiver?.project ?? account.project_id;
    if (!project) throw new WorkforceError('not_found', 'The feedback project is unknown. Run wf feedback setup again.');
    const firestore = this.deps.firestore ?? receiver?.endpoint;
    const tokenUrl = this.deps.tokenUrl ?? (receiver?.endpoint ? `${receiver.endpoint}/token` : TOKEN_URL);
    return { mailbox: new Mailbox(account, { project, firestore, tokenUrl, fetch: this.deps.fetch ?? fetch, now: () => s.clock.now() }), privateKey };
  }

  private async fetchOnce(): Promise<FeedbackInboxFetch> {
    const s = this.deps.services();
    const { mailbox, privateKey } = await this.mailbox(s);
    const dir = this.dir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = s.clock.now();
    const here = (id: string) => ['.json', GONE].some((ext) => existsSync(path.join(dir, `${id}${ext}`))) || existsSync(path.join(dir, UNREADABLE_DIR, `${id}.wfb`));
    let added = 0;
    let unreadable = 0;
    let expired = 0;
    let keptUnreadable = countFiles(path.join(dir, UNREADABLE_DIR), '.wfb');
    let taken = 0;
    let more = false;
    let pageToken: string | undefined;
    do {
      const page = await mailbox.page(pageToken);
      for (const { id, created } of page.letters) {
        const old = created !== undefined && now - created >= LETTER_TTL_MS;
        const ours = DOCUMENT_ID.test(id);
        if (!ours && !old) { unreadable += 1; continue; } // never one of ours (senders use UUIDs): left alone until it is old
        const fresh = ours && !here(id);
        if (!fresh && !old) continue; // a stored, removed or kept unopenable letter
        if (taken >= MAX_PER_FETCH) { more = true; break; }
        taken += 1;
        // A letter not on this PC yet is opened first – an old one too, so a PC away for a month still gets it; then an
        // old letter leaves the mailbox whatever it is, and an unopenable one beyond the cap (a flood) as well. A
        // readable young letter stays: the team's other PCs and companies fetch it too.
        const outcome = fresh ? await this.take(mailbox, privateKey, id, keptUnreadable < UNREADABLE_KEEP) : undefined;
        if (outcome === 'added') added += 1;
        else if (outcome) unreadable += 1;
        if (outcome === 'kept') keptUnreadable += 1;
        if (old || outcome === 'flood') await mailbox.remove(id);
        if (old) expired += 1;
      }
      pageToken = more ? undefined : page.next;
    } while (pageToken);
    const total = this.list().length; // list() purges marked reports past their keep time
    s.log.info('feedback inbox fetched', { added, unreadable, expired, more }); // counts only
    return { added, unreadable, more, total };
  }

  /**
   * Opens letter `id` and stores it here ('added'). One this key cannot open (an earlier key, damaged) is kept as it
   * came under unreadable/ when `keep` ('kept': the copy marks it seen), else it is a flood ('flood'); 'gone': it is no
   * longer there or is no v1 letter.
   */
  private async take(mailbox: Mailbox, privateKey: string, id: string, keep: boolean): Promise<'added' | 'kept' | 'flood' | 'gone'> {
    const dir = this.dir();
    const sealed = await mailbox.sealed(id);
    if (!sealed) return 'gone';
    let opened: ReturnType<typeof itemOf>;
    try { opened = itemOf(id, JSON.parse(openReport(privateKey, sealed).toString('utf8')), this.deps.services().clock.now()); } catch { opened = undefined; }
    if (!opened) {
      if (!keep) return 'flood';
      mkdirSync(path.join(dir, UNREADABLE_DIR), { recursive: true, mode: 0o700 });
      writeAtomic(path.join(dir, UNREADABLE_DIR, `${id}.wfb`), sealed);
      return 'kept';
    }
    const { item, images } = opened;
    item.images?.forEach((image, index) => writeAtomic(path.join(dir, inboxImageFile(id, index, image.mime)), images[index]));
    writeAtomic(path.join(dir, `${id}.json`), `${JSON.stringify(item, null, 2)}\n`); // last: it marks the letter stored
    return 'added';
  }
}
