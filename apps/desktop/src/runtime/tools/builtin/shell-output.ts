// Owns: bounded per-pipe capture and fail-closed release after redaction. Never: exposes partial raw output.
/** Store only bounded complete output. Never give a redactor a raw prefix/tail as if it were the full value. */
export const MAX_CAPTURE = 1024 * 1024;
const MAX_RESULT = 64 * 1024;
export const WITHHELD = '[command output withheld]';
type Redactor = (text: string) => string;

export class ShellOutput {
  private parts: string[] = [];
  private length = 0;
  private overflow = false;
  append(text: string) {
    if (this.overflow || !text) return;
    if (this.length + text.length > MAX_CAPTURE) {
      this.overflow = true;
      this.parts = [];
      return;
    }
    this.parts.push(text);
    this.length += text.length;
  }
  safe(completed: boolean, redact: Redactor): string | null {
    if (!completed || this.overflow) return null;
    try { return redact(this.parts.join('')); } catch { return null; }
  }
  static cap(safe: string): string {
    return safe.length > MAX_RESULT ? safe.slice(0, MAX_RESULT) + '\n… [output capped]' : safe;
  }
  view(completed: boolean, redact: Redactor): string {
    const safe = this.safe(completed, redact);
    return safe === null ? WITHHELD : ShellOutput.cap(safe);
  }
}
