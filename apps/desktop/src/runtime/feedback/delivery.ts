// Sending one report (B-055 Q1/Q2): its facts and its images (owner 21.11.2026: several, `images`) become one JSON payload, sealed on this PC for the team's public key (seal.ts) and dropped into the write-only mailbox
// (drop.ts). Everything is private now: the old public GitHub path is gone and `visibility` is ignored.
// The outbox (kv `feedback-submissions`) holds only the sealed envelope, its request id and where it goes – never the
// text or an image – and is written before any network I/O, so a retry after a lost answer
// sends the identical letter under the same id. After delivery only the receipt stays (the envelope is dropped). A
// letter the mailbox refused carries `refused` until a later try goes otherwise (the automatic resend leaves it).
// Owner 20.11.2026: a report is its words – a dictated report goes as its transcript (`dictated`), never with a recording.
// Owns: the complete payload, its size budget, the outbox and the report's delivered state.
// Never: drops an attached image, sends plaintext, resends an older (GitHub or receiver) submission,
// or claims delivery before the mailbox answered.

import { randomUUID } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import type { FeedbackKind, FeedbackReport } from '../../shared/model/system.ts';
import {
  FEEDBACK_CLIENT_DIAGNOSTICS_MAX, FEEDBACK_CLIENT_MAX, FEEDBACK_IMAGE_TYPES, FEEDBACK_SEALED_LIMIT, SCREENSHOT_DROPPED, type FeedbackImageType,
} from '../../shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { redactText } from '../../shared/secrets/redact-text.ts';
import { sealReport } from './seal.ts';
import { dropSealed, NOT_SET_UP } from './drop.ts';
import type { ReceiverConfig } from './receiver.ts';

export const OUTBOX = 'feedback-submissions';
/** What the team opens (letter.ts checks it again – a letter is untrusted input). */
export interface FeedbackPayload {
  v: 1;
  id: string;
  createdAt: number;
  kind?: FeedbackKind;
  text: string;
  appVersion: string;
  os: string;
  view?: string;
  /** Filed by an agent of the sender (unverified). */
  fromAgent?: true;
  /** Where the person wrote it (the writing page's facts, redacted). */
  client?: string;
  /** The sending company's data folder ('first', 'company-2'). */
  company?: string;
  /** The report's images in order (owner 21.11.2026); an older sender's letter has one `screenshot` instead (letter.ts). */
  images?: { mime: FeedbackImageType; base64: string }[];
  diagnostics?: string;
  /** The writing device's own diagnostics (an Android crash report), redacted. */
  clientDiagnostics?: string;
  /** The text was dictated: it is the transcript. */
  dictated?: true;
}

/** One outbox entry: ciphertext and routing only. `sealed` is gone once `deliveredAt` is set. */
export interface OutboxEntry {
  v: 1;
  requestId: string;
  project: string;
  recipient: string;
  sealed?: string;
  /** An older build's note on what its letter went without (SCREENSHOT_DROPPED; a recording it left behind). */
  warning?: string;
  deliveredAt?: number;
  /** The mailbox refused the last try (drop.ts reason 'refused'): no automatic resend. */
  refused?: true;
  /** Sealed as words only (20.11.2026). An undelivered letter without it was sealed by an older build and may carry a recording: it is sealed again. */
  words?: true;
}

/** A sealed letter still to go that the automatic resend may try again (not refused, not delivered). */
export function resendable(entry: OutboxEntry | undefined): boolean {
  return entry?.v === 1 && Boolean(entry.sealed) && !entry.deliveredAt && !entry.refused;
}

const OLDER = 'This older submission cannot be sent again. Its original delivery stands.';
const IMAGES_TOO_LARGE = 'The images are too large to send. Your complete report is saved on this PC; use fewer or smaller images.';

/** The report's images as the letter carries them; all of them together stay inside the sealed limit, else nothing goes. */
async function imagesOf(s: RuntimeServices, report: FeedbackReport): Promise<NonNullable<FeedbackPayload['images']>> {
  const images: NonNullable<FeedbackPayload['images']> = [];
  let total = 0;
  for (const imageId of report.imageFileIds ?? []) {
    const file = s.files.get(imageId);
    if (!file) throw new WorkforceError('not_found', 'An attached image was not found.');
    if (!(FEEDBACK_IMAGE_TYPES as readonly string[]).includes(file.mime)) throw new WorkforceError('bad_request', 'Attach PNG, JPEG or WebP images.');
    total += file.size;
    if (total * 4 / 3 > FEEDBACK_SEALED_LIMIT) throw new WorkforceError('bad_request', IMAGES_TOO_LARGE); // not even read
    images.push({ mime: file.mime as FeedbackImageType, base64: Buffer.from(await s.files.read(imageId)).toString('base64') });
  }
  return images;
}

/** The complete payload sealed for the receiver; one too large with its images keeps the report local. */
async function sealFor(s: RuntimeServices, report: FeedbackReport, requestId: string, diagnostics: string | undefined, config: ReceiverConfig): Promise<Buffer> {
  const clean = (value: string) => redactText(s.secrets.redact(value)); // the vault may know more values than at create
  const { context } = report;
  const payload: FeedbackPayload = {
    v: 1, id: requestId, createdAt: report.createdAt, ...(report.kind ? { kind: report.kind } : {}), text: clean(report.text),
    appVersion: clean(context.version).slice(0, 120), os: clean(context.os).slice(0, 120),
    ...(context.view ? { view: clean(context.view).slice(0, 120) } : {}),
    ...(report.author !== 'human' ? { fromAgent: true as const } : {}),
    ...(context.client ? { client: clean(context.client).slice(0, FEEDBACK_CLIENT_MAX) } : {}),
    ...(context.company ? { company: context.company } : {}),
    ...(diagnostics ? { diagnostics: clean(diagnostics).slice(0, 12_000) } : {}),
    ...(context.clientDiagnostics ? { clientDiagnostics: clean(context.clientDiagnostics).slice(0, FEEDBACK_CLIENT_DIAGNOSTICS_MAX) } : {}),
    ...(report.dictated ? { dictated: true as const } : {}),
  };
  const images = await imagesOf(s, report);
  if (images.length) payload.images = images;
  const bytes = sealReport(config.publicKey, Buffer.from(JSON.stringify(payload), 'utf8'));
  if (bytes.length > FEEDBACK_SEALED_LIMIT) throw new WorkforceError('bad_request', images.length ? IMAGES_TOO_LARGE : 'This report is too large to send.');
  return bytes;
}

/** Refuses older submissions (B-034 receiver, B-035 GitHub, B-036 plaintext outbox); strips an old plaintext payload. */
function refuseOlder(s: RuntimeServices, kv: KvRepo, report: FeedbackReport): OutboxEntry | undefined {
  if (kv.get('feedback-delivery', report.id) || kv.get('feedback-github', report.id)) throw new WorkforceError('conflict', OLDER);
  const stored = kv.get<OutboxEntry | { payload?: unknown; receipt?: { state?: string } }>(OUTBOX, report.id);
  if (stored && (stored as OutboxEntry).v !== 1) {
    const state = (stored as { receipt?: { state?: string } }).receipt?.state;
    kv.set(OUTBOX, report.id, { v: 0, older: true, ...(state ? { state } : {}) }, s.clock.now()); // no plaintext stays behind
    throw new WorkforceError('conflict', OLDER);
  }
  if (!stored && report.receiptId) throw new WorkforceError('conflict', OLDER);
  return stored as OutboxEntry | undefined;
}

/** Seals (once) and drops report `report`; returns it as sent. */
export async function deliver(s: RuntimeServices, report: FeedbackReport, diagnostics: string | undefined, config: ReceiverConfig | undefined,
  run?: typeof fetch): Promise<FeedbackReport> {
  const kv = new KvRepo(s.db);
  let entry = refuseOlder(s, kv, report);
  if (!config) throw new WorkforceError('unavailable', NOT_SET_UP, { details: { reason: 'not_set_up' } });
  if (!entry?.deliveredAt) {
    // An older build may already have uploaded its text-only envelope before losing the answer. A new id is
    // needed to include the screenshot; do not turn that earlier attempt into a successful complete delivery.
    if (entry?.warning === SCREENSHOT_DROPPED) throw new WorkforceError('conflict', 'This earlier submission omitted its screenshot. Create a new report to send the screenshot.');
    // A new receiver (another project or a rotated key) gets a new letter under the same id; an identical retry resends the same bytes.
    // An older build's letter (no `words`) may carry a recording: it is sealed again from the report, under the same id.
    if (!entry?.sealed || !entry.words || entry.project !== config.project || entry.recipient !== config.publicKey) {
      const requestId = entry?.requestId ?? randomUUID();
      const sealed = await sealFor(s, report, requestId, diagnostics, config);
      entry = { v: 1, requestId, project: config.project, recipient: config.publicKey, sealed: sealed.toString('base64'), words: true };
      kv.set(OUTBOX, report.id, entry, s.clock.now()); // before external I/O
    }
    // exp counts from the report's own time, so a retry sends the very same letter (a months-old report: without exp).
    try {
      await dropSealed(config, entry.requestId, Buffer.from(entry.sealed!, 'base64'), run, () => report.createdAt);
    } catch (error) {
      const refused = error instanceof WorkforceError && error.details?.reason === 'refused';
      if (refused !== Boolean(entry.refused)) {
        const { refused: _old, ...rest } = entry;
        kv.set(OUTBOX, report.id, refused ? { ...rest, refused: true } : rest, s.clock.now());
      }
      throw error;
    }
    const { refused: _refused, words: _words, ...receipt }: OutboxEntry = { ...entry, deliveredAt: s.clock.now() };
    delete receipt.sealed; // delivered: only the receipt stays (`words` mattered only while it waited)
    entry = receipt;
    kv.set(OUTBOX, report.id, entry, s.clock.now());
  }
  const sent: FeedbackReport = { ...report, status: 'sent', receiptId: entry.requestId, visibility: 'private', sentAt: entry.deliveredAt };
  delete sent.url;
  if (entry.warning) sent.deliveryWarning = entry.warning; else delete sent.deliveryWarning;
  return sent;
}
