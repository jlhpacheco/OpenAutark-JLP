// The quest column of the Tasks page (the sidebar on a computer; owner 19.11.2026: "dann wären das verschiedene To-dos
// drin gewesen"): its header – "Quests" with + (the input line then names a new quest) – then "With you": the open
// quests that hold the person's open to-dos, with their count; "Other": the person's to-dos without a quest (a click
// narrows For you to them, again shows all); "AI only": quests where only agents or colleagues have open to-dos, with
// theirs. Each quest has its colour from its id; a click opens it where the calendar is, a right-click its menu
// (task-menu.ts: Rename…, Give to…, Done, Drop, Delete). At the end the connected calendars (on/off each) and "Connect
// a calendar…" (the AI connects it). The header's "Quests" has the page's title size (tasks-page.css .quest-nav-head).
// Owns: this column. Never: the lists' rules (page-model.ts) or header markup (lib/header.tsx).

import { useEffect } from 'preact/hooks';
import type { CalendarSource } from '../../shared/model/calendar.ts';
import type { HeaderProps } from '../lib/header.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import type { MenuSection } from '../lib/popover.tsx';
import { Toggle } from '../settings/controls.tsx';
import { connectCalendarRequest, setUpWithAi } from '../team/set-up-with-ai.ts';
import { setSourceVisible, sources, watchSources } from './calendar-sources.ts';
import { taskIndex } from './page-data.ts';
import { questLines, type QuestLine } from './page-model.ts';
import { lineOf, openDetail, otherOnly, selected, type PageScope } from './page-state.ts';
import { taskMenu } from './task-menu.ts';
import { asView } from './TodoDetail.tsx';

/** "+": the main page's input line names a new quest. */
export function startQuest(scope: PageScope): void {
  const line = lineOf(scope);
  line.questMode.value = true;
  line.field.current?.focus();
}

/** The quest column's header data: "Quests" and its +. */
export function questNavHeader(): HeaderProps {
  return { title: 'Quests', class: 'quest-nav-head', cells: [{ id: 'new-quest', icon: 'plus', label: 'New quest', onClick: () => startQuest('main') }] };
}

const connect = () => void setUpWithAi(connectCalendarRequest());
const connectItem = { label: 'Connect a calendar…', onSelect: connect };

function sourceMenu(source: CalendarSource): MenuSection[] {
  const needs = source.status === 'reconnect' || source.status === 'error';
  return [{ items: [...(needs ? [{ label: 'Reconnect…', onSelect: () => void setUpWithAi(`Reconnect the calendar "${source.label}" to the Tasks page. `) }] : []), connectItem] }];
}

const STATUS: Partial<Record<CalendarSource['status'], string>> = { error: 'Sync failed', reconnect: 'Needs a new sign-in', syncing: 'Syncing…' };

function SourceRow(props: { source: CalendarSource }) {
  const { source } = props;
  const menu = useContextMenu(() => sourceMenu(source));
  return (
    <li class="quest-source" {...menu}>
      <span class="task-dot" style={source.color ? { background: source.color } : undefined} aria-hidden="true" />
      <span class="quest-source-text">{source.label}{STATUS[source.status] && <span class="quest-source-status">{STATUS[source.status]}</span>}</span>
      <Toggle checked={source.visible} label={`Show ${source.label}`} onChange={(visible) => void setSourceVisible(source, visible)} />
    </li>
  );
}

function QuestItem(props: { line: QuestLine; mine: boolean; open: boolean }) {
  const { line } = props;
  const menu = useContextMenu(() => taskMenu(asView(line.quest), 'main'));
  return (
    <button type="button" class={`quest-item${props.mine ? '' : ' ai'}`} aria-current={props.open ? 'page' : undefined}
      style={{ '--qc': `var(--wf-c${line.hue})` }} onClick={() => openDetail('main', line.quest.id)} {...menu}>
      <span class="task-dot" aria-hidden="true" />
      <span class="quest-name">{line.quest.title}</span>
      <span class={`quest-count tabular${props.mine ? ' you' : ''}`}>{props.mine ? line.mine : line.open}</span>
    </button>
  );
}

export function QuestNav() {
  useEffect(() => watchSources(), []);
  const lists = questLines(taskIndex.value);
  const open = selected('main');
  const menu = useContextMenu(() => [{ items: [{ label: 'New quest', onSelect: () => startQuest('main') }, connectItem] }]);
  return (
    <div class="sidebar-section quest-nav" {...menu}>
      <h3 class="quest-label">With you</h3>
      {lists.withYou.map((line) => <QuestItem key={line.quest.id} line={line} mine open={open === line.quest.id} />)}
      <button type="button" class="quest-item" aria-pressed={otherOnly.value} onClick={() => { otherOnly.value = !otherOnly.value; }}>
        <span class="task-dot" aria-hidden="true" />
        <span class="quest-name">Other</span>
        <span class="quest-count tabular">{lists.other}</span>
      </button>
      {lists.aiOnly.length > 0 && <h3 class="quest-label">AI only</h3>}
      {lists.aiOnly.map((line) => <QuestItem key={line.quest.id} line={line} mine={false} open={open === line.quest.id} />)}
      {sources.value.length > 0 && (
        <>
          <h3 class="quest-label">Calendars</h3>
          <ul class="quest-sources">{sources.value.map((source) => <SourceRow key={source.id} source={source} />)}</ul>
        </>
      )}
      <button type="button" class="sidebar-action" onClick={connect}>Connect a calendar…</button>
    </div>
  );
}
