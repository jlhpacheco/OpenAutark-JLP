// A split group as columns (the agent's activity log, team/AgentLog.tsx; owner 13.11.2026: "an Spalten sieht … wenn es
// dann wieder zusammenführt, dann wird einer weggenommen"): one column per part that runs, each with what that part
// does – its steps, thoughts, updates and its answer, the same step lines as anywhere (team/run-steps.tsx). Rows follow
// time (split-lanes.ts laneRows): when a part ends its column closes with its end line ("Done · 12 s · back to <agent>")
// and the rows below have one column less, until the log goes on in the main line. Parts not started yet wait in one
// muted line below. Each part's items load like a split row's (team/run-items.tsx useRunItems: live over the parent's
// run stream while it runs). Narrow windows scroll the block sideways, never the page.
// Owns: this markup and the part loaders. Never: polls, or reorders what the runtime journaled.

import { useEffect, useState } from 'preact/hooks';
import type { RunItem } from '../../shared/model/runs.ts';
import type { SplitGroupView, SplitView } from '../../shared/model/splits.ts';
import { agentName } from '../lib/store.ts';
import { modelShortName } from '../lib/model-name.ts';
import { useRunItems } from '../team/run-items.tsx';
import { StepEntry, entryKey } from '../team/run-steps.tsx';
import { runEntries } from '../team/model.ts';
import { shownEntry } from '../team/step-view.ts';
import { laneRows } from './split-lanes.ts';
import { SPLIT_STATUS_LABEL, isSettled, partLabel, splitDuration, splitModelParts } from './split-text.ts';
import { SplitIcon } from './SplitRows.tsx';

const EMPTY: readonly RunItem[] = [];

/** Loads one part's items and hands them up (renders nothing). */
function PartItems(props: { split: SplitView; agentId: string; onItems: (splitId: string, items: readonly RunItem[]) => void }) {
  const { split } = props;
  const { items } = useRunItems(split.run!.id, props.agentId, { enabled: true, live: split.status === 'running' });
  useEffect(() => { if (items) props.onItems(split.id, items); }, [items, split.id]);
  return null;
}

function LaneHead(props: { split: SplitView; first: boolean }) {
  const { split } = props;
  const model = props.first ? splitModelParts(split, modelShortName).name : undefined;
  return (
    <div class={`split-lane-head${props.first ? ' first' : ''}`} title={split.title}>
      <SplitIcon status={split.status} />
      <span class="split-lane-title">{partLabel(split)}</span>
      {model && <span class="split-lane-model">{model}</span>}
    </div>
  );
}

export function SplitLanes(props: { group: SplitGroupView }) {
  const { group } = props;
  const [items, setItems] = useState<ReadonlyMap<string, readonly RunItem[]>>(new Map());
  const onItems = (splitId: string, list: readonly RunItem[]) => setItems((current) => new Map(current).set(splitId, list));
  const splits = group.splits.slice().sort((a, b) => a.idx - b.idx);
  const byId = new Map(splits.map((split) => [split.id, split]));
  const parts = splits.map((split) => ({
    id: split.id, idx: split.idx, startedAt: split.startedAt ?? split.run?.startedAt,
    endedAt: isSettled(split.status) ? split.endedAt ?? split.run?.endedAt ?? split.startedAt ?? split.run?.startedAt : undefined,
  }));
  const { rows, waiting } = laneRows(parts, (id) => items.get(id) ?? EMPTY);
  const main = agentName(group.agentId);
  return (
    <div class="split-lanes" aria-label={`Parts of ${main}`}>
      {splits.filter((split) => split.run).map((split) => <PartItems key={split.run!.id} split={split} agentId={group.agentId} onItems={onItems} />)}
      {rows.map((row) => (
        <div key={row.from} class="split-lane-row" style={{ '--lanes': String(row.lanes.length) }}>
          {row.lanes.map((lane) => {
            const split = byId.get(lane.partId)!;
            const entries = runEntries(lane.items.slice()).filter(shownEntry);
            const live = split.status === 'running';
            return (
              <div key={lane.partId} class={`split-lane status-${split.status}`}>
                <LaneHead split={split} first={lane.first} />
                {entries.length > 0 && <ul class="run-items split-lane-steps">{entries.map((entry) => <StepEntry key={entryKey(entry)} entry={entry} live={live} />)}</ul>}
                {lane.ends && (
                  <p class={`split-lane-end status-${split.status}`}>
                    {[SPLIT_STATUS_LABEL[split.status], splitDuration(split), `back to ${main}`].filter(Boolean).join(' · ')}
                  </p>
                )}
                {lane.ends && split.error && <p class="split-row-error">{split.error}</p>}
              </div>
            );
          })}
        </div>
      ))}
      {waiting.length > 0 && (
        <p class="split-lane-waiting">
          {waiting.map((part) => { const split = byId.get(part.id)!; return `${partLabel(split)} · ${SPLIT_STATUS_LABEL[split.status]}`; }).join('   ')}
        </p>
      )}
    </div>
  );
}
