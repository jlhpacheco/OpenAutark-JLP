// Split rows (B-057 S18, like Codex's sub-agent rows): one fixed 24 px row per part – a 16 px status icon slot (a
// spinner while it runs), "#3 title" (ellipsis), the model · effort in a fixed slot at the right (what it runs on – the
// live activity's while it runs; a narrow row shows the effort alone, splits.css) and the duration in a
// fixed slot after it; a row click opens that split's own steps right below it (team/run-items.tsx, the parent
// agent's run stream). Used by the parent's step line "Split · 3 of 5 done" (SplitStep, in run item lists), by a split
// part's line in a chat's live bar (SplitGroupRows, LiveBarMore.tsx); the agent's activity log (Team › agent) shows the same step line, open
// from the start and as columns – one per running part (SplitColumns, SplitLanes.tsx).
// Rows open below fixed rows only; nothing above them moves.
// Owns: this markup and which rows are open. Never: polls, or shows a step the runtime did not journal.

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { RunItem } from '../../shared/model/runs.ts';
import type { SplitGroupView, SplitStatus, SplitView } from '../../shared/model/splits.ts';
import { Icon, Spinner } from '../lib/ui.tsx';
import type { IconName } from '../lib/icons.tsx';
import { activity, agentName } from '../lib/store.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { modelShortName } from '../lib/model-name.ts';
import { RunItemList, useRunItems } from '../team/run-items.tsx';
import { groupsOfRun, splitGroups, watchSplits } from './split-model.ts';
import { SplitLanes } from './SplitLanes.tsx';
import { splitMenu } from './split-menu.ts';
import {
  SPLIT_STATUS_LABEL, groupDone, groupForCall, isLiveGroup, liveOfSplit, partLabel, splitDuration, splitIconKind, splitModelParts,
} from './split-text.ts';
import type { SplitIconKind } from './split-text.ts';

/** Steps an open split row shows before "+N earlier steps" while it runs (as many as the live block). */
const ROW_STEPS = 6;

/** True where a split step opens as columns from the start (the agent's activity log), else to its rows on a click. */
export const SplitColumns = createContext(false);

const ICONS: Record<Exclude<SplitIconKind, 'running'>, IconName> = {
  waiting: 'hourglass-simple', done: 'check-circle', failed: 'warning-circle', stopped: 'stop-circle', skipped: 'arrow-right',
};

/** The fixed 16 px status slot: a spinner while the split runs, its state's icon otherwise. */
export function SplitIcon(props: { status: SplitStatus }) {
  const kind = splitIconKind(props.status);
  return (
    <span class={`split-icon ${kind}`} title={SPLIT_STATUS_LABEL[props.status]}>
      {kind === 'running' ? <Spinner size={12} label="Running" /> : <Icon name={ICONS[kind]} size={14} title={SPLIT_STATUS_LABEL[props.status]} />}
    </span>
  );
}

/** One part's row; open: its steps below it. */
function SplitRow(props: { split: SplitView; agentId: string; open: boolean; onToggle: () => void }) {
  const { split, open } = props;
  const parts = splitModelParts(split, modelShortName, split.status === 'running' ? liveOfSplit(activity.value, split.id) : undefined);
  const model = [parts.name, parts.effort].filter(Boolean).join(' · ');
  const menu = useContextMenu(() => splitMenu(split));
  return (
    <li class={`split-row status-${split.status}`} {...menu}>
      <button type="button" class="split-row-head" aria-expanded={open} onClick={props.onToggle} title={split.error ? `${split.title} – ${split.error}` : split.title}>
        <SplitIcon status={split.status} />
        <span class="split-row-title">{partLabel(split)}</span>
        <span class="split-row-model tabular" title={model || undefined}>
          {parts.name && <span class="split-model-name">{parts.name}{parts.effort ? ' · ' : ''}</span>}
          {parts.effort && <span class="split-model-effort">{parts.effort}</span>}
        </span>
        <span class="split-row-time tabular">{splitDuration(split)}</span>
      </button>
      {open && (
        <div class="split-row-body">
          {split.error && <p class={split.status === 'queued' ? 'split-row-note' : 'split-row-error'}>{split.error}</p>}
          {split.run
            ? <SplitSteps runId={split.run.id} agentId={props.agentId} live={split.status === 'running'} quiet={!!split.error} />
            : <p class="split-row-note">{SPLIT_STATUS_LABEL[split.status]}</p>}
        </div>
      )}
    </li>
  );
}

/** A split's own steps (the parent agent's run stream carries them); none yet: one compact note in the row's body (no
 *  page-sized empty state), nothing under an error that already says why. */
function SplitSteps(props: { runId: string; agentId: string; live: boolean; quiet: boolean }) {
  const { items, error } = useRunItems(props.runId, props.agentId, { enabled: true, live: props.live });
  if (error) return <p class="split-row-error">{error}</p>;
  if (!items) return <span class="split-row-loading"><Spinner size={14} /></span>;
  if (!items.length && !props.live) return props.quiet ? null : <p class="split-row-note">No steps recorded</p>;
  return <RunItemList items={items} live={props.live} window={props.live ? ROW_STEPS : undefined} class="split-steps" />;
}

/** A group's rows in part order; each opens on its own. */
function SplitList(props: { group: SplitGroupView }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next);
  };
  const splits = props.group.splits.slice().sort((a, b) => a.idx - b.idx);
  return (
    <ul class="split-rows" aria-label={`Splits of ${agentName(props.group.agentId)}`}>
      {splits.map((split) => <SplitRow key={split.id} split={split} agentId={props.group.agentId} open={open.has(split.id)} onToggle={() => toggle(split.id)} />)}
    </ul>
  );
}

/** A split part's line in a chat's live bar, opened (chat/LiveBarMore.tsx): its group's rows; a group only the live run named is read. */
export function SplitGroupRows(props: { groupId: string }) {
  const group = splitGroups.value.get(props.groupId);
  const known = Boolean(group);
  useEffect(() => (known ? undefined : watchSplits({ groupId: props.groupId })), [props.groupId, known]);
  return group ? <SplitList group={group} /> : <span class="split-row-loading"><Spinner size={14} /></span>;
}

/** The words of a tool result (its preview) – a group id named there picks the group; undefined while the call runs. */
function resultText(result: RunItem | undefined): string | undefined {
  if (!result) return undefined;
  return typeof result.data.preview === 'string' ? result.data.preview : '';
}

/**
 * The parent's agents.split step: one 24 px line "Split · 3 of 5 done" (a spinner in the icon slot while parts run),
 * a click opens the split rows below it.
 */
export function SplitStep(props: { call: RunItem; result?: RunItem; live: boolean }) {
  const { call, result } = props;
  const columns = useContext(SplitColumns);
  const [open, setOpen] = useState(columns);
  useEffect(() => watchSplits({ parentRunId: call.runId }), [call.runId, result?.id]);
  const group = groupForCall(groupsOfRun(call.runId), call.createdAt, resultText(result));
  const running = (!result && props.live) || (group ? isLiveGroup(group) : false);
  return (
    <li class={`run-item split-step${running ? ' running' : ''}`}>
      <button type="button" class="run-item-head" aria-expanded={open} onClick={() => setOpen(!open)} title={group?.goal}>
        <span class="run-item-icon" aria-hidden="true">{running ? <Spinner size={12} label="Running" /> : <Icon name="git-branch" size={14} />}</span>
        <span class="run-item-verb">Split</span>
        <span class="run-item-target">{group ? `· ${groupDone(group)}` : ''}</span>
      </button>
      {open && (
        <div class={`run-item-body split-step-body${columns ? ' columns' : ''}`}>
          {!group ? <span class="split-row-loading"><Spinner size={14} /></span> : columns ? <SplitLanes group={group} /> : <SplitList group={group} />}
        </div>
      )}
    </li>
  );
}


