// Which text in an agent's message names an absolute local path (B-081; 20.11.2026 FCMWO5R5: the owner on the phone
// could not tap a path Paula wrote as inline code – a path now stands as a file chip wherever it is written). A path is
// a Windows drive path (`C:\…`, `C:/…`), a POSIX path, a `file:` URL (turned into the path it names) or a network path
// on the local network (`\\nas\share\…`, `\\wsl$\…`, `\\192.168.1.5\…`): a host with a public name (`\\evil.example\…`)
// stays text, so a tap never makes this PC dial and sign in to a host a message names. Three places hold one: a link
// target and a code span (the whole text: spaces, umlauts and all), and bare text, where a path starts after a space,
// an opening bracket or quote (never inside a word or a web address), a Windows path runs on over a space only to its
// next backslash, and closing punctuation stays outside. Bare POSIX paths count from the usual top folders (`/home/`,
// `/Users/`, `/tmp/` …), so `und/oder`, `km/h` or an API route stay text.
// Owns: pathIn, pathAt, pathStart, pathName, looksLikeFolder. Never: marked, the DOM or any call to a PC (path-links.ts).

const DRIVE = /^[A-Za-z]:[\\/]/;
/** A link target: any rooted posix path; '//host' or '/\host' (a web or network address) is none. */
const POSIX = /^\/(?![\\/])/;
/** A code span: two segments at least, so `/rpc` or a slash command stays text. */
const POSIX_SPAN = /^\/(?![\\/])[^/\s]+\//;
/** Globs, placeholders such as C:\Users\<name>, brace sets, pipes and line breaks are no path. */
const NOT_PATH = /[\r\n*?<>|"{}]/;
/** `\\host\share…`: the host, then a share. */
const UNC = /^\\\\([^\\/\s]+)\\[^\\/\s]/;
/** Where a bare path may begin: a drive, a network path, a file URL, or a usual POSIX top folder. */
const BARE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+\\|file:\/|\/(?:home|Users|tmp|var|etc|opt|mnt|srv|Volumes|usr|Applications|Library|private|root|media)\/)/;
/** What may stand right before a bare path (a space, a parenthesis, a quote) – never a letter, digit, slash or colon, and
 *  no `[`, which opens a link whose label is its own. */
const BEFORE = /[\s(„“"'‚‘«»]/;
/** A place where a bare path may begin: such a character right before a path's start. */
const START = new RegExp(`${BEFORE.source}(?=${BARE.source.slice(1)})`, 'g');
/** Characters that end a bare path. */
const END = /[\s<>"|*?`]/;
/** Closing punctuation a sentence puts after a path. */
const TRAILING = /[.,;:!?'"»«“”‘’)\]}]$/;

/** A host on the local network: one label (a NetBIOS name, wsl$), a private or loopback IPv4, or a local suffix. */
export function lanHost(host: string): boolean {
  const name = host.toLowerCase();
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (!name.includes('.')) return /^[\p{L}\p{N}$_-]+$/u.test(name);
  return /^[\p{L}\p{N}_.-]+\.(?:local|localhost|lan|home\.arpa)$/u.test(name);
}

/** The path a `file:` URL names (`file:///C:/a%20b.pdf` → `C:/a b.pdf`, `file://nas/s/x` → `\\nas\s\x`), else undefined. */
function fromFileUrl(url: string): string | undefined {
  const match = /^file:(?:\/\/([^/]*))?(\/.*)?$/i.exec(url);
  if (!match) return undefined;
  let host = match[1] ?? '';
  let rest = match[2] ?? '';
  try { host = decodeURIComponent(host); rest = decodeURIComponent(rest); } catch { return undefined; }
  if (/^[A-Za-z]:$/.test(host)) return host + rest; // file://C:/x, as some write it
  if (host && host.toLowerCase() !== 'localhost') return rest.length > 1 ? `\\\\${host}${rest.replace(/\//g, '\\')}` : undefined;
  return /^\/[A-Za-z]:[\\/]/.test(rest) ? rest.slice(1) : rest || undefined;
}

/** The absolute path `text` names (a link target, or a code span with `span`), else undefined. */
export function pathIn(text: string, span: boolean): string | undefined {
  const trimmed = text.trim();
  const path = /^file:/i.test(trimmed) ? fromFileUrl(trimmed) : trimmed;
  if (!path || path.length > 1024 || NOT_PATH.test(path)) return undefined;
  if (DRIVE.test(path)) return path;
  const unc = UNC.exec(path);
  if (unc) return lanHost(unc[1]!) ? path : undefined;
  return (span ? POSIX_SPAN : POSIX).test(path) ? path : undefined;
}

/** Where a Windows path written with backslashes runs on over the space at `at`: to its next backslash, when the words
 *  up to it read as a folder name (no colon, no sentence end), else -1. */
function overSpace(src: string, at: number): number {
  const rest = src.slice(at + 1, at + 81);
  const next = rest.indexOf('\\');
  if (next <= 0) return -1;
  const words = rest.slice(0, next);
  return /^[^\s:\\/<>"|*?`]/.test(words) && !/\s$|[\n\r\t:<>"|*?`/]|[,;.!?)] /.test(words) ? at + 1 + next : -1;
}

/** The bare path at the start of `src` – after one leading space, bracket or quote, when there is one – else undefined.
 *  `raw`: what it takes from the text (the leading character too); `lead`: that character. */
export function pathAt(src: string): { raw: string; lead: string; written: string; path: string } | undefined {
  const lead = BEFORE.test(src[0] ?? '') ? src[0]! : '';
  const from = lead.length;
  const start = BARE.exec(src.slice(from));
  if (!start) return undefined;
  const backslashes = /^(?:[A-Za-z]:\\|\\\\)/.test(start[0]);
  let end = from + start[0].length;
  while (end < src.length) {
    const ch = src[end]!;
    if (ch === ' ' && backslashes) {
      const on = overSpace(src, end);
      if (on < 0) break;
      end = on;
      continue;
    }
    if (END.test(ch)) break;
    end++;
  }
  if (/[<>?|]/.test(src[end] ?? '') || src[end] === '*' && (/[\\/]/.test(src[end - 1]!) || /[\p{L}\p{N}_.]/u.test(src[end + 1] ?? ''))) {
    return undefined; // a placeholder (C:\Users\<name>) or a glob (C:\x\*.md) – a bold's closing ** is no glob
  }
  let written = src.slice(from, end);
  while (TRAILING.test(written)) {
    const last = written.at(-1)!;
    if (last === ')' && written.split('(').length > written.split(')').length) break; // C:\Program Files (x86)
    if (/^[A-Za-z]:[\\/]$/.test(written)) break; // C:\ itself
    written = written.slice(0, -1);
  }
  const path = pathIn(written, false);
  if (!path || written.length <= start[0].length && !DRIVE.test(written)) return undefined;
  return { raw: src.slice(0, from + written.length), lead, written, path };
}

/** Where the next bare path in `src` begins – the index of the space, bracket or quote before it – else -1. */
export function pathStart(src: string): number {
  for (const match of src.matchAll(START)) if (pathAt(src.slice(match.index))) return match.index;
  return -1;
}

/** The last name in a path – the file, or the folder – as a chip shows it. */
export function pathName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > (DRIVE.test(path) ? 1 : 0) ? parts.at(-1)! : path;
}

/** Written as a folder: a closing separator, or a last name without an extension. */
export function looksLikeFolder(path: string): boolean {
  return /[\\/]$/.test(path) || !/\.[\p{L}\p{N}]{1,8}$/u.test(pathName(path));
}
