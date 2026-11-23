// The to-do detail (tasks/TodoWidget.tsx) leaves a line out that only says its title again.
// A line that only repeats what the title already says is left out (Mika 17.11.2026, points 3 and 4: the title stood
// three times after Start; "So the first posts sound like you." under "...so the first posts sound like you...").
// Owns: the comparison. Never: touches a to-do or its widget.

const plain = (text: string): string =>
  text.toLowerCase().replace(/[\s.\u2026!?,;:"'\u201e\u201c\u201d()\u2013\u2014-]+/g, ' ').trim();

/** True when `text` is the title or a part of it (case, punctuation and ellipses aside). Under four letters: never. */
export function repeatsTitle(text: string | undefined, title: string): boolean {
  const said = plain(text ?? '');
  return said.length >= 4 && plain(title).includes(said);
}

/** The block without the instructions of a `confirm` that only say the title again: Done stands alone then. */
export function withoutRepeat<T extends { type?: unknown; instructions?: unknown }>(block: T, title: string): T {
  return block.type === 'confirm' && typeof block.instructions === 'string' && repeatsTitle(block.instructions, title)
    ? { ...block, instructions: '' }
    : block;
}
