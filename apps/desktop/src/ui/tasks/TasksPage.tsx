// The Tasks page (Quests round 20.11.2026; owner 19.11.2026: "das alles in einen bringen"): one page instead of My
// day and Work. Its head names the day ("Friday, November 20") with ‹ › before it (they never move) and Day | Week
// (one column: List | Calendar). The list: the input line, on a phone or in the side pane the quests as chips, "For
// you", "Done today" and "At work"; beside it the calendar, or the open to-do's or quest's detail in its place – the
// list never moves. One column (a phone, the side pane, a narrow window) shows the list or the calendar, and a detail
// as a view of its own with ×. The main zone's selection and day live in the route (page-state.ts), the pane's in the
// pane. The quest column is the sidebar on a computer (QuestNav.tsx).
// Owns: the page's layout and what it hands its parts. Never: data of its own (page-data.ts, lib/store.ts,
// lib/day-store.ts) or the parts' markup.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Task } from '../../shared/model/tasks.ts';
import { wallOf, wallTime } from '../../shared/text/when.ts';
import { calendarWindow, dayClock, dayRange, dayZone, loadDay } from '../lib/day-store.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { Header } from '../lib/header.tsx';
import { isMobile, todoClock, todos } from '../lib/store.ts';
import { IconButton } from '../lib/ui.tsx';
import { AtWork } from './AtWork.tsx';
import { weekOf } from './calendar-model.ts';
import { hiddenSources, watchSources } from './calendar-sources.ts';
import { ForYou } from './ForYou.tsx';
import { finished, runningTasks, taskIndex, watchFinished } from './page-data.ts';
import { atWork, childrenOf, questLines, type QuestLine } from './page-model.ts';
import { calendarSpan, closeDetail, oneColumn, openDetail, otherOnly, routePart, selected, showDay, shownDay, type PageScope } from './page-state.ts';
import { QuestDetail } from './QuestDetail.tsx';
import { startQuest } from './QuestNav.tsx';
import { ensureSchedules, schedules } from './schedules.ts';
import { TaskCalendar } from './TaskCalendar.tsx';
import { TaskInput } from './TaskInput.tsx';
import { useTask } from './task-cache.ts';
import { searchHits, searchState, taskSearch, useFound } from './task-search.ts';
import { taskMenu } from './task-menu.ts';
import { asView, TodoDetail } from './TodoDetail.tsx';
import { TodoRow } from './TodoRow.tsx';
import { headTitle, shiftDate } from './when-text.ts';

/** Wide enough for the list and the calendar side by side. */
const WIDE_PX = 720;

function useWide(root: { current: HTMLElement | null }, allowed: boolean): boolean {
  const [wide, setWide] = useState(allowed);
  useEffect(() => {
    const el = root.current;
    if (!el || !allowed) { setWide(false); return; }
    const measure = () => setWide(el.clientWidth >= WIDE_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [allowed]);
  return wide;
}

/** ‹ › before the day (they never move), the day (a click: back to today), and the view switch at the end. */
function Head(props: { scope: PageScope; date: string; today: string; wide: boolean }) {
  const week = props.wide && calendarSpan.value === 'week';
  const step = week ? 7 : 1;
  const go = (date: string) => showDay(props.scope, date === props.today ? null : date);
  const seg = props.wide ? (['day', 'week'] as const) : (['list', 'calendar'] as const);
  const current = props.wide ? calendarSpan.value : oneColumn.value;
  return (
    <span class="tasks-head">
      <IconButton icon="caret-left" size="small" label={week ? 'Previous week' : 'Previous day'} onClick={() => go(shiftDate(props.date, -step))} />
      <IconButton icon="caret-right" size="small" label={week ? 'Next week' : 'Next day'} onClick={() => go(shiftDate(props.date, step))} />
      <button type="button" class="tasks-date" disabled={props.date === props.today} title={props.date === props.today ? undefined : 'Back to today'} onClick={() => go(props.today)}>
        <h2 class="frame-header-text">{headTitle(props.date)}</h2>
      </button>
      <span class="tasks-seg" role="tablist" aria-label="Show">
        {seg.map((value) => (
          <button key={value} type="button" role="tab" aria-selected={current === value} class={current === value ? 'on' : ''}
            onClick={() => { if (props.wide) calendarSpan.value = value as 'day' | 'week'; else oneColumn.value = value as 'list' | 'calendar'; }}>
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </span>
    </span>
  );
}

/** A quest as a chip: a click opens it, a long press or right-click its menu (task-menu.ts). */
function QuestChip(props: { scope: PageScope; line: QuestLine }) {
  const { line } = props;
  const menu = useContextMenu(() => taskMenu(asView(line.quest), props.scope));
  return (
    <button type="button" class="quest-chip" style={{ '--qc': `var(--wf-c${line.hue})` }} onClick={() => openDetail(props.scope, line.quest.id)} {...menu}>
      <span class="task-dot" aria-hidden="true" />{line.quest.title}
    </button>
  );
}

/** On a phone and in the pane (no quest column): the quests with the person's to-dos as chips, Other, and + Quest. */
function QuestChips(props: { scope: PageScope; index: ReadonlyMap<string, Task> }) {
  const lists = questLines(props.index);
  return (
    <div class="quest-chips">
      {lists.withYou.map((line) => <QuestChip key={line.quest.id} scope={props.scope} line={line} />)}
      {lists.other > 0 && <button type="button" class="quest-chip" aria-pressed={otherOnly.value} onClick={() => { otherOnly.value = !otherOnly.value; }}>Other</button>}
      <button type="button" class="quest-chip add" onClick={() => startQuest(props.scope)}>+ Quest</button>
    </div>
  );
}

/** While the search holds words: what it finds, in place of For you and At work. */
function Found(props: { scope: PageScope; index: ReadonlyMap<string, Task>; selected: string | null; now: number }) {
  const query = taskSearch.value.query;
  const hits = searchHits(props.index.values(), useFound(query), query);
  return (
    <>
      <h3 class="tasks-sec">Found <span class="tabular">{hits.length}</span></h3>
      <ul class="todo-rows" aria-label="Found">
        {hits.map((task) => {
          const quest = task.parentId ? props.index.get(task.parentId) : undefined;
          return <TodoRow key={task.id} task={task} scope={props.scope} quest={quest?.kind === 'quest' ? quest : undefined} now={props.now} selected={props.selected === task.id} />;
        })}
        {!hits.length && <li class="tasks-empty">Nothing found.</li>}
      </ul>
    </>
  );
}

export function TasksPage(props: { scope?: PageScope }) {
  const scope = props.scope ?? 'main';
  const root = useRef<HTMLDivElement>(null);
  const phone = isMobile.value;
  const wide = useWide(root, !phone && scope === 'main');
  void todoClock.value; void dayClock.value; // re-read when either clock moves
  const now = Date.now();
  const zone = dayZone.value;
  const today = wallOf(now, zone).date;
  const date = shownDay(scope) ?? today;
  const dayStart = wallTime(today, 0, zone);
  const dayEnd = wallTime(shiftDate(today, 1), 0, zone);
  useEffect(() => watchFinished(dayStart), [dayStart]);
  useEffect(() => { ensureSchedules(); return watchSources(); }, []);
  useEffect(() => { // the week of the shown day (the day view and the week view read it)
    const range = dayRange(weekOf(date)[0], zone, 7);
    const window = calendarWindow.peek();
    if (!window || window.from > range.from || window.to < range.to) void loadDay(range);
  }, [date, zone]);

  const index = taskIndex.value;
  const children = useMemo(() => childrenOf(index), [index]);
  const open = selected(scope);
  const fetched = useTask(open ?? undefined);
  const openTask = open ? index.get(open) ?? fetched : undefined;
  const owner = scope === 'main' ? routePart().owner : undefined;
  const groups = useMemo(() => atWork(index, runningTasks.value, schedules.value, dayStart, owner, children), [index, runningTasks.value, schedules.value, dayStart, owner, children]);
  const windowTasks = calendarWindow.value?.list.tasks;
  const lookup = (id: string) => index.get(id) ?? windowTasks?.find((task) => task.id === id);
  const questOpen = openTask?.kind === 'quest' ? openTask : undefined;
  const parent = openTask?.parentId ? index.get(openTask.parentId) : undefined;

  const close = () => closeDetail(scope);
  const searching = scope === 'main' && taskSearch.value.query.trim() !== '';
  const detail = open && (questOpen
    ? <QuestDetail scope={scope} quest={questOpen} todos={children.get(questOpen.id) ?? []} schedules={schedules.value} now={now} onClose={close} />
    : <TodoDetail key={open} scope={scope} task={openTask} quest={parent?.kind === 'quest' ? parent : undefined} now={now} onClose={close} />);
  const calendar = (
    <TaskCalendar scope={scope} date={date} today={today} span={wide ? calendarSpan.value : 'day'} lookup={lookup} hidden={hiddenSources.value} now={now} {...(questOpen ? { quest: questOpen } : {})} />
  );
  const list = (
    <section class="tasks-list" aria-label="Tasks">
      <TaskInput scope={scope} {...(questOpen ? { quest: questOpen } : {})} onLeaveQuest={close} />
      {(phone || scope === 'pane') && <QuestChips scope={scope} index={index} />}
      {searching ? <Found scope={scope} index={index} selected={open} now={now} /> : (
        <>
          <ForYou scope={scope} todos={todos.value} finished={finished.value} index={index} selected={open} now={now} dayStart={dayStart} dayEnd={dayEnd} />
          <AtWork scope={scope} groups={groups} schedules={schedules.value} index={index} {...(owner ? { owner } : {})} now={now} />
        </>
      )}
    </section>
  );
  const head = <Head scope={scope} date={date} today={today} wide={wide} />;
  const single = !wide;
  return (
    <div ref={root} class={`tasks-page${wide ? ' wide' : ' narrow'}${scope === 'pane' ? ' in-pane' : ''}`}>
      {scope === 'main' && !phone ? <Header zone="main" class="tasks-header" title={head} search={searchState()} />
        : !(phone && single && detail) && <div class="tasks-toolbar">{head}</div>}
      <div class="tasks-cols">
        {single
          ? (detail ? <div class="tasks-side single">{detail}</div> : oneColumn.value === 'calendar' ? <div class="tasks-side single">{calendar}</div> : list)
          : <>{list}<aside class="tasks-side" aria-label={open ? 'Detail' : 'Calendar'}>{detail || calendar}</aside></>}
      </div>
    </div>
  );
}
