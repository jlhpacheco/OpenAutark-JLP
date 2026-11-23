// What the person edits in a task's detail (Quests round 20.11.2026; review R2.6): the title in place – the heading
// itself takes the caret (15 px, the same box, nothing moves): Enter or leaving it saves, Esc puts the title back, an
// empty one stays as it was; "Rename…" in a menu opens the detail with the title selected – and the time chip, which
// opens a small field under it (on the phone too): typed words go through the input line's rule (shared/text/when.ts
// findTimes, input-model.ts) – a single phrase with a clock time is used at once (blue, ×) and Enter sets it, a day alone
// or two phrases are offered outlined and one click sets that one; "No time" clears it.
// Owns: the title's editing and the time field. Never: the detail's frame (TodoDetail.tsx, QuestDetail.tsx) or the
// calls (page-actions.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { findTimes, type TimePhrase } from '../../shared/text/when.ts';
import { dayZone } from '../lib/day-store.ts';
import { Button, Popover } from '../lib/ui.tsx';
import { NO_CHOICE, drop, timePatch, usedPhrase } from './input-model.ts';
import { rename, setTime } from './page-actions.ts';
import { renaming } from './page-state.ts';
import { phraseText, whenOf } from './when-text.ts';

/** The detail's title, edited where it stands (`label`: what the page calls the task – todoLabel). */
export function TitleEdit(props: { task: Task; label: string }) {
  const { task, label } = props;
  const ref = useRef<HTMLHeadingElement>(null);
  const cancelled = useRef(false);
  const [version, setVersion] = useState(0); // a new key puts the stored title back into the heading
  const editable = label === task.title; // a join request's own sentence is no title to edit
  useEffect(() => {
    const el = ref.current;
    if (renaming.value !== task.id || !el) return;
    renaming.value = null;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }, [renaming.value, task.id]);
  const commit = () => {
    const typed = (ref.current?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const back = () => setVersion((count) => count + 1);
    if (cancelled.current || !typed || typed === task.title) { cancelled.current = false; if (ref.current?.textContent !== task.title) back(); return; }
    void rename(task, typed).then((ok) => { if (!ok) back(); });
  };
  if (!editable) return <h3 class="detail-title">{label}</h3>;
  return (
    <h3 key={`${task.title}:${version}`} ref={ref} class="detail-title" contentEditable="plaintext-only" role="textbox" aria-label="Title" title="Click to rename"
      onBlur={commit}
      onKeyDown={(event) => {
        const el = event.currentTarget as HTMLElement;
        if (event.key === 'Enter') { event.preventDefault(); el.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; el.blur(); }
      }}>
      {task.title}
    </h3>
  );
}

function hintOf(text: string, phrases: readonly TimePhrase[], used: TimePhrase | undefined): string {
  if (!text.trim()) return 'Type a day or a time';
  if (used) return 'Enter sets it';
  if (phrases.length > 1) return 'Pick the time you mean';
  if (phrases.length === 1) return 'Click the day to use it';
  return 'No time found in it';
}

/** The small field under the time chip. */
function TimeField(props: { task: Task; onDone: () => void }) {
  const { task } = props;
  const [text, setText] = useState('');
  const [choice, setChoice] = useState(NO_CHOICE);
  const [busy, setBusy] = useState(false);
  const zone = dayZone.value;
  const now = Date.now();
  const phrases = findTimes(text, now, zone);
  const used = usedPhrase(phrases, choice);
  const save = async (phrase: TimePhrase | null) => {
    setBusy(true);
    const ok = await setTime(task, timePatch(task, phrase, zone));
    setBusy(false);
    if (ok) props.onDone();
  };
  return (
    <form class="time-field" onSubmit={(event) => { event.preventDefault(); if (used && !busy) void save(used); }}>
      <input class="input" type="text" value={text} maxLength={200} autoFocus disabled={busy} aria-label="New time"
        placeholder="Tomorrow 15:00 · Fri · /9:30"
        onInput={(event) => { setText((event.currentTarget as HTMLInputElement).value); }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); props.onDone(); } }} />
      <div class="time-field-chips">
        {used && (
          <span class="task-chip when">{phraseText(used, now, zone)}
            <button type="button" class="task-chip-x" aria-label="Not this time" title="Not this time" onClick={() => setChoice(drop(choice, used))}>×</button>
          </span>
        )}
        {phrases.filter((phrase) => phrase !== used).map((phrase) => (
          <button key={`${phrase.start}:${phrase.text}`} type="button" class="task-chip open" title="Set this time" disabled={busy} onClick={() => void save(phrase)}>
            {phraseText(phrase, now, zone)}
          </button>
        ))}
        <span class="task-input-hint">{hintOf(text, phrases, used)}</span>
      </div>
      <div class="w-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!used}>Set</Button>
        {task.at !== undefined && <Button type="button" variant="ghost" disabled={busy} onClick={() => void save(null)}>No time</Button>}
      </div>
    </form>
  );
}

/** The to-do's time as a chip; for a person's open to-do a click opens the time field under it. */
export function TimeChip(props: { task: Task; now: number; editable: boolean }) {
  const { task } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const when = whenOf(task, props.now, dayZone.value);
  const tone = `task-chip${when ? ` when${when.late ? ' late' : ''}` : ''}`;
  const text = when ? when.text : 'no time';
  if (!props.editable) return when ? <span class={tone}>{text}</span> : null;
  return (
    <>
      <button ref={ref} type="button" class={`${tone} time`} aria-haspopup="dialog" aria-expanded={open} title="Set the time" onClick={() => setOpen(!open)}>{text}</button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="bottom-start" class="time-pop" label="Time" width={300}>
        <TimeField task={task} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}
