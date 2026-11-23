// Settings › Calendar › Tasks (settings.day): the person's working hours – "Later › Tomorrow" starts at work start, the
// calendar's free gaps and the team's availability read them. Quests round 20.11.2026: the morning plan and the agents'
// lane switch went with the day planner (the page shows the AI lane while "At work" is open); B-078 (D17): the buffer
// between blocks and "AI helps" stay settings.json keys without a row; keeping the PC awake is Settings › General "Keep
// the screen on while agents work". A phone may not change 'day' settings unless it is the owner's securely paired
// settings device.
// Owns: these rows and their mapping onto settings.day. Never: invents options without effect.

import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { canEditOwnerSettings, HTTPS_NOTE, PC_NOTE, session } from '../lib/session.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { hoursProblem } from './calendar-model.ts';
import { act, Group, Row, TextField } from './controls.tsx';

export function DayGroup() {
  const value = settings.value;
  if (!value) return null;
  const day = daySettingsOf(value);
  const locked = !canEditOwnerSettings();
  const lockNote = session.value?.kind === 'device' && session.value.capabilities.includes('settings') && !session.value.secure ? HTTPS_NOTE : PC_NOTE;
  const saveHours = (workStart: string, workEnd: string) => act(async () => {
    const problem = hoursProblem(workStart, workEnd);
    if (problem) throw new Error(problem);
    await updateSettings({ day: { workStart, workEnd } });
  }, 'Could not save');
  return (
    <Group title="Tasks" hint={locked ? lockNote : undefined}>
      <Row label="Working hours">
        <div class="set-inline">
          <TextField type="time" label="Work starts" value={day.workStart} disabled={locked} onCommit={(start) => void saveHours(start, day.workEnd)} />
          <span class="set-suffix">to</span>
          <TextField type="time" label="Work ends" value={day.workEnd} disabled={locked} onCommit={(end) => void saveHours(day.workStart, end)} />
        </div>
      </Row>
    </Group>
  );
}
