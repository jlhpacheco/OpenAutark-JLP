// On the Tasks page's list (owner 23.11.2026): "Next" on today – the next appointments as short lines at the top (a run
// of close ones all of them, day-preview.ts nextUp); a tap on a to-do opens its detail, on an event shows the calendar.
// And a day of its own (another day chosen in the day line): what is on it in order – an event, a to-do of the person's
// (a done one ✓), an agent's note – a tap on a to-do opens it. A past day is only read: the page shows no input line for it.
// Owns: these two sections' markup. Never: which lines they hold (day-preview.ts) or the page state.

import { agentName } from '../lib/store.ts';
import type { AgendaLine, NextLine } from './day-preview.ts';
import { oneColumn, openDetail, type PageScope } from './page-state.ts';
import { dayWord, headTitle } from './when-text.ts';

export function NextUp(props: { scope: PageScope; lines: readonly NextLine[]; wide: boolean }) {
  if (!props.lines.length) return null;
  const open = (line: NextLine) => {
    if (line.taskId) openDetail(props.scope, line.taskId);
    else if (!props.wide) oneColumn.value = 'calendar';
  };
  return (
    <section class="next-up" aria-label="Next">
      <h3 class="next-up-head">Next</h3>
      <ul class="next-up-lines">
        {props.lines.map((line) => (
          <li key={line.id}>
            <button type="button" class={`next-line ${line.kind}${line.now ? ' now' : ''}`} title={`${line.when} ${line.title}`} onClick={() => open(line)}>
              <span class="next-when tabular">{line.when}</span>
              <span class="next-title">{line.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DayList(props: { scope: PageScope; date: string; today: string; lines: readonly AgendaLine[] }) {
  const word = dayWord(props.date, props.today);
  const title = headTitle(props.date);
  const past = props.date < props.today;
  return (
    <>
      <h3 class="tasks-sec day-list-head">
        {['Tomorrow', 'Yesterday'].includes(word) ? `${word} · ${title}` : title}
        <span class="tabular">{props.lines.length}</span>
      </h3>
      <ul class="day-list" aria-label={title}>
        {props.lines.map((line) => (
          <li key={line.id}>
            <button type="button" class={`day-line-item ${line.kind}`} disabled={!line.taskId} style={{ '--qc': line.hue ? `var(--wf-c${line.hue})` : 'var(--muted)' }}
              onClick={() => { if (line.taskId) openDetail(props.scope, line.taskId); }}>
              <span class="day-item-time tabular">{line.time || '–'}</span>
              <span class="day-item-mark" aria-hidden="true" />
              <span class="day-item-text">
                <span class="day-item-title">{line.kind === 'done' ? '✓ ' : ''}{line.title}</span>
                {line.who && <span class="day-item-who">{agentName(line.who)}</span>}
              </span>
            </button>
          </li>
        ))}
        {!props.lines.length && <li class="tasks-empty">{past ? 'Nothing was on this day.' : 'Nothing on this day yet.'}</li>}
      </ul>
    </>
  );
}
