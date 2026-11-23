// One file open in the pane's file tab, in step with the disk the simple way: load (files.readPath), type, save on
// Ctrl+S (files.writePath on the stamp it was made on), and look every few seconds whether the file changed. A change is
// followed at once while nothing typed waits; with typed text it is a notice with Reload, and a save over it is the
// person's answer. The text field folds CR LF to LF, so the file's line ends are kept here and given back on save.
// A doc with typed text outlives its tab (a tab closed or not shown keeps the draft until the app ends). B-076: a file
// of a linked PC (`device`) works the same – its calls go there, its stamps are that PC's; while that PC is offline a
// load says so in one line and the next look tries again. B-081: a path that holds nothing is the 'missing' phase with
// the similar paths (`near`, the not-found page); create() makes it an empty text a save creates, and the look goes on,
// so a file that appears there meanwhile is followed.
// 22.11.2026: readable() gives a Markdown file's read page its text – a front matter block becomes a quiet code box.
// Owns: that loop, the words under the field and readable(). Never: touches the DOM or merges texts.

import { signal } from '@preact/signals';
import type { PathEntry, PathRead, PathWritten } from '../../shared/api/methods-files.ts';

export const POLL_MS = 2000;

/** 'missing': nothing at the path – the not-found page (create() turns it into an empty 'text'). */
export type FilePhase = 'loading' | 'text' | 'missing' | 'binary' | 'large' | 'folder' | 'failed';

export interface FileState {
  phase: FilePhase;
  size: number;
  /** Typed text that is not saved yet. */
  dirty: boolean;
  saving: boolean;
  /** The file does not exist yet; a save creates it. */
  fresh: boolean;
  /** With phase 'missing': similar existing paths on the PC that holds the path (files.readPath `near`). */
  near?: readonly PathEntry[];
  /** The file changed on disk under typed text: the notice with Reload. */
  changed: boolean;
  /** The file changed on disk and the field followed. */
  followed: boolean;
  error?: string;
  /** Counts the texts the field must take over (a load, a followed change). */
  revision: number;
}

export interface FileCalls {
  read(path: string, since?: string): Promise<PathRead>;
  write(path: string, text: string, base?: string): Promise<PathWritten>;
  /** The runtime refused a save made on an older stamp. */
  conflict(error: unknown): boolean;
  errorText(error: unknown): string;
}

/** What a text field holds for `text`. */
const fieldText = (text: string): string => text.replace(/\r\n?/g, '\n');

export class FileDoc {
  readonly state = signal<FileState>({ phase: 'loading', size: 0, dirty: false, saving: false, fresh: false, changed: false, followed: false, revision: 0 });
  /** The text as the field holds it. Not in the signal: a keystroke redraws nothing but a changed dirty dot. */
  text = '';
  readonly path: string;
  /** The linked PC the file is on (none: this PC). */
  readonly device: string | undefined;
  private readonly calls: FileCalls;
  private saved = '';
  private crlf = false;
  /** The stamp the text was made on. */
  private base = '';
  /** The stamp last seen on disk. */
  private seen: string | undefined;
  private looking = false;
  /** create() was asked: a missing file is an empty text, not the not-found page. */
  private making = false;

  constructor(path: string, calls: FileCalls, device?: string) {
    this.path = path;
    this.calls = calls;
    this.device = device;
  }

  private set(change: Partial<FileState>): void {
    this.state.value = { ...this.state.peek(), ...change };
  }

  private take(read: PathRead, followed: boolean): void {
    this.seen = read.stamp;
    const revision = this.state.peek().revision + 1;
    const facts = { size: read.size, dirty: false, changed: false, followed, error: undefined, revision };
    if (read.state === 'text' || read.state === 'missing') {
      const raw = read.text ?? '';
      this.crlf = raw.includes('\r\n');
      this.text = this.saved = fieldText(raw);
      this.base = read.stamp;
      const missing = read.state === 'missing' && !this.making;
      this.set({ ...facts, phase: missing ? 'missing' : 'text', fresh: read.state === 'missing', near: missing ? read.near ?? [] : undefined });
    } else if (read.state !== 'same') {
      this.set({ ...facts, phase: read.state, fresh: false, near: undefined });
    }
  }

  /** The not-found page's Create, or an app-own file meant to be made: an empty text that Ctrl+S creates. */
  create(): void {
    this.making = true;
    const now = this.state.peek();
    if (now.phase === 'missing') this.set({ phase: 'text', near: undefined, revision: now.revision + 1 });
  }

  /** Reads the file; typed text is thrown away (Reload). */
  async load(): Promise<void> {
    try { this.take(await this.calls.read(this.path), false); }
    catch (error) { this.set({ ...(this.state.peek().phase === 'text' ? {} : { phase: 'failed' as const }), error: this.calls.errorText(error) }); } // a Reload that fails leaves the field as it is
  }

  /** The tab shows this doc: a draft stays, anything else is read. */
  open(): Promise<void> {
    return this.state.peek().dirty ? this.poll() : this.load();
  }

  edit(text: string): void {
    this.text = text;
    const dirty = text !== this.saved;
    const now = this.state.peek();
    if (dirty !== now.dirty || now.followed || now.error) this.set({ dirty, followed: false, error: undefined });
  }

  /** Writes what was typed; a file changed meanwhile becomes the notice, and saving with the notice up overwrites. */
  async save(): Promise<void> {
    const now = this.state.peek();
    if (now.phase !== 'text' || now.saving || (!now.dirty && !now.fresh)) return;
    const text = this.text;
    const disk = this.crlf ? text.replace(/\n/g, '\r\n') : text;
    this.set({ saving: true, error: undefined, followed: false });
    try {
      const written = await this.calls.write(this.path, disk, now.changed ? undefined : this.base);
      this.saved = text;
      this.base = this.seen = written.stamp;
      this.set({ saving: false, size: written.size, dirty: this.text !== text, fresh: false, changed: false });
    } catch (error) {
      if (this.calls.conflict(error)) this.set({ saving: false, changed: true });
      else this.set({ saving: false, error: this.calls.errorText(error) });
    }
  }

  /** Looks whether the file changed on disk (one stat while it did not). */
  async poll(): Promise<void> {
    if (this.looking || this.state.peek().saving || this.state.peek().phase === 'loading') return;
    this.looking = true;
    try {
      const read = await this.calls.read(this.path, this.seen);
      const now = this.state.peek();
      if (read.state === 'same' || read.stamp === this.seen || now.saving) return; // the stamp: this look crossed our own save
      if (now.dirty) { this.seen = read.stamp; this.set({ changed: true }); }
      else this.take(read, true);
    } catch { /* the next look tries again */ } finally { this.looking = false; }
  }
}

/** The words under the field. `mod`: the save key's modifier on this system. */
export function fileStatus(state: FileState, size: string, mod = 'Ctrl+'): string {
  if (state.error) return state.error;
  if (state.saving) return 'Saving…';
  if (state.changed) return state.dirty ? `Changed on disk. ${mod}S keeps your text` : 'Changed on disk';
  if (state.dirty) return `${mod}S saves`;
  if (state.fresh) return `New file. ${mod}S creates it`;
  if (state.followed) return `Changed on disk, reloaded · ${size}`;
  return size;
}

/** A Markdown file for its read page: a leading `---` front matter block (skills, memory notes) as a yaml code box
 *  instead of a rule and a setext heading; any other text as it is. */
export function readable(text: string): string {
  const head = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!head) return text;
  const fence = '`'.repeat(Math.max(3, ...Array.from(head[1]!.matchAll(/`{3,}/g), (match) => match[0].length + 1)));
  return `${fence}yaml\n${head[1]}\n${fence}\n\n${text.slice(head[0].length)}`;
}
