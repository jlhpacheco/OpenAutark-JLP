// German-aware text folding for search (FTS5 indexes and queries) and fuzzy name matching.
// Owns: the one folding rule used everywhere text is indexed or compared ("Straße" = "strasse",
// "Müller" = "muller"), the app's one light stemmer (stem – the word index's query reads it too), the FTS5 MATCH
// query builder and a plain-text snippet helper.
// Never: imports anything outside src/shared; never changes stored originals (fold copies only).

/** Lowercase, ß→ss, NFKD and strip combining marks. Stable: fold(fold(x)) === fold(x). */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
}

/** Folded word tokens (letters/digits), in order. */
export function tokens(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const SUFFIXES = ['ungen', 'ing', 'ies', 'en', 'er', 'es', 'ed', 'e', 's', 'n'];
/** Verbs on -ieren and their nouns share a root: "Signierung" finds "signieren" and "Signatur", "Installation" "installieren". */
const ROOT = /(?:ierungen|ierung|ieren|iert|ationen|ation)$/;

/**
 * The app's one light stem of a folded token (the word index's query, the search boxes): a shared -ieren/-ation root, else the
 * longest common inflection suffix removed ("rechnungen" → "rechnung", "meetings" → "meeting"); at least 4 letters stay,
 * a token with digits (an id) stays whole. A stem is a prefix of its token, so a prefix query on it finds the token too.
 */
export function stem(token: string): string {
  if (token.length < 5 || /\d/.test(token)) return token;
  const root = ROOT.exec(token);
  if (root && token.length - root[0].length >= 4) return token.slice(0, -root[0].length);
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return suffix === 'ungen' ? `${token.slice(0, -suffix.length)}ung` : token.slice(0, -suffix.length);
  }
  return token;
}

/** A typed ae/oe/ue may stand for ä/ö/ü, which foldText writes a/o/u: "Mueller" also looks for "muller" (Müller). */
function spellings(token: string): string[] {
  const plain = token.replace(/([aou])e/g, '$1');
  return plain === token ? [token] : [token, plain];
}

/** The prefixes one typed token looks for: its stem, and the stem of its umlaut spelling. */
const prefixes = (token: string): string[] => [...new Set(spellings(token).map(stem))];

/**
 * Safe FTS5 MATCH expression from free user text: every token becomes a quoted prefix term of its stem
 * ("ann"* AND "video"*; "Rechnungen" → "rechnung"*, "Mueller" → ("mueller"* OR "muller"*)), AND-ed. Returns '' when nothing
 * searchable remains, so callers can skip the query. Quoting neutralizes FTS operators typed by users (AND, NEAR, -, :, *).
 * The stored tables keep their tokenizer and folding (ä → a); only the query reads more spellings.
 */
export function ftsQuery(text: string, maxTokens = 12): string {
  return tokens(text)
    .slice(0, maxTokens)
    .map(token => {
      const terms = prefixes(token).map(term => `"${term.replace(/"/g, '')}"*`);
      return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
    })
    .join(' AND ');
}

/** True when every folded token of `query` (by its stem, as ftsQuery) prefixes some word of `text` (client-side filter). */
export function matchesQuery(text: string, query: string): boolean {
  const wanted = tokens(query);
  if (!wanted.length) return true;
  const words = tokens(text);
  return wanted.every(token => prefixes(token).some(prefix => words.some(word => word.startsWith(prefix))));
}

/**
 * Short excerpt of the ORIGINAL text around the first word that matches a query token.
 * Works on originals (unlike FTS5 snippet(), which would show the folded index text).
 */
export function snippet(text: string, query: string, radius = 8): string {
  const wanted = tokens(query);
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (!words.length || !words[0]) return '';
  let hit = words.findIndex(word => {
    const folded = tokens(word);
    return folded.some(part => wanted.some(token => part.startsWith(token)));
  });
  if (hit < 0) hit = 0;
  const from = Math.max(0, hit - radius);
  const to = Math.min(words.length, hit + radius + 1);
  return (from > 0 ? '…' : '') + words.slice(from, to).join(' ') + (to < words.length ? '…' : '');
}
