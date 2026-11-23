// One opened team letter as an inbox item (B-055 Q2; split from inbox.ts 16.11.2026): a letter is untrusted input,
// so every field is checked and bounded again, each image must be what its type says (magic bytes), and whatever
// does not fit is dropped – never the whole report for a bad attachment. Owner 21.11.2026: a letter carries `images`
// (at most FEEDBACK_IMAGES_MAX are read); an older sender's one `screenshot` is read as its one image.
// 16.11.2026: also where it was written (`client`), the sending company's folder (`company`), the writing device's own
// diagnostics and whether the text was dictated. Owner 20.11.2026: a report is its words – a recording an older sender
// put into its letter is not read.
// Owns: that check. Never: reads or writes files, opens a letter.

import type { FeedbackKind } from '../../shared/model/system.ts';
import {
  FEEDBACK_CLIENT_DIAGNOSTICS_MAX, FEEDBACK_CLIENT_MAX, FEEDBACK_IMAGE_TYPES, FEEDBACK_IMAGES_MAX, type FeedbackImageType, type FeedbackInboxItem,
} from '../../shared/model/feedback-delivery.ts';

const KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];

/** The image really is what its type says. */
export function imageMatches(mime: FeedbackImageType, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

const str = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined);

/** One image of a letter: a known type whose bytes are what it says; undefined otherwise. */
function imageOf(value: unknown): { mime: FeedbackImageType; bytes: Buffer } | undefined {
  const image = value as { mime?: unknown; base64?: unknown } | null | undefined;
  if (!image || !(FEEDBACK_IMAGE_TYPES as readonly unknown[]).includes(image.mime) || typeof image.base64 !== 'string') return undefined;
  const bytes = Buffer.from(image.base64, 'base64');
  return bytes.length && imageMatches(image.mime as FeedbackImageType, bytes) ? { mime: image.mime as FeedbackImageType, bytes } : undefined;
}

/** An opened letter as an inbox item, its images apart (same order as `item.images`); undefined when it is no v1 report. */
export function itemOf(id: string, value: unknown, receivedAt: number): { item: FeedbackInboxItem; images: Buffer[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const text = str(o.text, 20_000);
  if (o.v !== 1 || !text) return undefined;
  const item: FeedbackInboxItem = {
    id, receivedAt, text,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : receivedAt,
    appVersion: str(o.appVersion, 120) ?? '', os: str(o.os, 120) ?? '',
  };
  if (KINDS.includes(o.kind as FeedbackKind)) item.kind = o.kind as FeedbackKind;
  const view = str(o.view, 120);
  if (view) item.view = view;
  if (o.fromAgent === true) item.fromAgent = true;
  const client = str(o.client, FEEDBACK_CLIENT_MAX)?.replace(/\s+/g, ' ');
  if (client) item.client = client;
  const company = str(o.company, 64);
  if (company && /^[a-z0-9][a-z0-9-]*$/.test(company)) item.company = company;
  if (o.dictated === true) item.dictated = true;
  const diagnostics = str(o.diagnostics, 12_000);
  if (diagnostics) item.diagnostics = diagnostics;
  const clientDiagnostics = str(o.clientDiagnostics, FEEDBACK_CLIENT_DIAGNOSTICS_MAX);
  if (clientDiagnostics) item.clientDiagnostics = clientDiagnostics;
  const sent = Array.isArray(o.images) ? o.images.slice(0, FEEDBACK_IMAGES_MAX) : [o.screenshot];
  const images = sent.map(imageOf).filter((image) => image !== undefined);
  if (images.length) item.images = images.map(({ mime, bytes }) => ({ mime, size: bytes.length }));
  return { item, images: images.map(({ bytes }) => bytes) };
}
