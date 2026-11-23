// Plain-text clean-up for text that came from outside (apps, run journals, experience notes): invisible
// Unicode (controls, zero-width, bidi, tag characters) and markup go.
// Owns: these pure rules.

// C0/C1 controls except \t and \n, zero-width and word-joiner characters, BOM, bidi controls, Unicode tags.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu;

/** Text without invisible or direction-changing characters. */
export function cleanText(value: string): string {
  return value.replace(INVISIBLE, '');
}

/** Plain text: links and images as their label, no fences, HTML tags, chat tokens, [[…]] directives or secret handles. */
export function stripMarkup(value: string): string {
  return value
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\[\[[\s\S]*?\]\]/g, '')
    .replace(/<\|[^|>\n]{0,40}\|>/g, '')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/secret:\/\/[^\s"'<>)\]]*/gi, '');
}
