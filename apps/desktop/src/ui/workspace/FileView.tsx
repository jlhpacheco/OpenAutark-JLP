// Pane tab › a file: one plain monospace field over the whole page area and one fixed line under it – the dirty dot in
// its own cell, the status words and the Reload cell (file-doc.ts says what they say). The field is not bound to the
// text, so a keystroke in a 1 MB file redraws nothing and the field's own undo keeps working. A file that is no text or
// very large says so and offers Open with system; a right click on the line offers it for any file. B-076: a file of a
// linked PC (`device`) is read and saved there – while that PC is offline its one line says so – and the field scrolls
// in step with the same tab elsewhere (view-sync.ts). B-080 (a memory note's long lines ran off to the right): long
// lines wrap at the field's width, so the tabs keep in step by fraction – wrapped rows differ by width between devices.
// B-081: a path that holds nothing shows the not-found page (PathMissing.tsx: similar paths found on its PC, Create);
// a file that is no text but a picture, video, audio file or PDF by its name offers Show (the Media tab in this tab's
// place, for a linked PC's file too – that PC stores it first). A linked PC's file has "Show a copy here" (a day-long
// copy shown in its folder; on the phone every file "Save to phone" / "Download") at the line's end and under a file
// that is no text – there from the tab's start, so nothing moves (file-tabs.ts saveHere, saveHereWords).
// 22.11.2026 (owner: a .md report in the pane looked "richtig schlecht"): a Markdown file opens as a read page – the
// text set as a document (Markdown, markdown.css; `file-read`, file-tab.css) – and Edit / Read in one fixed cell of
// the line switches it to the field and back; the choice stays with the tab while the app runs.
// Owns: the field, the read page and the line. Never: saves or decides anything itself (file-doc.ts, file-tabs.ts).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useContextMenu } from '../lib/context-menu.tsx';
import { fileSize } from '../lib/format.ts';
import { modKey } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { Markdown } from '../blocks/markdown.tsx';
import { Icon, Spinner } from '../lib/ui.tsx';
import { fileStatus, POLL_MS, readable } from './file-doc.ts';
import { docFor, openFolderTab, openWithSystem, pathMenu, releaseDoc, saveHere, saveHereWords, savesHere, showable, showInMedia } from './file-tabs.ts';
import { writeArea } from './NotesView.tsx';
import { textKind } from './media-facts.ts';
import { PathMissing } from './PathMissing.tsx';
import { useSpace } from './space.ts';
import { useScrollPosition } from './view-sync.ts';

/** "Show a copy here" / "Save to phone" / "Download" where the file lives elsewhere (nothing where it does not). */
function SaveHere(props: { path: string; device?: string; class: string; disabled?: boolean }) {
  const [saving, setSaving] = useState(false);
  if (!savesHere(props.device)) return null;
  const words = saveHereWords();
  const save = () => {
    setSaving(true);
    saveHere(props.path, props.device).catch((error: unknown) => toastError(error, words.failed)).finally(() => setSaving(false));
  };
  return <button type="button" class={props.class} title={words.hint} disabled={saving || props.disabled} onClick={save}>{words.label}</button>;
}

/** Per tab: a Markdown file shows its read page (true, the start) or its field (false). */
const reading = new Map<string, boolean>();

function NoEditor(props: { id: string; space: string; path: string; text: string; device?: string }) {
  const { id, space, path, device } = props;
  return (
    <div class="workspace-start">
      <Icon name="file" size={24} />
      <p>{props.text}</p>
      {showable(path) && <button type="button" class="button secondary" onClick={() => showInMedia(path, id, space, device)}>Show</button>}
      {!device && <button type="button" class="button secondary" onClick={() => openWithSystem(path)}>Open with system</button>}
      <SaveHere path={path} device={device} class="button secondary" />
    </div>
  );
}

export function FileView(props: { id: string; path: string; device?: string }) {
  const { id, path, device } = props;
  const space = useSpace();
  const doc = useMemo(() => docFor(path, device), [path, device]);
  const state = doc.state.value;
  const area = useRef<HTMLTextAreaElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const markdown = textKind('', path) === 'markdown';
  const [read, setRead] = useState(() => markdown && reading.get(id) !== false);
  const toggle = () => { reading.set(id, !read); setRead(!read); };
  const menu = useContextMenu(() => pathMenu(path, device));
  useEffect(() => {
    void doc.open();
    const timer = setInterval(() => { if (!document.hidden) void doc.poll(); }, POLL_MS);
    const shown = () => { if (!document.hidden) void doc.poll(); }; // a hidden window looks again when it is shown
    document.addEventListener('visibilitychange', shown);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', shown); releaseDoc(doc); };
  }, [doc]);
  useLayoutEffect(() => { if (area.current) writeArea(area.current, doc.text); }, [doc, state.revision, state.phase, read]);
  useEffect(() => { if (state.phase === 'folder') openFolderTab(path, id, space, device); }, [state.phase]);
  const shown = state.phase === 'text' ? state.revision : -1;
  useScrollPosition(id, area, read ? -2 : shown, false); // B-080: by fraction (wrapped rows differ by width)
  useScrollPosition(id, page, read ? shown : -2, false);

  const size = fileSize(state.size);
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void doc.save(); }
  };
  // The look goes on in 'missing': its `since: ''` look is one stat and follows a file that appears there.
  if (state.phase === 'missing') return <div class="pane-view"><div class="new-tab"><PathMissing id={id} path={path} device={device} near={state.near ?? []} onCreate={() => doc.create()} /></div></div>;
  if (state.phase === 'binary') return <div class="pane-view"><NoEditor id={id} space={space} path={path} device={device} text={`This file is not text (${size}).`} /></div>;
  if (state.phase === 'large') return <div class="pane-view"><NoEditor id={id} space={space} path={path} device={device} text={`This file is too large to edit here (${size}).`} /></div>;
  return (
    <div class="pane-view pane-file" onKeyDown={onKeyDown}>
      {state.phase === 'text' && read
        ? <div ref={page} class="file-read" tabIndex={0} aria-label="File text"><Markdown text={readable(doc.text)} class="file-doc" /></div>
        : state.phase === 'text'
        ? <textarea ref={area} class="pane-notes-field file-field" aria-label="File text" wrap="soft" spellcheck={false} autocomplete="off" onInput={(event) => doc.edit(event.currentTarget.value)} />
        : <div class="pane-stage">{state.phase === 'failed' ? <p class="pane-note">{state.error}</p> : <Spinner label="Loading file" />}</div>}
      <div class={`pane-foot${state.error ? ' is-error' : ''}`} {...menu}>
        <span class={`file-dot${state.dirty ? ' is-dirty' : ''}`} role="img" aria-label={state.dirty ? 'Not saved' : 'Saved'} />
        <span class="pane-foot-text" role="status" aria-live="polite">{state.phase === 'text' ? fileStatus(state, size, modKey) : ''}</span>
        <span class="pane-foot-action">{state.changed && <button type="button" class="button secondary" onClick={() => void doc.load()}>Reload</button>}</span>
        {markdown && <span class="file-mode"><button type="button" class="button secondary" disabled={state.phase !== 'text'} onClick={toggle}>{read ? 'Edit' : 'Read'}</button></span>}
        <SaveHere path={path} device={device} class="button secondary pane-foot-button" disabled={state.phase !== 'text' || state.fresh} />
      </div>
    </div>
  );
}
