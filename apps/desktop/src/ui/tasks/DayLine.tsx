// The Tasks page's head (owner 23.11.2026: "‹ 14 15 16 17 ›" right under the title, two clear symbols beside it, a
// button for a small month): the day line – as many days as fit, each a circle under its weekday, today marked, the
// chosen day filled, a dot under a day that holds an event or a to-do of the person's; ‹ › page the line by a whole line,
// a tap chooses the day (today: the page's own day again). The month button ("Nov") opens a small month with its own
// ‹ ›; a tap on a day chooses it and puts the line around it, "Today" goes back. At the end the view: on one column
// Tasks (the list: what runs now and what is due that day) | Calendar (the day's hours) as two symbols, on a wide page
// (both side by side) Day | Week.
// Mika's review 23.11.2026 (390 px): every control a 44 × 44 target on touch without a taller line (tasks-page.css), a
// day's column tappable whole and its dot said in words ("…, has entries"), the chosen view not by its white alone (an
// accent and a mark under the symbol); the small month with ×, its days' dots and Today as a real button. How many days
// fit is measured on a day's own width, so larger letters show fewer days rather than breaking the line.
// Owns: the head's markup and its popover. Never: which days it shows or the month's grid (day-strip.ts), the dots'
// rule (day-preview.ts), or the page state (page-state.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import { dayRange, dayZone, listEvents } from '../lib/day-store.ts';
import { Popover } from '../lib/popover.tsx';
import { Icon, IconButton } from '../lib/ui.tsx';
import { hiddenSources } from './calendar-sources.ts';
import { busyDays } from './day-preview.ts';
import { dayCount, dayLabel, monthGrid, monthOf, monthShort, monthTitle, pageLine, shiftMonth, WEEKDAY_SHORT } from './day-strip.ts';
import { calendarSpan, linePaged, oneColumn, showDay, type PageScope } from './page-state.ts';
import { headTitle, weekdayOf } from './when-text.ts';

export interface DayLineProps {
  scope: PageScope;
  /** The chosen day and the person's today (YYYY-MM-DD). */
  date: string;
  today: string;
  /** The line's days (day-strip.ts lineDays) and which of them hold something. */
  days: readonly string[];
  busy: ReadonlySet<string>;
  wide: boolean;
  /** How many days fit, measured on the line (day-strip.ts dayCount). */
  onCount: (count: number) => void;
}

const MONTH_HEAD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** The days of `month`'s grid that hold something: the line's ones at once, the rest once calendar.list answers. */
function useMonthBusy(month: string, known: ReadonlySet<string>): ReadonlySet<string> {
  const zone = dayZone.value;
  const [read, setRead] = useState<{ month: string; days: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    let live = true;
    const dates = monthGrid(month).flat().map((day) => day.date);
    void listEvents(dayRange(dates[0], zone, dates.length)).then((events) => {
      if (live) setRead({ month, days: busyDays(events, dates, zone, hiddenSources.peek()) });
    });
    return () => { live = false; };
  }, [month, zone]);
  return read?.month === month ? new Set([...known, ...read.days]) : known;
}

/** The small month: its own ‹ › and ×, six weeks Monday first with their dots, Today at its foot. */
function MonthPop(props: { scope: PageScope; date: string; today: string; busy: ReadonlySet<string>; anchor: HTMLElement | null; onClose: () => void }) {
  const [month, setMonth] = useState(monthOf(props.date));
  const busy = useMonthBusy(month, props.busy);
  const choose = (date: string) => {
    showDay(props.scope, date === props.today ? null : date);
    linePaged[props.scope].value = null;
    props.onClose();
  };
  return (
    <Popover anchor={props.anchor} open onClose={props.onClose} placement="bottom-end" class="month-pop" label="Choose a day">
      <div class="month-head">
        <span class="month-title" aria-live="polite">{monthTitle(month)}</span>
        <IconButton icon="caret-left" size="small" label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} />
        <IconButton icon="caret-right" size="small" label="Next month" onClick={() => setMonth(shiftMonth(month, 1))} />
        <IconButton icon="x" size="small" class="month-close" label="Close" onClick={props.onClose} />
      </div>
      <div class="month-grid" role="grid" aria-label={monthTitle(month)}>
        <div class="month-week" role="row">{MONTH_HEAD.map((word) => <span key={word} class="month-wd" role="columnheader">{word}</span>)}</div>
        {monthGrid(month).map((week) => (
          <div key={week[0].date} class="month-week" role="row">
            {week.map((day) => (
              <button key={day.date} type="button" role="gridcell" aria-selected={day.date === props.date} aria-label={dayLabel(day.date, props.today, busy.has(day.date))}
                class={`month-day${day.inMonth ? '' : ' out'}${day.date === props.today ? ' today' : ''}${day.date === props.date ? ' on' : ''}`}
                onClick={() => choose(day.date)}>
                <span class="month-day-n">{Number(day.date.slice(8))}</span>
                <i class={busy.has(day.date) ? 'day-dot-busy' : 'day-dot-free'} aria-hidden="true" />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div class="month-foot">
        <button type="button" class="button secondary month-today" onClick={() => choose(props.today)}>Today</button>
      </div>
    </Popover>
  );
}

export function DayLine(props: DayLineProps) {
  const { scope, date, today, days } = props;
  const strip = useRef<HTMLDivElement>(null);
  const [monthAnchor, setMonthAnchor] = useState<HTMLElement | null>(null);
  const onCount = useRef(props.onCount);
  onCount.current = props.onCount;
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    // a day's own width (wider with larger letters) – the widest of the shown ones
    const slot = () => Math.max(0, ...[...el.children].map((child) => (child as HTMLElement).offsetWidth));
    const measure = () => onCount.current(dayCount(el.clientWidth, slot()));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [days[0]]);
  const page = (direction: -1 | 1) => { linePaged[scope].value = pageLine(days, direction); };
  const tabs = props.wide
    ? ([['day', 'Day'], ['week', 'Week']] as const).map(([value, word]) => (
      <button key={value} type="button" role="tab" aria-selected={calendarSpan.value === value} class={calendarSpan.value === value ? 'on' : ''}
        onClick={() => { calendarSpan.value = value; }}>{word}</button>
    ))
    : ([['list', 'list-checks', 'Tasks'], ['calendar', 'calendar-blank', 'Calendar']] as const).map(([value, icon, word]) => (
      <button key={value} type="button" role="tab" aria-selected={oneColumn.value === value} class={oneColumn.value === value ? 'on' : ''}
        aria-label={word} title={word} onClick={() => { oneColumn.value = value; }}>
        <Icon name={icon} size={18} />
      </button>
    ));
  return (
    <div class="day-line">
      <h2 class="sr-only">{headTitle(date)}</h2>
      <IconButton icon="caret-left" size="small" class="day-line-arrow" label="Earlier days" onClick={() => page(-1)} />
      <div class="day-line-days" ref={strip} role="group" aria-label="Days">
        {days.map((day) => {
          const chosen = day === date;
          return (
            <button key={day} type="button" aria-pressed={chosen} aria-label={dayLabel(day, today, props.busy.has(day))} title={headTitle(day)}
              class={`day-dot${chosen ? ' on' : ''}${day === today ? ' today' : ''}${day < today ? ' past' : ''}`}
              onClick={() => showDay(scope, day === today ? null : day)}>
              <span class="day-dot-wd">{WEEKDAY_SHORT[weekdayOf(day)]}</span>
              <span class="day-dot-n">{Number(day.slice(8))}</span>
              <i class={props.busy.has(day) ? 'day-dot-busy' : 'day-dot-free'} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <IconButton icon="caret-right" size="small" class="day-line-arrow" label="Later days" onClick={() => page(1)} />
      <button type="button" class="day-line-month" aria-haspopup="dialog" aria-expanded={!!monthAnchor} title={`${headTitle(date)} · choose a day`}
        onClick={(event) => setMonthAnchor(monthAnchor ? null : event.currentTarget)}>
        {monthShort(monthOf(date))}<Icon name="caret-down" size={12} />
      </button>
      <span class={`tasks-seg${props.wide ? '' : ' icons'}`} role="tablist" aria-label="Show">{tabs}</span>
      {monthAnchor && <MonthPop scope={scope} date={date} today={today} busy={props.busy} anchor={monthAnchor} onClose={() => setMonthAnchor(null)} />}
    </div>
  );
}
