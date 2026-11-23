// The images of an agent's feedback report (owner 21.11.2026), in order: the current screen of this PC (`screen`: taken
// the way computer.screenshot takes it – the registered tool's own run, so the agent's screenshot geometry, the activity
// pill and the capture path are that tool's), stored images by file id (a blob path or a media: reference too; only media
// the agent may read, media-common.ts readableMedia) and image files by path (files.ts readPath – the security gate
// judged the `paths` argument as a read). Each one's covering blocks are fractions 0..1 of that image (review 21.11.2026:
// the size an agent sees an image at differs by engine, and a photo's EXIF rotation by decoder) – painted on the decoded,
// rotated image; a block reaching past its image refuses the call before anything is taken. Each image is covered and sized to its share of the letter (feedback-delivery.ts imageBudget) by the host's
// media analyzer (media.image with `cover` and `maxBytes`), headless a PNG here (feedback-cover.ts), and stored as a
// file of its own; the originals of the screen and of paths are queued for clean-up (files/cleanup.ts).
// Owns: gathering, covering, sizing and storing those images, and the line why one does not go. Never: sends an image
// whose blocks were not painted, an image over its share, or one the agent could not read itself.

import { stat } from 'node:fs/promises';
import { IMAGE_LIMITS, type ImageRegion, type NormalizedImage } from '../../../shared/api/host-bridge.ts';
import { FEEDBACK_IMAGE_EXT, FEEDBACK_IMAGE_TYPES, imageBudget, type FeedbackImageType } from '../../../shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { ToolContext } from '../types.ts';
import { detectMime } from '../../files/mime.ts';
import { reclaimerOf } from '../../files/cleanup.ts';
import { storedId } from '../../media/outputs.ts';
import { readPath } from './files.ts';
import { readableMedia } from './media-common.ts';
import { coveredPng, MIN_EDGE, smallerEdge } from './feedback-cover.ts';

/** The name a block gives for the current screen. */
export const SCREEN = 'screen';
const SCREEN_TOOL = 'computer.screenshot';
const TRIES = 4;

/** One block as the agent gives it: the image it covers by name and its rectangle as fractions 0..1 of that image. */
export interface CoverBlock { image: string; x: number; y: number; width: number; height: number }

/** What the agent asked to send: the screen, stored images, image files and the blocks per image name. */
export interface ImageAsk { screen?: boolean; fileIds?: string[]; paths?: string[]; cover?: CoverBlock[] }

/** The stored images that go (in order) and a line for each one that does not. */
export interface ImagesReady { ids: string[]; dropped: string[] }

/** One image as found: its stored original and its type. */
interface Source { fileId: string; mime: string; temporary: boolean }

type Kind = 'screen' | 'file' | 'path';

/** The asked images in order: the screen, then the file ids, then the paths – each by the name its blocks use. */
export function askedImages(ask: ImageAsk): Array<{ name: string; kind: Kind }> {
  return [
    ...(ask.screen ? [{ name: SCREEN, kind: 'screen' as const }] : []),
    ...(ask.fileIds ?? []).map((name) => ({ name, kind: 'file' as const })),
    ...(ask.paths ?? []).map((name) => ({ name, kind: 'path' as const })),
  ];
}

/** Why the blocks cannot be painted as given ('' when they can): one names an image that is not sent, or reaches past its image. */
export function blockRefusal(ask: ImageAsk): string {
  const names = new Set(askedImages(ask).map((image) => image.name));
  for (const block of ask.cover ?? []) {
    if (!names.has(block.image)) return `A block names "${block.image}", which is not among the images I send: its image is "screen", or a fileId or path exactly as I passed it.`;
    const inside = [block.x, block.y, block.width, block.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      && block.width > 0 && block.height > 0 && block.x + block.width <= 1 + 1e-9 && block.y + block.height <= 1 + 1e-9;
    if (!inside) return `The block at ${block.x},${block.y} (${block.width}×${block.height}) on "${block.image}" reaches past its image: x, y, width and height are fractions 0..1 of the image, x + width and y + height at most 1.`;
  }
  return '';
}

/** The blocks of one image as the host's regions (fractions, clipped to 1 against rounding). */
const regionsOf = (blocks: readonly CoverBlock[]): ImageRegion[] => blocks.map((block) => ({ x: block.x, y: block.y, w: Math.min(block.width, 1 - block.x), h: Math.min(block.height, 1 - block.y) }));

/** Gathers, covers, sizes and stores every asked image; one that cannot go is left out with its line. */
export async function prepareImages(ctx: ToolContext, ask: ImageAsk): Promise<ImagesReady> {
  const asked = askedImages(ask);
  const share = imageBudget(asked.length);
  const ready: ImagesReady = { ids: [], dropped: [] };
  for (const [index, { name, kind }] of asked.entries()) {
    const shown = kind === 'screen' ? 'The screen' : `"${name}"`;
    let source: Source | undefined;
    try {
      source = await sourceOf(ctx, name, kind);
      const cover = regionsOf((ask.cover ?? []).filter((block) => block.image === name));
      const image = await sized(ctx.services, source, cover, share);
      const type = image.mime as FeedbackImageType;
      const ref = await ctx.services.files.put(image.data, `feedback-${index + 1}.${FEEDBACK_IMAGE_EXT[type]}`, image.mime);
      ready.ids.push(ref.id);
    } catch (error) {
      ready.dropped.push(`${shown} is not sent: ${reason(error)}.`);
    } finally {
      if (source?.temporary) reclaimerOf(ctx.services.files)?.reclaim([source.fileId]);
    }
  }
  return ready;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : 'it could not be read').replace(/[.\s]+$/, '');

async function sourceOf(ctx: ToolContext, name: string, kind: Kind): Promise<Source> {
  if (kind === 'screen') return screen(ctx);
  const stored = kind === 'file' ? name : storedId(ctx.services.paths, name);
  if (stored) {
    const found = readableMedia(ctx, stored, 'send');
    if ('refused' in found) throw new WorkforceError('forbidden', textOf(found.refused.content));
    const { info } = found;
    if (info.kind !== 'image') throw new WorkforceError('bad_request', 'it is no image');
    return { fileId: info.fileId, mime: info.mime, temporary: false };
  }
  const real = await readPath(ctx, name);
  if (!(await stat(real).catch(() => undefined))?.isFile()) throw new WorkforceError('not_found', 'there is no file at this path');
  const ref = await ctx.services.files.putPath(real);
  if (!ref.mime.startsWith('image/')) {
    reclaimerOf(ctx.services.files)?.reclaim([ref.id]);
    throw new WorkforceError('bad_request', 'this file is no image');
  }
  return { fileId: ref.id, mime: ref.mime, temporary: true };
}

/** The current screen – as it is now – through computer.screenshot's own run, stored. */
async function screen(ctx: ToolContext): Promise<Source> {
  const tool = ctx.services.tools.get(SCREEN_TOOL);
  if (!tool) throw new WorkforceError('unavailable', 'this PC offers no screen here');
  const output = await tool.run({}, ctx);
  const image = output.content.find((part) => part.type === 'image');
  if (output.isError || !image || image.type !== 'image') throw new WorkforceError('unavailable', textOf(output.content) || 'the screen could not be taken');
  const data = new Uint8Array(Buffer.from(image.dataBase64, 'base64'));
  const mime = detectMime(data.subarray(0, 64), '', image.mime);
  if (!mime.startsWith('image/')) throw new WorkforceError('unavailable', 'the screen image cannot be read');
  const ref = await ctx.services.files.put(data, `screen.${mime === 'image/png' ? 'png' : 'jpg'}`, mime);
  return { fileId: ref.id, mime, temporary: true };
}

const textOf = (content: ReadonlyArray<{ type: string; text?: string }>): string => content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ').trim();

/**
 * The covered image within `share` bytes: the host's media analyzer (smaller each try), headless – or where the
 * analyzer cannot read it – a PNG here; without blocks a PNG, JPEG or WebP within its share goes as it is.
 */
async function sized(s: RuntimeServices, source: Source, cover: ImageRegion[], share: number): Promise<NormalizedImage | { data: Uint8Array; mime: string }> {
  const host = s.host?.media?.image;
  let failed: unknown;
  if (host) {
    let edge: number = IMAGE_LIMITS.maxPx;
    try {
      for (let attempt = 0; attempt < TRIES && edge >= MIN_EDGE; attempt++) {
        const image = await host({ fileId: source.fileId, mime: source.mime, maxPx: edge, maxBytes: Math.min(share, IMAGE_LIMITS.maxBytes), ...(cover.length ? { cover } : {}) });
        if (image.data.length <= share) return image;
        edge = smallerEdge(Math.max(image.width, image.height), image.data.length, share);
      }
      failed = new WorkforceError('bad_request', 'it does not fit its share of the report even small');
    } catch (error) { failed = error; }
  }
  const bytes = await s.files.read(source.fileId);
  if (source.mime === 'image/png') {
    const png = coveredPng(bytes, cover, share);
    if (png) return png;
  } else if (!cover.length && (FEEDBACK_IMAGE_TYPES as readonly string[]).includes(source.mime) && bytes.length <= share) {
    return { data: bytes, mime: source.mime };
  }
  if (failed) throw failed;
  throw new WorkforceError('unavailable', cover.length
    ? 'its blocks cannot be painted here (this runtime has no media analyzer, and only a PNG is covered without one)'
    : 'it cannot be made small enough here (this runtime has no media analyzer)');
}
