// Covering for feedback.report (owner 21.11.2026: "die KI macht Kästen") where no media analyzer runs (headless): the
// agent's blocks – fractions 0..1 of the image – painted on a PNG decoded here through computer/png.ts, solid black at
// the image's own pixels (rounded outwards), then scaled down and encoded until it fits its byte share.
// Owns: the headless PNG covering. Never: reads files, stores anything, or lets an image through whose blocks it could
// not paint (the caller then does not send it).

import type { ImageRegion, NormalizedImage } from '../../../shared/api/host-bridge.ts';
import { IMAGE_LIMITS } from '../../../shared/api/host-bridge.ts';
import { decodePng, downscale, encodePng, pngSize, type RawImage } from '../../computer/png.ts';
import { fitWithin } from '../../computer/geometry.ts';

/** The largest PNG covered here (pixels; about 64 MB decoded). */
export const HEADLESS_PIXELS = 16_000_000;
/** The shortest longest edge a sized image gets before it counts as too large for its share. */
export const MIN_EDGE = 200;
const TRIES = 6;

/** Paints the fractions solid black (alpha opaque) into `image`, rounded outwards to whole pixels. */
export function fillBlack(image: RawImage, cover: readonly ImageRegion[]): void {
  const ch = image.channels;
  for (const c of cover) {
    const x0 = Math.max(0, Math.floor(c.x * image.width));
    const y0 = Math.max(0, Math.floor(c.y * image.height));
    const x1 = Math.min(image.width, Math.ceil((c.x + c.w) * image.width));
    const y1 = Math.min(image.height, Math.ceil((c.y + c.h) * image.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const at = (y * image.width + x) * ch;
        image.pixels[at] = 0;
        image.pixels[at + 1] = 0;
        image.pixels[at + 2] = 0;
        if (ch === 4) image.pixels[at + 3] = 255;
      }
    }
  }
}

/**
 * Headless: a PNG covered here, at most IMAGE_LIMITS.maxPx on its longest edge and `maxBytes` long (smaller each try);
 * undefined when computer/png.ts cannot read it, it is too large to decode here, or no size down to MIN_EDGE fits.
 */
export function coveredPng(data: Uint8Array, cover: readonly ImageRegion[], maxBytes: number): NormalizedImage | undefined {
  const size = pngSize(data);
  if (!size || size.width * size.height > HEADLESS_PIXELS) return undefined;
  const raw = decodePng(data);
  if (!raw) return undefined;
  fillBlack(raw, cover); // before scaling: no covered pixel is averaged into what stays
  let edge = Math.min(IMAGE_LIMITS.maxPx, Math.max(raw.width, raw.height));
  for (let attempt = 0; attempt < TRIES && (attempt === 0 || edge >= MIN_EDGE); attempt++) {
    const fit = fitWithin(raw.width, raw.height, edge);
    const small = fit.width === raw.width && fit.height === raw.height ? raw : downscale(raw, fit.width, fit.height);
    const encoded = encodePng(small);
    if (encoded.length <= maxBytes) return { data: encoded, mime: 'image/png', width: small.width, height: small.height };
    edge = smallerEdge(Math.max(small.width, small.height), encoded.length, maxBytes);
  }
  return undefined;
}

/** The next edge for an image of `bytes` at `edge` that must fit `maxBytes` (bytes grow with the pixels). */
export function smallerEdge(edge: number, bytes: number, maxBytes: number): number {
  return Math.min(edge - 1, Math.floor(edge * Math.sqrt(maxBytes / bytes) * 0.9));
}
