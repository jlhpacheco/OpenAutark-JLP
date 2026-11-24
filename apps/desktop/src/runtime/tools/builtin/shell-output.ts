// Owns: bounded per-pipe capture and fail-closed release after redaction. Never: exposes partial raw output.
// A pipe's output is kept whole up to WHOLE characters and masked as a whole. Beyond that (0.3.19, Noah's review 24.11.2026:
// a long build log lost its error at the end) only its first and its last EDGE characters are kept; each is masked as a
// whole, and then MARGIN characters are cut off at its inner edge – where the middle was left out, a stored value or a key
// shape may be cut in two and its part not recognised. MARGIN is longer than any stored value in any spelling the masker
// knows: a value has at most 4096 characters (secrets/groups.ts) of at most 3 UTF-8 bytes each, so its URL-encoded form –
// the longest – at most 36 864 characters, its hex form at most 24 576, its grouped form at most four times its length; a
// PEM key is a few KB. MARGIN must stay above 36 864. The outer ends are the output's own start and end; what remains of
// each side is SIDE characters, so one overflowing pipe fits MAX_RESULT with its note on the middle. Every visible cut
// keeps whole characters: a half of a surrogate pair is no valid UTF-8, and a strict provider could refuse the text.
/** Store only bounded output. Never give a redactor a raw prefix/tail as if it were the full value. */
export const MAX_CAPTURE = 1024 * 1024; // both pipes together, kept whole (half each)
const WHOLE = MAX_CAPTURE / 2;
const MAX_RESULT = 64 * 1024;
const SIDE = 30 * 1024;
export const MARGIN = 48 * 1024;
export const EDGE = SIDE + MARGIN;
export const WITHHELD = '[command output withheld]';
type Redactor = (text: string) => string;
const high = (text: string, at: number) => { const c = text.charCodeAt(at); return c >= 0xd800 && c <= 0xdbff; };
const low = (text: string, at: number) => { const c = text.charCodeAt(at); return c >= 0xdc00 && c <= 0xdfff; };
/** The first n characters of text, one less where the cut would leave the high half of a surrogate pair. */
const first = (text: string, n: number) => text.slice(0, n > 0 && n < text.length && high(text, n - 1) ? n - 1 : n);
/** text from index k on, one later where the cut would leave the low half of a surrogate pair. */
const from = (text: string, k: number) => text.slice(k > 0 && k < text.length && low(text, k) ? k + 1 : k);

export class ShellOutput {
  private parts: string[] = [];
  private length = 0;
  private total = 0;
  private head: string | undefined; // set once the pipe outgrew WHOLE: its first EDGE characters
  private tail: string[] = []; // then: its newest chunks, at least the last EDGE and at most about twice that
  private tailLength = 0;
  append(text: string) {
    if (!text) return;
    this.total += text.length;
    if (this.head === undefined) {
      if (this.length + text.length <= WHOLE) { this.parts.push(text); this.length += text.length; return; }
      const whole = this.parts.join('') + text;
      this.head = whole.slice(0, EDGE);
      this.parts = [];
      this.length = 0;
      this.tail = [whole.slice(-EDGE)];
      this.tailLength = this.tail[0].length;
      return;
    }
    this.tail.push(text);
    this.tailLength += text.length;
    if (this.tailLength > 2 * EDGE) { this.tail = [this.tail.join('').slice(-EDGE)]; this.tailLength = EDGE; }
  }
  safe(completed: boolean, redact: Redactor): string | null {
    if (!completed) return null;
    try {
      if (this.head === undefined) return redact(this.parts.join(''));
      const head = redact(this.head);
      const tail = redact(this.tail.join('').slice(-EDGE));
      const start = first(head, Math.min(SIDE, Math.max(0, head.length - MARGIN)));
      const end = from(tail, Math.max(MARGIN, tail.length - SIDE));
      return `${start}\n… [output too long: ${this.total} characters, the middle left out] …\n${end}`;
    } catch { return null; }
  }
  /** A masked text within MAX_RESULT: its start and its end (where a failure shows) around the cut. Only ever a masked text. */
  static cap(safe: string): string {
    if (safe.length <= MAX_RESULT) return safe;
    const half = MAX_RESULT / 2;
    return `${first(safe, half)}\n… [output capped] …\n${from(safe, safe.length - half)}`;
  }
  view(completed: boolean, redact: Redactor): string {
    const safe = this.safe(completed, redact);
    return safe === null ? WITHHELD : ShellOutput.cap(safe);
  }
}
