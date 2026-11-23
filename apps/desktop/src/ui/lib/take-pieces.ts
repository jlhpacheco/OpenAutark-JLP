// B-082 (decision 7): a long take is cut into pieces while it is recorded, so each piece is heard while
// the person still speaks and after Stop only the last one is left. Cut: once a piece is PIECE_MIN_MS long, in the
// middle of the next pause of CUT_PAUSE_MS; at PIECE_MAX_MS without such a pause, in the middle of the quietest
// QUIET_WINDOW_MS of the last SEARCH_MS. Inside a piece every pause longer than LONG_PAUSE_MS is shortened to
// KEEP_PAUSE_MS (half kept at each edge, so a word's start or end is never cut): the hearing session counts silence.
// A pause is a run of blocks under an adaptive quiet level: three times the room's floor (falls at once, rises over
// FLOOR_RISE_MS), never above QUIET_MAX, and – once the take's voice is heard (VOICE_MIN) – never above half of its
// loudest recent block (falls over VOICE_FALL_MS) unless that is below 1.5 × the floor (steady noise alone stays a pause). STIMME 21.11.2026 ("another person's recording does not record
// properly"): without that ceiling quiet speech in a noisy room (speech RMS 0.008 over noise 0.004, measured: 60 s of
// dictation kept as 1 s) was all taken for one long pause and cut away. joinPieces joins the pieces' texts with one
// space and moves their marks along.
// Owns: these pure rules (16 kHz PCM16 mono bytes in, pieces out). Never: the microphone, uploads or text hearing.

import type { MarkedText, SpanMark, TextMarks } from '../../shared/voice/marks.ts';

export const PIECE_MIN_MS = 25_000;
export const CUT_PAUSE_MS = 600;
export const PIECE_MAX_MS = 90_000;
export const SEARCH_MS = 8_000;
export const QUIET_WINDOW_MS = 300;
export const LONG_PAUSE_MS = 1_200;
export const KEEP_PAUSE_MS = 600;
const BYTES_PER_MS = 32; // 16 kHz × 2 bytes
const FLOOR_RISE_MS = 10_000;
const QUIET_MIN = 0.003;
const QUIET_MAX = 0.012;
/** A take whose loudest recent block reaches this is heard speaking: its pauses lie below half of that. */
const VOICE_MIN = 0.006;
const VOICE_FALL_MS = 20_000;

/** A finished piece: its PCM16 chunks (long pauses shortened) and their length. */
export interface Piece { pcm: Uint8Array[]; ms: number }

interface Block { pcm: Uint8Array; ms: number; level: number; quiet: boolean }

/** RMS (0..1) of PCM16 LE bytes. */
export function pcmLevel(bytes: Uint8Array): number {
  const count = bytes.byteLength >> 1;
  if (!count) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  let sum = 0;
  for (let index = 0; index < count; index++) { const value = view.getInt16(index * 2, true) / 32768; sum += value * value; }
  return Math.sqrt(sum / count);
}

/** Cuts a running take into pieces; push() every encoded block, flush() at Stop. */
export class PieceCutter {
  private blocks: Block[] = [];
  private ms = 0;
  /** Quiet ms at the end of the current piece. */
  private run = 0;
  private floor = Infinity;
  /** The loudest recent block (falls over VOICE_FALL_MS). */
  private voice = 0;

  /** One block of 16 kHz PCM16; a finished piece when this block completed one. */
  push(pcm: Uint8Array): Piece | null {
    if (!pcm.byteLength) return null;
    const ms = pcm.byteLength / BYTES_PER_MS;
    const level = pcmLevel(pcm);
    const quiet = this.isQuiet(level, ms);
    this.blocks.push({ pcm, ms, level, quiet });
    this.ms += ms;
    this.run = quiet ? this.run + ms : 0;
    // A piece that is nothing but pause keeps only its last KEEP_PAUSE_MS (shorten() would cut it to that, too): a long
    // silence never fills a piece, so it never becomes a stream of silent pieces to upload and hear.
    if (quiet && this.blocks[0].quiet && this.run >= this.ms && this.ms > LONG_PAUSE_MS) this.trimPause();
    if (this.ms >= PIECE_MIN_MS && this.run >= CUT_PAUSE_MS) return this.cutAt(this.pauseMiddle());
    if (this.ms >= PIECE_MAX_MS) return this.cutAt(this.quietestMiddle());
    return null;
  }

  /** The rest of the take as the last piece; null when nothing is left. */
  flush(): Piece | null {
    const rest = this.blocks;
    this.blocks = [];
    this.ms = 0;
    this.run = 0;
    return rest.length ? shorten(rest) : null;
  }

  private trimPause(): void {
    let drop = 0;
    for (let left = this.ms; drop < this.blocks.length - 1 && left - this.blocks[drop].ms >= KEEP_PAUSE_MS; drop++) left -= this.blocks[drop].ms;
    this.blocks = this.blocks.slice(drop);
    this.ms = this.blocks.reduce((total, block) => total + block.ms, 0);
    this.run = this.ms;
  }

  private isQuiet(level: number, ms: number): boolean {
    if (level < this.floor) this.floor = level;
    else this.floor += (level - this.floor) * Math.min(1, ms / FLOOR_RISE_MS);
    this.voice = Math.max(level, this.voice * (1 - Math.min(1, ms / VOICE_FALL_MS)));
    // never below 1.5 × the floor: steady noise alone (its own "voice") still counts as pause and is trimmed
    const ceiling = this.voice >= VOICE_MIN ? Math.min(QUIET_MAX, Math.max(this.voice / 2, this.floor * 1.5)) : QUIET_MAX;
    return level <= Math.min(ceiling, Math.max(QUIET_MIN, this.floor * 3));
  }

  /** The index after CUT_PAUSE_MS / 2 of the pause the piece ends with. */
  private pauseMiddle(): number {
    let start = this.blocks.length;
    while (start > 0 && this.blocks[start - 1].quiet) start--;
    return indexAfter(this.blocks, start, CUT_PAUSE_MS / 2);
  }

  /** The index in the middle of the quietest QUIET_WINDOW_MS of the last SEARCH_MS. */
  private quietestMiddle(): number {
    const blocks = this.blocks;
    let from = blocks.length;
    for (let ms = 0; from > 0 && ms + blocks[from - 1].ms <= SEARCH_MS;) ms += blocks[--from].ms;
    let best = blocks.length;
    let bestLevel = Infinity;
    for (let start = from; start < blocks.length; start++) {
      let ms = 0;
      let energy = 0;
      let end = start;
      while (end < blocks.length && ms < QUIET_WINDOW_MS) { ms += blocks[end].ms; energy += blocks[end].level * blocks[end].ms; end++; }
      if (ms < QUIET_WINDOW_MS) break;
      if (energy / ms < bestLevel) { bestLevel = energy / ms; best = indexAfter(blocks, start, QUIET_WINDOW_MS / 2); }
    }
    return best;
  }

  private cutAt(index: number): Piece {
    const cut = Math.max(1, Math.min(index, this.blocks.length));
    const piece = this.blocks.slice(0, cut);
    this.blocks = this.blocks.slice(cut);
    this.ms = this.blocks.reduce((total, block) => total + block.ms, 0);
    this.run = 0;
    for (let index = this.blocks.length - 1; index >= 0 && this.blocks[index].quiet; index--) this.run += this.blocks[index].ms;
    return shorten(piece);
  }
}

/** The first index after `start` by which at least `ms` passed. */
function indexAfter(blocks: readonly Block[], start: number, ms: number): number {
  let index = start;
  for (let passed = 0; index < blocks.length && passed < ms; index++) passed += blocks[index].ms;
  return index;
}

/** The piece's PCM with every pause above LONG_PAUSE_MS cut to KEEP_PAUSE_MS (half at each edge). */
function shorten(blocks: readonly Block[]): Piece {
  const pcm: Uint8Array[] = [];
  let ms = 0;
  const keep = (block: Block) => { pcm.push(block.pcm); ms += block.ms; };
  for (let index = 0; index < blocks.length;) {
    if (!blocks[index].quiet) { keep(blocks[index++]); continue; }
    let end = index;
    let runMs = 0;
    while (end < blocks.length && blocks[end].quiet) runMs += blocks[end++].ms;
    if (runMs <= LONG_PAUSE_MS) { for (; index < end; index++) keep(blocks[index]); continue; }
    const head = indexAfter(blocks, index, KEEP_PAUSE_MS / 2);
    let tail = end;
    for (let kept = 0; tail > head && kept < KEEP_PAUSE_MS / 2;) kept += blocks[--tail].ms;
    for (; index < head; index++) keep(blocks[index]);
    for (index = tail; index < end; index++) keep(blocks[index]);
  }
  return { pcm, ms };
}

/** The pieces' texts as one: trimmed, one space between, their marks moved to where each text now starts. */
export function joinPieces(pieces: readonly MarkedText[]): MarkedText {
  let text = '';
  const uncertain: SpanMark[] = [];
  const dictated: Array<{ start: number; end: number }> = [];
  for (const piece of pieces) {
    const raw = typeof piece?.text === 'string' ? piece.text : '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lead = raw.length - raw.trimStart().length;
    const offset = text ? text.length + 1 : 0;
    text = text ? `${text} ${trimmed}` : trimmed;
    const move = <T extends { start: number; end: number }>(span: T): T | null => {
      const start = Math.max(0, Math.min(span.start - lead, trimmed.length));
      const end = Math.max(0, Math.min(span.end - lead, trimmed.length));
      return end > start ? { ...span, start: start + offset, end: end + offset } : null;
    };
    for (const span of piece.marks?.uncertain ?? []) { const moved = move(span); if (moved) uncertain.push(moved); }
    for (const span of piece.marks?.dictated ?? []) { const moved = move(span); if (moved) dictated.push(moved); }
  }
  const marks: TextMarks = { ...(uncertain.length ? { uncertain } : {}), ...(dictated.length ? { dictated } : {}) };
  return uncertain.length || dictated.length ? { text, marks } : { text };
}
