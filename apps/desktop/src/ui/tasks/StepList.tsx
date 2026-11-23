// The checklist of a task in the ChatGPT-photo style: round circles (number while open, check
// icon when done – never strike-through alone), small grey secondary lines, no card per item.
// The human ticks their own steps; the owner agent notices at its next turn (T14). B-080: a step's text opens the
// step's own detail (jump.ts openTaskDetail – its result, evidence and sub-steps; in the side pane its own detail
// there, onOpen); the circle stays the toggle.
// Owns: step rows, the toggle and the open. Never: lets the human tick an agent's step (agents report
// their own work with evidence).

import { useState } from 'preact/hooks';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { Icon, Spinner } from '../lib/ui.tsx';
import { agentName } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { plainPreview } from '../lib/format.ts';
import { STATUS_LABELS, canToggleStep, orderedSteps } from './model.ts';
import { ownerOf } from './work-model.ts';
import { putTask } from './task-cache.ts';
import { openTaskDetail } from './jump.ts';

function ownerText(step: Task): string {
  const owner = ownerOf(step);
  return owner.kind === 'agent' || owner.kind === 'person' ? agentName(owner.id) : owner.kind === 'human' ? 'You' : '';
}

function secondary(step: Task): string {
  const parts: string[] = [];
  const owner = ownerText(step);
  if (owner) parts.push(owner);
  if (step.status !== 'open' && step.status !== 'done') parts.push(STATUS_LABELS[step.status] ?? step.status);
  if (step.waitingOn && step.status !== 'done') parts.push(plainPreview(step.waitingOn.why, 80));
  else if (step.notes) parts.push(plainPreview(step.notes, 80));
  return parts.join(' · ');
}

function StepRow(props: { step: Task; index: number; task: TaskView; onOpen: (taskId: string) => void }) {
  const { step, onOpen } = props;
  const parentId = props.task.id;
  const [busy, setBusy] = useState(false);
  const done = step.status === 'done';
  const toggleable = canToggleStep(step);
  const toggle = async () => {
    setBusy(true);
    try {
      const view = done
        ? await rpc.call('tasks.update', { id: step.id, patch: { status: 'open' } })
        : await rpc.call('tasks.finish', { id: step.id, clientId: newId('up') });
      putTask(view);
      if (done) putTask(await rpc.call('tasks.get', { id: parentId })); // reopening does not re-emit the parent
    } catch (error) {
      toastError(error, 'Could not update the step');
    } finally {
      setBusy(false);
    }
  };
  const circle = (
    <span class="step-circle" data-status={step.status} aria-hidden="true">
      {busy ? <Spinner size={12} /> : done ? <Icon name="check" size={11} /> : step.status === 'dropped' ? <Icon name="x" size={10} /> : <span class="step-number tabular">{props.index + 1}</span>}
    </span>
  );
  const line = secondary(step);
  return (
    <li class={`step-row${done ? ' done' : ''}${step.status === 'dropped' ? ' dropped' : ''}`}>
      {toggleable
        ? <button type="button" class="step-toggle" role="checkbox" aria-checked={done} aria-label={`${done ? 'Reopen' : 'Done'}: ${step.title}`} disabled={busy} onClick={(event) => { event.stopPropagation(); void toggle(); }}>{circle}</button>
        : circle}
      {/* a button role on the text's own span: its lines keep their left edge and nothing moves (a <button> centres them) */}
      <span class="step-text step-open" role="button" tabIndex={0} title="Open this step"
        onClick={() => onOpen(step.id)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(step.id); } }}>
        <span class="step-title">{step.title}<span class="sr-only">{done ? ' (done)' : ` (${STATUS_LABELS[step.status]})`}</span></span>
        {line && <span class="step-sub">{line}</span>}
      </span>
    </li>
  );
}

/** `onOpen`: where a step's text opens it – Work's route by default (openTaskDetail), the side pane its own detail. */
export function StepList(props: { task: TaskView; onOpen?: (taskId: string) => void }) {
  const steps = orderedSteps(props.task.steps);
  if (!steps.length) return null;
  const open = props.onOpen ?? openTaskDetail;
  return (
    <ol class="step-list" aria-label="Steps">
      {steps.map((step, index) => <StepRow key={step.id} step={step} index={index} task={props.task} onOpen={open} />)}
    </ol>
  );
}
