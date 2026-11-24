// The page's feedback outbox (feedback 16.11.2026, F15/F22: nothing written on a phone may be lost to a reload, a crash,
// a company switch or a dead connection). Two things live in this page's IndexedDB (pwa/idb.ts's store; memory where
// IndexedDB is blocked – then only until the page closes):
// - the draft (draft.ts) under 'feedback-draft', kept DRAFT_SAVE_MS after each change and restored on the next start;
// - each report the person sent, under 'feedback:<clientId>', written BEFORE any upload or call. deliver() uploads its
//   images (owner 21.11.2026: several, `images`; an older build's entry has one `image` – entryImages), calls feedback.create with the clientId (the runtime answers the same clientId with the report
//   it already has, so a lost answer never makes a second one) and – where the button said Send – feedback.send, then
//   deletes the entry. A report the PC could not be reached for stays ('held'); every (re)connect flushes the entries,
//   oldest first, one round at a time. A report the runtime refuses as invalid is deleted and put back into an empty
//   draft, so its words are still there. Entries older than OUTBOX_MAX_AGE_MS go.
// 18.11.2026 (owner: "das soll doch einfach direkt zu uns gehen"): a Send goes straight to the team's mailbox (direct.ts) –
// the runtime is only the way where this page cannot seal it, or when the mailbox refused it. Such a report is not kept on
// the PC; it waits in this page until the mailbox has it (flushed at start, on every (re)connect, when the device is online
// again and every FLUSH_EVERY_MS).
// Owner 24.11.2026 (after a lost connection to the runtime the dock said "Not sent" and nothing helped; "kein PC hat Vorrang,
// jeder PC ist gleich"): the desktop window sends the same way – it always sends itself, straight to the mailbox, whatever
// state the link to the company's runtime is in; that runtime route stays only the fallback and never blocks. What only the
// runtime knows (its log's diagnostics, the company, the vault's values blacked out of the words) goes along when it answers
// within CONTEXT_WAIT_MS (runtimeContext); late or missing, the report goes without it at once. The mailbox's document id is the
// clientId and the runtime's letter of the same report uses it too (runtime/feedback/delivery.ts), so a report that went by
// both routes is one letter (409 = it is there).
// Owns: the outbox entries, the kept draft and their delivery. Never: sends a report without the person's Send/Save, or
// keeps an entry after the PC holds its report.

import { effect } from '@preact/signals';
import type { ParamsOf } from '../../shared/api/methods.ts';
import type { FeedbackReport } from '../../shared/model/system.ts';
import type { FeedbackContext } from '../../shared/model/feedback-delivery.ts';
import { errorText, RpcError, rpc } from '../lib/rpc.ts';
import { uploadRef } from '../lib/files.ts';
import { pushToast } from '../lib/toasts.ts';
import type { KeyValue } from '../lib/take-store.ts';
import { idbDelete, idbGet, idbSet, idbSweep } from '../pwa/idb.ts';
import { dataUrlToBlob } from './bridge.ts';
import { builtInReceiver, sendDirect } from './direct.ts';
import { bridge } from '../lib/platform.ts';
import { announceSent, notSentLine } from './delivery.ts';
import { CRASH_ONLY_TEXT, EMPTY_DRAFT, feedbackDraft, isEmptyDraft } from './draft.ts';
import type { DraftPhoto, DraftPlace, FeedbackDraft } from './draft.ts';
import { REPORT_IMAGE_NAME } from './paint.ts';
import type { PaintMark } from './paint.ts';

const ENTRY_PREFIX = 'feedback:';
const DRAFT_KEY = 'feedback-draft';
/** A report that could not go for a month is no longer worth sending. */
export const OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The draft is kept this long after the last change (typing does not write every key). */
export const DRAFT_SAVE_MS = 400;
/** A report that waits in this page is tried again this often, besides every (re)connect (owner 24.11.2026). */
export const FLUSH_EVERY_MS = 60_000;
/** How long a direct send waits for the runtime's part (feedback.context) before it goes without it. */
export const CONTEXT_WAIT_MS = 1500;

/** One report on its way to the PC. */
export interface OutboxEntry {
  clientId: string;
  /** When the person sent it (epoch ms). */
  at: number;
  /** feedback.send follows feedback.create (the button said Send); false: only saved on the PC (Save). */
  send: boolean;
  text: string;
  where: DraftPlace;
  /** Where it was written (client.ts). */
  client: string;
  /** The report's images in order (flattened JPEG data URLs). */
  images?: string[];
  /** An older build's entry: its one image (read by entryImages, never written). */
  image?: string;
  /** The text is a dictation's transcript (owner 20.11.2026: a report carries words, never a recording). */
  dictated?: true;
  clientDiagnostics?: string;
  /** feedback.create answered: only feedback.send is left. */
  reportId?: string;
}

export type ReportLine = Pick<FeedbackReport, 'id' | 'status'> & Partial<Pick<FeedbackReport, 'receiptId'>>;

/** What one delivery did: sent (confirmed), saved on the PC (not sent), held in this page, or refused as invalid. */
export type Outcome =
  | { kind: 'sent' | 'saved'; report: ReportLine; error?: unknown }
  | { kind: 'held'; error?: unknown }
  | { kind: 'refused'; error: unknown };

type CreateParams = ParamsOf<'feedback.create'>;
type CreateFiles = { imageFileIds?: string[] };

export interface OutboxDeps {
  /** This page's storage (null: memory only). */
  kv: KeyValue | null;
  create(params: CreateParams): Promise<FeedbackReport>;
  send(id: string): Promise<FeedbackReport>;
  /** Uploads a file; its file id. */
  upload(blob: Blob, name: string): Promise<string>;
  /** Straight to the team (direct.ts sendDirect): the sent line, null when this page cannot (the PC sends). */
  direct?(entry: OutboxEntry): Promise<ReportLine | null>;
  /** The link to the PC is open now. */
  online(): boolean;
  now(): number;
}

/**
 * The report never goes, however often: the PC answered that it is invalid or not this device's to file, or this page
 * itself failed on it while the link was up (an unreadable stored file).
 */
function refusedForGood(error: unknown, online: boolean): boolean {
  if (error instanceof RpcError) return error.code === 'bad_request' || error.code === 'forbidden';
  return online;
}

/**
 * Bridge 20.11.2026: an older build's report that had only its recording carries this text. A report is its words now,
 * so such an entry does not go out: it waits here (flush passes it by) until the form is empty at a start, then it comes
 * back there to be said in words (takeWordless) – or it goes after OUTBOX_MAX_AGE_MS.
 */
export const WORDLESS_TEXT = '(dictation not transcribed)';
export const wordless = (entry: Pick<OutboxEntry, 'text' | 'reportId'>): boolean => entry.text === WORDLESS_TEXT && !entry.reportId;

function validEntry(value: unknown): value is OutboxEntry {
  const entry = value as Partial<OutboxEntry> | null;
  return !!entry && typeof entry.clientId === 'string' && typeof entry.at === 'number' && typeof entry.text === 'string';
}

/** An entry's images in order: `images`, or an older build's one `image`. */
export function entryImages(entry: Pick<OutboxEntry, 'images' | 'image'>): string[] {
  return entry.images ?? (entry.image ? [entry.image] : []);
}

/** A refused report's content as a draft again (its words, its images as photos – their marks are in them – and crash report). */
export function draftOf(entry: OutboxEntry): FeedbackDraft {
  const words = entry.text === CRASH_ONLY_TEXT || entry.text === WORDLESS_TEXT ? '' : entry.text;
  const photos: DraftPhoto[] = entryImages(entry).map((src, index) => ({ id: `${entry.clientId}-${index}`, src, marks: [] }));
  return {
    ...EMPTY_DRAFT, text: words, photos, where: entry.where, dictated: entry.dictated === true,
    ...(entry.clientDiagnostics ? { diagnostics: entry.clientDiagnostics } : {}),
  };
}

/**
 * A kept draft's marks as pen lines. An older build's box ({ from, to }, the person's tool until 21.11.2026) becomes one
 * pen line as thick as the box is tall along its middle – its round ends cover the box whole, so nothing it hid shows.
 */
export function penMarks(marks: unknown): PaintMark[] {
  if (!Array.isArray(marks)) return [];
  return marks.flatMap((mark): PaintMark[] => {
    const m = mark as { tool?: unknown; width?: unknown; points?: unknown; from?: [number, number]; to?: [number, number] };
    if (m?.tool === 'pen' && Array.isArray(m.points) && typeof m.width === 'number') return [m as PaintMark];
    if (m?.tool !== 'box' || !Array.isArray(m.from) || !Array.isArray(m.to)) return [];
    const [left, right] = [Math.min(m.from[0], m.to[0]), Math.max(m.from[0], m.to[0])];
    const [top, bottom] = [Math.min(m.from[1], m.to[1]), Math.max(m.from[1], m.to[1])];
    const middle = (top + bottom) / 2;
    return [{ tool: 'pen', width: Math.max(1, bottom - top), points: [[left, middle], [right, middle]] }];
  });
}

/** A new client id (≤ 64 characters; Web Crypto works on plain http too, randomUUID does not). */
export function newClientId(now: number = Date.now()): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `fc-${now.toString(36)}-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export class FeedbackOutbox {
  private readonly deps: OutboxDeps;
  private readonly memory = new Map<string, OutboxEntry>();
  private readonly busy = new Set<string>();
  private flushing: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: OutboxDeps) {
    this.deps = deps;
  }

  /** Keeps an entry (memory at once, storage when it can) – before anything goes out. */
  put(entry: OutboxEntry): Promise<void> {
    this.memory.set(entry.clientId, entry);
    return this.serial(() => this.deps.kv?.set(ENTRY_PREFIX + entry.clientId, entry));
  }

  /** The entries waiting, oldest first; those older than OUTBOX_MAX_AGE_MS are deleted. */
  async pending(): Promise<OutboxEntry[]> {
    const all = new Map(this.memory);
    const stored = await this.serial(() => this.deps.kv?.values(ENTRY_PREFIX)) ?? [];
    for (const value of stored) if (validEntry(value) && !all.has(value.clientId)) all.set(value.clientId, value);
    const now = this.deps.now();
    const live: OutboxEntry[] = [];
    for (const entry of all.values()) {
      if (now - entry.at > OUTBOX_MAX_AGE_MS) await this.remove(entry.clientId);
      else live.push(entry);
    }
    return live.sort((a, b) => a.at - b.at);
  }

  /** Uploads and files one entry (see the header); never two deliveries of the same entry at once. */
  async deliver(entry: OutboxEntry): Promise<Outcome> {
    if (this.busy.has(entry.clientId) || wordless(entry)) return { kind: 'held' };
    this.busy.add(entry.clientId);
    try {
      if (entry.send && !entry.reportId && this.deps.direct) {
        try {
          const sent = await this.deps.direct(entry);
          if (sent) { await this.remove(entry.clientId); return { kind: 'sent', report: sent }; }
        } catch (error) {
          if (!this.deps.online()) return { kind: 'held', error }; // no way out now: it waits here and goes later
        } // refused or no connection from here while the PC is there: the PC tries
      }
      if (!this.deps.online()) return { kind: 'held' };
      let report: ReportLine | undefined;
      let id = entry.reportId;
      if (!id) {
        let created: FeedbackReport;
        try {
          created = await this.create(this.params(entry, await this.files(entry)));
        } catch (error) {
          if (!refusedForGood(error, this.deps.online())) return { kind: 'held', error };
          await this.remove(entry.clientId);
          return { kind: 'refused', error };
        }
        report = created;
        id = created.id;
        if (!entry.send) { await this.remove(entry.clientId); return { kind: 'saved', report }; }
        await this.put({ ...entry, reportId: id });
      }
      try {
        const sent = await this.deps.send(id);
        await this.remove(entry.clientId);
        return { kind: sent.status === 'sent' ? 'sent' : 'saved', report: sent };
      } catch (error) {
        if (!this.deps.online()) return { kind: 'held', error }; // the link went away: the answer never came
        await this.remove(entry.clientId); // the PC answered: it holds the report (Settings › Feedback, Send again)
        return { kind: 'saved', report: report ?? { id, status: 'local' }, error };
      }
    } finally {
      this.busy.delete(entry.clientId);
    }
  }

  /** Delivers the waiting entries, oldest first; the first held one ends the round (the PC is still away). */
  flush(onOutcome: (outcome: Outcome, entry: OutboxEntry) => void): Promise<void> {
    this.flushing ??= (async () => {
      try {
        for (const entry of await this.pending()) {
          if (this.busy.has(entry.clientId) || wordless(entry)) continue; // on its way already (the form's own Send), or held for words
          const outcome = await this.deliver(entry);
          if (outcome.kind === 'held') return;
          onOutcome(outcome, entry);
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** A held wordless entry (an older build's recording-only report), taken out of the outbox to go back into the form. */
  async takeWordless(): Promise<OutboxEntry | undefined> {
    const entry = (await this.pending()).find(wordless);
    if (entry) await this.remove(entry.clientId);
    return entry;
  }

  async remove(clientId: string): Promise<void> {
    this.memory.delete(clientId);
    await this.serial(() => this.deps.kv?.remove(ENTRY_PREFIX + clientId));
  }

  // ---------------------------------------------------------------- the kept draft

  saveDraft(draft: FeedbackDraft): Promise<void> {
    return this.serial(() => (isEmptyDraft(draft) ? this.deps.kv?.remove(DRAFT_KEY) : this.deps.kv?.set(DRAFT_KEY, { at: this.deps.now(), draft })));
  }

  async loadDraft(): Promise<FeedbackDraft | undefined> {
    const value = await this.serial(() => this.deps.kv?.get(DRAFT_KEY)) as { at?: unknown; draft?: Partial<FeedbackDraft> } | undefined;
    const draft = value?.draft;
    if (!draft || typeof value.at !== 'number' || this.deps.now() - value.at > OUTBOX_MAX_AGE_MS || typeof draft.text !== 'string') return undefined;
    const { audio: _recordings, withAudio: _box, painted: _flat, ...words } = draft as Partial<FeedbackDraft> & { audio?: unknown; withAudio?: unknown; painted?: unknown }; // an older draft's recordings stay behind
    const kept: FeedbackDraft = {
      ...EMPTY_DRAFT, ...words, marks: penMarks(draft.marks),
      photos: Array.isArray(draft.photos) ? draft.photos.map((photo) => ({ ...photo, marks: penMarks(photo.marks) })) : [],
    };
    return isEmptyDraft(kept) ? undefined : kept;
  }

  // ---------------------------------------------------------------- internals

  /** feedback.create's params: no kind (the person's report has none, feedback 16.11.2026). */
  private params(entry: OutboxEntry, files: CreateFiles): CreateParams {
    return {
      text: entry.text, clientId: entry.clientId, client: entry.client, ...files,
      ...(entry.where.view ? { view: entry.where.view } : {}),
      ...(entry.where.conversationId ? { conversationId: entry.where.conversationId } : {}),
      ...(entry.clientDiagnostics ? { clientDiagnostics: entry.clientDiagnostics } : {}),
      ...(entry.dictated ? { dictated: true } : {}),
    };
  }

  /**
   * feedback.create. Bridge 20.11.2026: a PC of an older build refuses the new `dictated` param – the report goes again
   * without it (its words are the same).
   */
  private async create(params: CreateParams): Promise<FeedbackReport> {
    try {
      return await this.deps.create(params);
    } catch (error) {
      if (!params.dictated || !(error instanceof RpcError) || error.code !== 'bad_request' || !error.message.includes('"params.dictated"')) throw error;
      const { dictated: _older, ...without } = params;
      return this.deps.create(without);
    }
  }

  /** Uploaded again on every try: a file of an earlier try may be gone. */
  private async files(entry: OutboxEntry): Promise<CreateFiles> {
    const images = entryImages(entry);
    if (!images.length) return {};
    const imageFileIds: string[] = [];
    for (const image of images) imageFileIds.push(await this.deps.upload(dataUrlToBlob(image), REPORT_IMAGE_NAME)); // one after another: the phone's link is narrow
    return { imageFileIds };
  }

  /** Storage calls one after another; storage trouble keeps nothing there and never fails a report. */
  private serial<T>(task: () => Promise<T> | T | undefined): Promise<T | undefined> {
    const run = this.queue.then(task, task).then((value) => value, () => undefined);
    this.queue = run;
    return run;
  }
}

/** What the runtime adds to a window's own send – undefined when it is not there or not quick (the report never waits for it). */
export async function runtimeContext(text: string, call: (text: string) => Promise<FeedbackContext>, waitMs: number = CONTEXT_WAIT_MS): Promise<FeedbackContext | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(text).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** This page's IndexedDB as the store underneath. */
const pageStorage: KeyValue = {
  get: (key) => idbGet(key),
  set: (key, value) => idbSet(key, value),
  remove: (key) => idbDelete(key),
  values: async (prefix) => {
    const out: unknown[] = [];
    await idbSweep(prefix, (value) => { out.push(value); return false; }); // a read: nothing is deleted
    return out;
  },
};

const online = (): boolean => rpc.status.peek() === 'open';

/** This page's outbox. */
export const feedbackOutbox = new FeedbackOutbox({
  kv: typeof indexedDB === 'undefined' ? null : pageStorage,
  create: (params) => rpc.call('feedback.create', params),
  send: (id) => rpc.call('feedback.send', { id }),
  // Every page sends itself (owner 24.11.2026); the window asks its runtime for its part, quickly and only while the link is open.
  direct: async (entry: OutboxEntry) => {
    const context = bridge && online() ? await runtimeContext(entry.text, (text) => rpc.call('feedback.context', { text })) : undefined;
    return sendDirect(entry, builtInReceiver(), fetch, context);
  },
  upload: async (blob, name) => (await uploadRef(blob, name)).id,
  online,
  now: () => Date.now(),
});

/** What the person learns of a report delivered while the form was not watching (the status line). */
export function announce(outcome: Outcome, entry?: OutboxEntry): void {
  if (outcome.kind === 'sent') { announceSent(outcome.report); return; }
  if (outcome.kind === 'saved') { pushToast({ title: 'Feedback saved on your PC', body: outcome.error === undefined ? undefined : notSentLine(outcome.error) }); return; }
  if (outcome.kind === 'refused') {
    if (entry && isEmptyDraft(feedbackDraft.peek())) feedbackDraft.value = draftOf(entry);
    pushToast({ title: 'Feedback was not accepted', body: `${errorText(outcome.error)} It is back in the feedback form.`, tone: 'error' });
  }
}

/** Delivers what waits in this page now (the next connect does it again). */
export function flushFeedback(): Promise<void> {
  return feedbackOutbox.flush(announce);
}

let restored: Promise<void> | null = null;

/**
 * Installed once by the feedback menu's host (the shell and the "only My day" screen): restores a kept draft into an
 * empty one, keeps the draft from then on, and flushes the waiting reports now and after every (re)connect. Resolves
 * once the kept draft is back (what joins the draft – a crash report – waits for it, so it is never written over).
 */
export function startFeedbackOutbox(): Promise<void> {
  if (restored) return restored;
  restored = (async () => {
    const kept = await feedbackOutbox.loadDraft();
    if (kept && isEmptyDraft(feedbackDraft.peek())) feedbackDraft.value = kept;
    if (isEmptyDraft(feedbackDraft.peek())) { // an older recording-only report comes back to be said in words
      const held = await feedbackOutbox.takeWordless();
      if (held) feedbackDraft.value = draftOf(held);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const draft = feedbackDraft.value;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void feedbackOutbox.saveDraft(draft); }, DRAFT_SAVE_MS);
    });
  })();
  rpc.onOpen(() => { void flushFeedback(); });
  if (typeof window !== 'undefined') window.addEventListener('online', () => { void flushFeedback(); });
  if (typeof setInterval === 'function') setInterval(() => { void flushFeedback(); }, FLUSH_EVERY_MS);
  void flushFeedback();
  return restored;
}
