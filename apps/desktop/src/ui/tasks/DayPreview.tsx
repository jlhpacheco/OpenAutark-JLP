// On the Tasks page's list (owner 23.11.2026): "Next" on today – the next appointments as short lines at the top (a run
// of close ones all of them, day-preview.ts nextUp); a tap on a to-do opens its detail, on an event shows the calendar.
// And a day of its own (another day chosen in the day line): what is on it in order – an event, a to-do of the person's
// (a done one ✓), an agent's note, each with its mark and word (Mika's review 23.11.2026: the kind never by colour
// alone), a to-do's quest by its dot and name – a tap on a to-do opens it; its heading counts the lines (none: no
// number) and carries "Today" back. A past day is only read: no input line, "Read only" beside its count.
// Owns: these two sections' markup. Never: which lines they hold (day-preview.ts) or the page state.

import { agentName } from '../lib/store.ts';
import { Icon } from '../lib/ui.tsx';
import { dayHead, type AgendaLine, type NextLine } from './day-preview.ts';
import { backToToday, oneColumn, openDetail, type PageScope } from './page-state.ts';
import { headTitle } from './when-text.ts';

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

/** What a line is, said in a word (the mark's meaning, never by colour alone – Mika's review 23.11.2026). */
const KIND_WORD: Record<AgendaLine['kind'], string> = { event: 'Event', todo: 'To-do', done: 'Done', ai: 'Agent' };

/** The line's mark: an event's calendar, a to-do's ring (a done one ticked, as on its row), an agent's spark. */
function KindMark(props: { kind: AgendaLine['kind'] }) {
  const word = KIND_WORD[props.kind];
  return (
    <span class={`day-item-mark ${props.kind}`} title={word}>
      {props.kind === 'event' ? <Icon name="calendar-blank" size={15} />
        : props.kind === 'ai' ? <Icon name="sparkle" size={15} />
          : <span class="day-item-ring">{props.kind === 'done' && <Icon name="check" size={10} />}</span>}
      <span class="sr-only">{word}: </span>
    </span>
  );
}

export function DayList(props: { scope: PageScope; date: string; today: string; lines: readonly AgendaLine[] }) {
  const head = dayHead(props.date, props.today, props.lines.length);
  const past = props.date < props.today;
  return (
    <>
      <h3 class="tasks-sec day-list-head">
        <span class="day-list-title">{head.text}</span>
        {head.count !== null && <span class="tabular">{head.count}</span>}
        {head.readOnly && <span class="day-list-ro">Read only</span>}
        <button type="button" class="day-list-today" onClick={() => backToToday(props.scope)}>Today</button>
      </h3>
      <ul class="day-list" aria-label={headTitle(props.date)}>
        {props.lines.map((line) => (
          <li key={line.id}>
            <button type="button" class={`day-line-item ${line.kind}`} disabled={!line.taskId}
              onClick={() => { if (line.taskId) openDetail(props.scope, line.taskId); }}>
              <span class="day-item-time tabular">{line.time}</span>
              <KindMark kind={line.kind} />
              <span class="day-item-text">
                <span class="day-item-title">{line.title}</span>
                {(line.quest || line.who) && (
                  <span class="day-item-who">
                    {line.quest && <span class="todo-quest" style={{ '--qc': `var(--wf-c${line.hue || 0})` }}><span class="task-dot" aria-hidden="true" />{line.quest}</span>}
                    {line.who && <span>{agentName(line.who)}</span>}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
        {!props.lines.length && <li class="tasks-empty">{past ? 'Nothing was on this day.' : 'Nothing on this day yet.'}</li>}
      </ul>
    </>
  );
}
