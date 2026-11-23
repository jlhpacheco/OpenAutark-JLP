// The parts of an agent's SYSTEM.md, found by their headings: "# How I work" on top (the standard's or the agent's own
// version), "## My role" (older files: "## Your role") with the agent's role text and "## What I have here" (standing facts
// and agreements) as the last part. org/hire.ts, onboarding and the readers of an agent's own text (a voice
// call's brief, a hire's result) share these rules.
// Owns: the heading names and the split of those parts. Never: reads files or decides what an agent may change.

const ROLE_HEADING = '## My role';
const ROLE_HEADINGS: readonly string[] = [ROLE_HEADING, '## Your role'];
export const HAVE_HEADING = '## What I have here';
/** The working part on top of every SYSTEM.md (the standards resources/prompts/standard-*.md begin with it). */
export const WORK_HEADING = '# How I work';

/** True for the role heading line, the current form or the older one. */
export function isRoleHeading(line: string): boolean {
  return ROLE_HEADINGS.includes(line.trim());
}

/** The line index of the role heading, or -1. */
function roleLineIndex(lines: readonly string[]): number {
  return lines.findIndex(isRoleHeading);
}

/** True when the text has a "## What I have here" part. */
export function hasHavePart(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === HAVE_HEADING);
}

/**
 * A SYSTEM.md split into the agent's own "# How I work" (when the file begins with it: up to the role heading, or all of
 * it without one) and the rest; `how` is '' for a file that does not begin with it.
 */
export function ownHowIWork(text: string): { how: string; rest: string } {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines[0]?.trim() !== WORK_HEADING) return { how: '', rest: text.trim() };
  const at = roleLineIndex(lines);
  if (at < 0) return { how: lines.join('\n'), rest: '' };
  return { how: lines.slice(0, at).join('\n').trim(), rest: lines.slice(at).join('\n').trim() };
}
