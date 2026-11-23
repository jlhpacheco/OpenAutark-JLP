// Chat details › Scheduled: this chat's two kinds of schedules (schedules.list by conversation; Quests round 20.11.2026) –
// a message sent later ("Send later", once or repeating) and an agent's reminder (its own note at a time) – each one row:
// the title, the rule in words when it repeats ("Every Monday at 09:00"), the next run or its state (No next run · Paused
// · Ended – the one rule of tasks/schedule-state.ts), the level when not Normal, whose it is. The row's right-click menu:
// Pause/Resume, Edit (the person's own scheduled message: the composer opens in schedule mode with it,
// composer/schedule-mode.ts) and Delete. A message is scheduled from the composer ("Schedule…"); an agent sets up its own
// ("send this every Monday at 9"). Kept fresh by schedule.upserted / schedule.removed events and loaded again after every
// reconnect (lib/use-load.ts).
// Owns: the list. Never: builds specs or creates schedules.

import { useEffect, useState } from 'preact/hooks';
import type { Schedule } from '../../../shared/model/tasks.ts';
import { fullDate, locale, resetTime, time } from '../../lib/format.ts';
import { errorText, rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { agentName, isMobile } from '../../lib/store.ts';
import { setChatPanel } from '../../lib/shell-state.ts';
import { toastError } from '../../lib/toasts.ts';
import { confirm, Icon, Spinner } from '../../lib/ui.tsx';
import type { IconName } from '../../lib/ui.tsx';
import { useLoad } from '../../lib/use-load.ts';
import { useContextMenu } from '../../lib/context-menu.tsx';
import { editableSchedule } from '../composer/schedule-form.ts';
import { editSchedule, localZone } from '../composer/schedule-mode.ts';
import { repeats, ruleLine } from '../composer/schedule-rule.ts';
import { byNextRun, scheduleState, type ScheduleState } from '../../tasks/schedule-state.ts';

/** The meta line of a schedule without a next run (the one state rule: tasks/schedule-state.ts). */
export const STATE_TEXT: Record<Exclude<ScheduleState, 'next'>, string> = { none: 'No next run', paused: 'Paused', ended: 'Ended' };

const KIND: Record<Schedule['kind'], { icon: IconName; label: string }> = {
  message: { icon: 'chat-text', label: 'Send later' },
  reminder: { icon: 'bell', label: 'Reminder' },
};

const weekdayTime = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Today → '18:00', this week → 'Mon 18:00', later → '20 Oct, 18:00'. */
export function whenText(ms: number, now = Date.now()): string {
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return time(ms);
  if (ms > now && ms - now < 6 * 86_400_000) return weekdayTime.format(ms);
  return resetTime(ms);
}

function useChatSchedules(conversationId: string, allowed: boolean) {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setList(null), [conversationId]); // another chat: never the last one's rows
  useLoad(() => {
    if (!allowed) return;
    let alive = true;
    rpc.call('schedules.list', { conversationId })
      .then((items) => { if (alive) { setList(items); setError(null); } })
      .catch((err) => { if (alive) setError(errorText(err)); });
    const offUpsert = rpc.on('schedule.upserted', (schedule) => {
      if (schedule.conversationId !== conversationId) return;
      setList((current) => [...(current ?? []).filter((entry) => entry.id !== schedule.id), schedule]);
    });
    const offRemove = rpc.on('schedule.removed', ({ id }) => setList((current) => current?.filter((entry) => entry.id !== id) ?? current));
    return () => { alive = false; offUpsert(); offRemove(); };
  }, [conversationId, allowed]);
  return { list, error };
}

function ScheduleRow(props: { schedule: Schedule }) {
  const { schedule } = props;
  const kind = KIND[schedule.kind] ?? KIND.message;
  const run = async (action: () => Promise<unknown>, failTitle: string) => {
    try { await action(); } catch (error) { toastError(error, failTitle); }
  };
  const remove = async () => {
    if (!await confirm({ title: 'Delete schedule?', body: schedule.title, confirmLabel: 'Delete', danger: true })) return;
    await run(() => rpc.call('schedules.delete', { id: schedule.id }), 'Could not delete');
  };
  const setActive = (active: boolean) => void run(() => rpc.call('schedules.update', { id: schedule.id, active }), active ? 'Could not resume' : 'Could not pause');
  const edit = () => {
    if (!editSchedule(schedule)) return;
    if (isMobile.value && schedule.conversationId) setChatPanel(schedule.conversationId, null); // the phone's sheet covers the composer
  };
  const menu = useContextMenu(() => [{
    items: [
      ...(can('schedules.update') ? [{ label: schedule.active ? 'Pause' : 'Resume', onSelect: () => setActive(!schedule.active) }] : []),
      ...(can('schedules.update') && editableSchedule(schedule, Date.now(), localZone()) ? [{ label: 'Edit', onSelect: edit }] : []),
      ...(can('schedules.delete') ? [{ label: 'Delete', danger: true, onSelect: () => void remove() }] : []),
    ],
  }]);
  const owner = schedule.ownerId === 'human' ? undefined : agentName(schedule.ownerId);
  const state = scheduleState(schedule);
  return (
    <li class={`details-schedule${schedule.active ? '' : ' is-paused'}`} {...menu}>
      <Icon name={kind.icon} size={16} title={kind.label} />
      <div class="details-schedule-text">
        <span class="details-schedule-title">{schedule.title}</span>
        {repeats(schedule.spec) && <span class="details-schedule-rule">{ruleLine(schedule.spec, { tz: schedule.spec.tz || localZone() })}</span>}
        <span class="details-schedule-meta tabular">
          {state === 'next'
            ? <time dateTime={new Date(schedule.nextAt!).toISOString()} title={fullDate(schedule.nextAt!)}>Next {whenText(schedule.nextAt!)}</time>
            : STATE_TEXT[state] /* B-080: a stopped schedule nobody paused has used up its runs */}
          {schedule.payload.silent ? ' · Silent' : schedule.payload.priority === 'important' && ' · Important'}
          {owner && ` · ${owner}`}
        </span>
      </div>
    </li>
  );
}

export function Schedules(props: { conversationId: string }) {
  const allowed = can('schedules.list');
  const { list, error } = useChatSchedules(props.conversationId, allowed);
  if (!allowed) return null;
  // by the next run only: pausing keeps it, so a row stays where it was when it is paused or resumed from its menu
  const all = (list ?? []).slice().sort(byNextRun);
  return (
    <section class="details-section" aria-label="Scheduled">
      <h3 class="details-heading">Scheduled</h3>
      {error && <p class="details-note">{error}</p>}
      {!error && list === null && <Spinner size={14} />}
      {list !== null && !all.length && <p class="details-note">Nothing scheduled. Use Schedule… in the composer, or ask an agent.</p>}
      {all.length > 0 && <ul class="details-schedules">{all.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} />)}</ul>}
      {all.length > 0 && <p class="details-note">Right-click a row to pause, edit or delete it.</p>}
    </section>
  );
}
