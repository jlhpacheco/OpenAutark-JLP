// What one line of the chat's live bar shows when the person opens it with its ▾ (owner 19.11.2026: "dass ich das ein
// bisschen aufklappen kann und dann ein bisschen rumscrollen kann … wo ich dann sehe, was die KI gerade arbeitet und
// gemacht hat … und wenn man das offen hat, dann kann man direkt den Button klicken, um zu sehen, was die KI gerade
// macht"): the run's recent steps as the activity log draws them (team/run-items.tsx – live over runs:<agentId>, the
// newest at the bottom, a short box that scrolls) and "Watch live", which opens that agent's own area (its browser,
// live – workspace/pages.ts openAgentBrowser) in this chat's side pane, or on a phone in the chat's sheet. A run on
// another of the person's PCs keeps its journal there, so its box says so. The box keeps to the bottom while the
// person has not scrolled up. 20.11.2026 (the working popover's rows moved here): the task the run works on is a link
// beside "Watch live", and a split part's line lists its group's parts below its steps (splits/SplitRows.tsx – each opens
// to its own steps; for whoever may read splits).
// Owns: that box. Never: loads anything while closed, or shows more than the run journaled.

import { useEffect, useRef } from 'preact/hooks';
import type { LiveRun } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { UNKNOWN_TASK, taskTitle } from '../lib/chat-naming.ts';
import { can } from '../lib/session.ts';
import { RunItemList, useRunItems } from '../team/run-items.tsx';
import { SplitGroupRows } from '../splits/SplitRows.tsx';
import { openTaskDetail } from '../tasks/jump.ts';
import { openAgentBrowser } from '../workspace/pages.ts';
import { pcLabel, watchPcs } from '../team/runs-on.ts';

/** The newest steps the box draws ("+N earlier steps" above them opens the rest). */
const WINDOW = 40;

export function LiveBarMore(props: { run: LiveRun; name: string }) {
  const { run, name } = props;
  const here = !run.deviceId;
  watchPcs(); // 21.11.2026: the note names the PC the run is on
  const task = run.taskId && can('tasks.get') ? run.taskId : undefined;
  const { items, error } = useRunItems(run.runId, run.agentId, { enabled: here, live: true });
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [items?.length]);
  const onScroll = () => {
    const el = box.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return (
    <div class="live-bar-more" id={`live-more-${run.runId}`}>
      <div class="live-bar-steps" ref={box} onScroll={onScroll} tabIndex={0} aria-label={`What ${name} did`}>
        {!here ? <p class="live-bar-note">This runs on {pcLabel(run.deviceId!)}; its steps are there.</p>
          : error ? <p class="live-bar-note">{error}</p>
          : items === null ? <p class="live-bar-note">Loading…</p>
          : items.length === 0 ? <p class="live-bar-note">No steps yet.</p>
          : <RunItemList items={items} live window={WINDOW} />}
      </div>
      {run.split && here && can('splits.list') && <div class="live-bar-parts"><SplitGroupRows groupId={run.split.groupId} /></div>}
      {(here || task) && (
        <div class="live-bar-actions">
          {here && (
            <button type="button" class="live-bar-watch" onClick={() => openAgentBrowser(run.agentId)} title={`Open ${name}'s area: what it does, live`}>
              <Icon name="monitor" size={14} />
              <span>Watch live</span>
            </button>
          )}
          {task && (
            <button type="button" class="live-bar-task text-button" onClick={() => openTaskDetail(task)}>
              <Icon name="list-checks" size={14} /><span>{taskTitle(task) ?? UNKNOWN_TASK}</span>{/* a to-do in a quest too */}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
