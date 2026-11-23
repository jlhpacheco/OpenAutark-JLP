// The notes of a person's typed line (tasks/quick.ts): the title is its first line, the notes hold what the title does not.
// Owns: that split. Never: creates a task, guesses a widget or a time, or asks a model.

import { excerpt } from '../../shared/text/chat-names.ts';

/**
 * B-078 (owner 06.11.: "mehrere Textfelder, die richtig riesig sind pro Task"): a quick task's notes hold only what
 * the title does not – the lines after a whole first line, else (a cut first line) the whole text.
 */
export function restNotes(text: string, title: string): string {
  const trimmed = text.trim();
  const [first, ...rest] = trimmed.split(/\r?\n/);
  if (excerpt(first.trim(), Infinity) !== title) return trimmed;
  return rest.join('\n').trim();
}
