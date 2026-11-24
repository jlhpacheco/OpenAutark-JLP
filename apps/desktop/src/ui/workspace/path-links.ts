// File paths in rendered agent text (B-081). An absolute path – a markdown link target, a code span holding only a path,
// or (20.11.2026, FCMWO5R5: the owner on the phone found nothing to tap on a path written as inline code) a path written
// bare in the text, a `file:` URL or a local-network path (path-text.ts decides) – stands as a file chip: the file or
// folder icon and its name (a link keeps its own label), the whole path as its title and, hidden, in its text. It
// carries the path in `data-path` (never as an href: the sanitizer keeps only http(s), mailto and '#'), and a click, tap
// or Enter on it opens the path where it is: on the author agent's home PC first, then on this PC – a folder as a folder
// tab, an image, video, audio file or PDF as a media tab, anything else as a file tab; on the phone a file that is no
// text is saved to the phone, the way the phone opens such an attachment (file-tabs.ts saveHere). No space is named, so
// the tab lands where the frame says: the global side pane on the desktop, the open chat's area on the phone. A path on
// neither PC opens its tab on the PC asked first (the tab's not-found page names similar paths); when that PC is offline
// or not linked, one toast says so, and so does a connection that may not read PC files (NO_PATH_READ). What a phone may
// read stays files.readPath's rule ('manage' on a secure transport: the PC's own window, and the paired phone app, whose
// tunnel ends on this PC's loopback); a phone's file comes as a stored file (files.uploadPath), served like an
// attachment. A file block's or review's Open uses it too (16.11.: a file an agent sent opens on the phone as in the chat).
// A Windows link target keeps its backslashes as written (CommonMark would read `\.` as an escape); a bare path is taken
// from the text as written too. The enclosing control wins: a path in a link's label, or inside a button or label (an
// option, a card, a checklist item), stays plain text. Selecting text keeps copying it: markdown.tsx opens nothing while
// a selection exists. A network path (`\\nas\share\…`) reaches its host once the person confirmed that host on their
// PC: the runtime refuses it with the host's name (files/net-hosts.ts), one confirm here names the host, and a yes is
// remembered there (files.allowHost) – a no opens nothing and says nothing more.
// Owns: the marked parts that make a path a chip (pathTokenizer, pathExtension, pathRenderer), plainInControl and what a
// click on one opens (openPathLink). Never: decides which text is a path (path-text.ts), reads or draws a file itself
// (file-tabs.ts, FileView, MediaView), decides where a tab lands (pages.ts home()), or puts a path into an href.

import { Renderer, Tokenizer, type RendererObject, type TokenizerExtension, type RendererExtension, type TokenizerObject } from 'marked';
import '../../shared/api/methods-files.ts'; // the files.readPath shape (module augmentation)
import type { PathRead } from '../../shared/api/methods-files.ts';
import { platform } from '../lib/platform.ts';
import { rpc, RpcError } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { knownAgentMap, systemInfo } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { onPc, openFileTab, openFolderTab, saveHere } from './file-tabs.ts';
import { viewKind } from './media-facts.ts';
import { openMedia } from './pages.ts';
import { looksLikeFolder, pathAt, pathIn, pathName, pathStart } from './path-text.ts';

export { pathIn };

const DRIVE = /^[A-Za-z]:[\\/]/;

/** A Windows or network path keeps its link target as written: marked reads `\.`, `\_` or `\\` as an escape (C:\a\.git -> C:\a.git). */
function asWritten(token: { href: string } | undefined, dest: string | undefined): void {
  const path = dest?.trim().replace(/^<([^]*)>$/, '$1');
  if (token && path && (DRIVE.test(path) || path.startsWith('\\\\'))) token.href = path;
}

/** marked tokenizers: an inline link and a link definition (`[x]: C:\a`) naming a Windows path keep its backslashes. */
export const pathTokenizer: TokenizerObject = {
  link(src) {
    const token = Tokenizer.prototype.link.call(this, src);
    if (token?.type === 'link') asWritten(token, this.rules.inline.link.exec(token.raw)?.[2]);
    return token;
  },
  def(src) {
    const token = Tokenizer.prototype.def.call(this, src);
    asWritten(token, this.rules.block.def.exec(src)?.[2]);
    return token;
  },
};

const escape = (text: string): string => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

let inLabel = 0; // > 0 while a link's label renders: a path there belongs to that link

/** The chip: `label` in an anchor without href; the icon (file or folder) comes from markdown.css. */
function chip(path: string, label: string): string {
  return `<a data-path="${escape(path)}" title="${escape(path)}"${looksLikeFolder(path) ? ' data-folder=""' : ''}>${label}</a>`;
}

/** A path's own label: its last name shown, the folders before it and a closing separator hidden (still there for a
 *  control that makes the chip text again). */
function named(path: string): string {
  const name = pathName(path);
  const at = path.lastIndexOf(name);
  if (at <= 0) return escape(path);
  const hidden = (text: string) => (text ? `<span data-dir="">${escape(text)}</span>` : '');
  return `${hidden(path.slice(0, at))}${escape(name)}${hidden(path.slice(at + name.length))}`;
}

/** marked renderers: a link or code span holding a path is a chip; others render as before. */
export const pathRenderer: RendererObject = {
  link(token) {
    const path = pathIn(token.href, false);
    inLabel++;
    try {
      return path ? chip(path, this.parser.parseInline(token.tokens)) : Renderer.prototype.link.call(this, token);
    } finally { inLabel--; }
  },
  codespan(token) {
    const path = inLabel ? undefined : pathIn(token.text, true);
    return path ? chip(path, named(path)) : false;
  },
};

interface PathToken { type: 'path'; raw: string; lead: string; written: string; path: string }

/** marked extension: a path written bare in the text (after a space, bracket or quote) is a chip; the character before stays. */
export const pathExtension: TokenizerExtension & RendererExtension = {
  name: 'path',
  level: 'inline',
  start: (src) => pathStart(src),
  tokenizer(src) {
    if (this.lexer.state.inLink) return undefined;
    const found = pathAt(src);
    return found ? { type: 'path', ...found } satisfies PathToken : undefined;
  },
  renderer(generic) {
    const token = generic as unknown as PathToken;
    return `${escape(token.lead)}${inLabel ? escape(token.written) : chip(token.path, named(token.path))}`;
  },
};

/** Inline text inside a button or label: the control keeps its click, so a path there is plain text again. */
export function plainInControl(root: Element | null): void {
  if (!root?.parentElement?.closest('button, label')) return;
  for (const el of root.querySelectorAll('[data-path]')) for (const name of ['data-path', 'data-folder', 'role', 'tabindex', 'title']) el.removeAttribute(name);
}

/** Why a click on a PC file opens nothing on this connection (files.readPath: the owner's devices on a secure link). */
export const NO_PATH_READ = "Files on the PC open from the owner's PC or phone over a secure connection; this one has no access to them.";

/** What the path holds, shown: a folder tab, the Media tab, on the phone a saved file when it is no text, else a file tab. */
async function show(read: PathRead, pc: string | undefined, desktop: boolean): Promise<void> {
  if (read.state === 'folder') openFolderTab(read.path, undefined, undefined, pc);
  else if (viewKind('', read.path) !== 'file') openMedia({ path: read.path, ...onPc(pc) });
  else if (!desktop && (read.state === 'binary' || read.state === 'large')) await saveHere(read.path, pc, false);
  else openFileTab(read.path, undefined, undefined, pc);
}

/** The person's one question before this PC goes to another computer on the network for a file. */
export type AskHost = (host: string) => Promise<boolean>;

const askHost: AskHost = async (host) => (await import('../lib/dialog.tsx')).confirm({
  title: `Open files on ${host}?`,
  body: `${host} is another computer on the network. To open the file, this PC signs in to it. Autark asks once for each such computer.`,
  confirmLabel: 'Open',
});

/** The host a refusal names when the runtime waits for the person's yes to a network host (files/net-hosts.ts). */
const netHostIn = (error: unknown): string | undefined => {
  const host = error instanceof RpcError ? error.data.details?.netHost : undefined;
  return typeof host === 'string' ? host : undefined;
};

/** files.readPath; a network host not yet confirmed is asked once – yes: remembered and read, no: 'declined'. */
async function readPath(path: string, pc: string | undefined, ask: AskHost): Promise<PathRead | 'declined'> {
  try { return await rpc.call('files.readPath', { path, ...onPc(pc) }); }
  catch (error) {
    const host = netHostIn(error);
    if (!host) throw error;
    if (!await ask(host)) return 'declined';
    await rpc.call('files.allowHost', { host });
    return rpc.call('files.readPath', { path, ...onPc(pc) });
  }
}

/** The PC a refusal says is offline (devices/sync/paths.ts: "<name> is offline.", details.reachable false). */
export function offlinePc(error: unknown): string | undefined {
  if (!(error instanceof RpcError) || error.data.details?.reachable !== false) return undefined;
  return /^(.+) is offline\.?$/.exec(error.message)?.[1] ?? 'another PC';
}

/** B249F927 (24.11.2026, a CSV of an agent whose home PC was off: "Could not open … · TB Kassio… is offline"): the words
 *  when the file lives on the agent's PC, that PC is offline and this PC has no copy – where it is and that it waits. */
export function offlineWords(path: string, pc: string): string {
  return `${pathName(path)} is on ${pc}, which is offline right now. It opens once that PC is online again.`;
}

/** Opens `path` from a message by `authorId`: on that agent's home PC, else on this PC, else its not-found tab. */
export async function openPathLink(path: string, authorId?: string, desktop = platform === 'desktop', ask: AskHost = askHost): Promise<void> {
  if (!pathIn(path, false)) return; // a public network path or no path at all: nothing is asked
  const failed = `Could not open ${pathName(path)}`;
  if (!can('files.readPath')) { toastError(NO_PATH_READ, failed); return; }
  const home = authorId ? knownAgentMap.peek().get(authorId)?.deviceId : undefined;
  const pcs = home && home !== systemInfo.peek()?.deviceId ? [home, undefined] : [undefined];
  let first: { read?: PathRead; error?: unknown } | undefined; // the first PC's answer when it had nothing
  for (const pc of pcs) {
    let read: PathRead | 'declined';
    try { read = await readPath(path, pc, ask); }
    catch (error) { first ??= { error }; continue; }
    if (read === 'declined') return;
    if (read.state !== 'missing') { await show(read, pc, desktop).catch((error: unknown) => toastError(error, failed)); return; }
    first ??= { read };
  }
  const missing = first?.read;
  if (!missing) {
    const pc = offlinePc(first?.error);
    toastError(pc ? offlineWords(path, pc) : first?.error, failed);
    return;
  }
  (/[\\/]$/.test(path) ? openFolderTab : openFileTab)(missing.path, undefined, undefined, pcs[0]); // written with a closing separator: a folder
}
