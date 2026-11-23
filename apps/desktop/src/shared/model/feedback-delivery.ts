// Owns: what a client may know about feedback delivery – whether this build can send (`feedback.status`), the team
// inbox on the PCs that hold the team's private key (B-055 Q1–Q3), `wf feedback setup`'s answer, the short
// report number both sides show (B-085) and the bounds of what a writing device adds (16.11.2026: client facts, its
// own diagnostics). Owner 20.11.2026: a report is its words – a dictation goes as its transcript, never as a recording.
// Owner 21.11.2026: a report carries several images (the window shot, photos, an agent's screen) – one name: `images`.
// Never: keys, the service account, the sealed bytes or any read API of the mailbox (it is write-only).
import type { FeedbackKind } from './system.ts';

/**
 * The short report number of a delivered report: the first 8 letters and digits of its receipt (the mailbox
 * document id, a UUID – the team inbox item's `id`), in capitals. Empty without a receipt.
 */
export function reportNumber(receiptId: string | undefined): string {
  return (receiptId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
}

/** The team inbox's folder in a company's data dir: <id>.json per report, its images beside it (runtime/feedback/inbox.ts). */
export const INBOX_DIR = 'feedback-inbox';

/** The largest sealed envelope sent to the mailbox (its Firestore rule allows < 1,000,000 bytes). */
export const FEEDBACK_SEALED_LIMIT = 950_000;
/** An older build's `deliveryWarning`: its sealed report went without its screenshot (read only; nothing new drops an image). */
export const SCREENSHOT_DROPPED = 'The screenshot was too large and was not sent.';
/** Images one report carries at most. */
export const FEEDBACK_IMAGES_MAX = 6;
/**
 * The raw bytes all images of one report share (base64 makes them 4/3 larger inside the sealed letter, which stays under
 * FEEDBACK_SEALED_LIMIT): whoever prepares them (the form, the agent's tool) sizes each to `imageBudget(count)`.
 */
export const FEEDBACK_IMAGE_BUDGET = 600_000;
/** One image's share of FEEDBACK_IMAGE_BUDGET when a report carries `count` images. */
export function imageBudget(count: number): number {
  return Math.floor(FEEDBACK_IMAGE_BUDGET / Math.min(FEEDBACK_IMAGES_MAX, Math.max(1, count)));
}
/** Image types a report may carry (never SVG or anything a browser would run). */
export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type FeedbackImageType = typeof FEEDBACK_IMAGE_TYPES[number];
/** A stored report's image files beside its JSON in INBOX_DIR: <id>.<ext>, <id>.2.<ext>, … (inboxImageFile). */
export const FEEDBACK_IMAGE_EXT: Record<FeedbackImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/**
 * The file name of image `index` (0-based) of team inbox report `id`: <id>.<ext> for the first, <id>.<index + 1>.<ext> after
 * it. A report id has no "." (drop.ts DOCUMENT_ID), so every file of a report starts with "<id>." and no other's does.
 */
export function inboxImageFile(id: string, index: number, mime: FeedbackImageType): string {
  return `${id}${index ? `.${index + 1}` : ''}.${FEEDBACK_IMAGE_EXT[mime]}`;
}
/** feedback.create `client`: where the report was written ("Android app 0.3.15 · Android 16 · SM-S918B · 412×915"), kept to this length. */
export const FEEDBACK_CLIENT_MAX = 400;
/** feedback.create `clientDiagnostics`: the writing device's own diagnostics (an Android crash report), kept to this length. */
export const FEEDBACK_CLIENT_DIAGNOSTICS_MAX = 12_000;
/** feedback.create `clientId`: the writing device's own id for the report – the same id returns the stored report. */
export const FEEDBACK_CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `feedback.status`: `sending` – this build has a receiver (resources/feedback/receiver.json: the team's public key
 * and the mailbox); without one a report is only saved on this PC and the UI says so. `receiving` – this PC holds the
 * team's private key (the vault), so Settings › Feedback shows the team inbox; always false for anyone but the owner.
 */
export interface FeedbackStatus {
  sending: boolean;
  receiving: boolean;
}

/** One report from the team inbox (<data>/feedback-inbox/<id>.json), opened on this PC. Untrusted text. */
export interface FeedbackInboxItem {
  id: string;
  /** When this PC fetched it. */
  receivedAt: number;
  /** When the sender wrote it (the sender's clock). */
  createdAt: number;
  kind?: FeedbackKind;
  text: string;
  appVersion: string;
  os: string;
  view?: string;
  /** Filed by one of the sender's agents (unverified), not by the person. */
  fromAgent?: boolean;
  /** 16.11.2026: where it was written ("Android app 0.3.15 · Android 16 · SM-S918B · 412×915"); absent from older senders. */
  client?: string;
  /** The sending company's data folder on its PC ('first', 'company-2'): two same-named companies told apart. */
  company?: string;
  /** The text was dictated – it is the transcript (read it for what was meant). */
  dictated?: boolean;
  diagnostics?: string;
  /** The writing device's own diagnostics (an Android crash report), apart from the person's words. */
  clientDiagnostics?: string;
  /** The report's images in order (files: inboxImageFile); an item stored by an older build has its `screenshot` read as the first. */
  images?: { mime: FeedbackImageType; size: number }[];
  /** Feedback 16.11.2026: marked by the team – done (built) or not relevant; removed FEEDBACK_HANDLED_KEEP_MS after `at`. */
  handled?: { as: FeedbackHandled; at: number };
}

/** How the team closed a report in its inbox. */
export type FeedbackHandled = 'done' | 'irrelevant';
/** A marked report stays this long on the team's PC, then goes by itself (owner 16.11.2026: "nach ein paar Tagen"). */
export const FEEDBACK_HANDLED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** What one fetch did: `added` new reports, `unreadable` letters this PC's key cannot open or no sender of ours made. */
export interface FeedbackInboxFetch {
  added: number;
  unreadable: number;
  /** More letters wait than one fetch takes (fetch again). */
  more: boolean;
  /** Reports in this PC's inbox after the fetch. */
  total: number;
}

/** `feedback.setup` (wf feedback setup): what was stored and what the owner does next. */
export interface FeedbackSetupResult {
  publicKey: string;
  project: string;
  /** A new key pair was made (first setup or --rotate); false: the vault's key was kept. */
  createdKey: boolean;
  /** Where receiver.json was written; absent when the app runs from a package (write it into the source tree). */
  receiverFile?: string;
  /** receiver.json's content (public: the team's public key, the project and its web API key). */
  receiver: { publicKey: string; project: string; apiKey: string };
  /** The Firestore rules to paste (resources/feedback/firestore.rules). */
  rules: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** 'chat' devices too (they may create and send reports): whether sending is set up in this build. */
    'feedback.status': { params: void; result: FeedbackStatus };
    // B-055, owner only: the team inbox on the PC holding the team's private key.
    'feedback.inboxList': { params: void; result: FeedbackInboxItem[] };
    /** Fetches the mailbox now (opened and stored on this PC; the letter stays for the team's other PCs and companies). */
    'feedback.inboxFetch': { params: void; result: FeedbackInboxFetch };
    /** Deletes the report on this PC and its letter in the mailbox (it does not come back). */
    'feedback.inboxRemove': { params: { id: string }; result: { ok: true } };
    /** Marks a stored report done or not relevant (null clears it); a marked one is removed 7 days later. */
    'feedback.inboxMark': { params: { id: string; as: FeedbackHandled | null }; result: FeedbackInboxItem };
    /** Image `index` (0-based) of a stored report. */
    'feedback.inboxImage': { params: { id: string; index: number }; result: { mime: FeedbackImageType; dataBase64: string } };
    /** wf feedback setup: keys into the vault, receiver.json, the rules to paste. */
    'feedback.setup': { params: { project: string; apiKey: string; serviceAccountPath: string; rotate?: boolean }; result: FeedbackSetupResult };
  }
}
