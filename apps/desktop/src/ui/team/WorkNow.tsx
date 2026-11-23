// The agent's Work page, its top parts (AgentWork.tsx; owner feedback 16.11.2026 F11, Mika's draft):
//   * Now – one card per run working right now (agent-work.ts nowCards, from the live activity the runtime pushes):
//     what it does this moment (its live note, it changes with every step – a click jumps the log to that run's start),
//     how long it runs (on one 30 s clock, as the chat's live bar), its own Stop (F20: runs.cancel, "Stopping…" until
//     the run ends and its card goes), its chat and task as links, what started it when there is neither, model ·
//     where it runs (F05) · effort; a split's running parts as lines that open their split page. Nothing running:
//     "Not working right now." with the last ended run of the log (its end, how long, its summary).
//   * Active tasks – the agent's open quests and to-dos at work right now (agent-work.ts isActive: a turn on it, or a move
//     in the last 24 h; a to-do in anyone's quest too, read from the quest's steps) with where it sits among the quests
//     (questLine), plan progress and last move – never a time: agent work has none; the open ones that have not moved
//     for longer folded into "N older open", its waiting ones into "N waiting" (open: what each waits on and since when)
//     – two fixed toggle rows at the section's end, opening one only adds rows below it; "All tasks" to the Tasks page
//     narrowed to the agent (#/tasks?owner=).
// Owns: those two sections' markup. Never: polls, stops another run than its card's, or shows what the runtime did not
// report.

import { useEffect, useState } from 'preact/hooks';
import type { AgentActivity, Run } from '../../shared/model/runs.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { movedAt } from '../../shared/model/task-stuck.ts';
import { durationText } from '../../shared/text/run-notes.ts';
import { Icon } from '../lib/ui.tsx';
import { activity, agentName, conversationMap, tasks } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { chatTitle } from '../lib/chat-naming.ts';
import { relative, time } from '../lib/format.ts';
import { modelShortName, nameWithSource } from '../lib/model-name.ts';
import { canOpenChat, openTaskDetail } from '../tasks/jump.ts';
import { waitingLine } from '../tasks/waiting.ts';
import { StopRun } from '../chat/StopRun.tsx';
import { sinceText } from '../chat/LiveBar.tsx';
import { modelLine, noteText, partsWorking, shownOf, withTemperature } from '../chat/live-text.ts';
import { partLabel } from '../splits/split-text.ts';
import { activeTasks, planProgress, questLine, type NowCard } from './agent-work.ts';
import { everyTask } from '../../shared/model/tasks.ts';

const TICK_MS = 30_000;

/** How long it works so far, "4 min" – its own 30 s clock, so only this cell renders again. */
function Elapsed(props: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return <span class="work-card-time tabular">{sinceText(props.startedAt, Math.max(now, props.startedAt))}</span>;
}

/** The run in the log a card stands for: its own, else the run that split. */
const logRunOf = (card: NowCard) => card.run?.runId ?? card.parts[0]?.split?.parentRunId;

function Card(props: { card: NowCard; agentId: string; onJump: (runId: string) => void }) {
  const { card, agentId } = props;
  const run: AgentActivity | undefined = card.run;
  const name = agentName(agentId);
  const chat = run?.conversationId ? conversationMap.value.get(run.conversationId) : undefined;
  const task = run?.taskId ? everyTask(tasks.value).get(run.taskId) : undefined; // a to-do in a quest too
  // "Opus 5.5 · Claude Code · High" – F05: where it runs after the name
  const model = run ? withTemperature(modelLine({ ...run, modelName: nameWithSource(run.modelName?.trim() || modelShortName(run.model) || '', run.model) }), shownOf(run)) : '';
  const note = run ? noteText(run.note) : partsWorking(card.parts.length, card.parts[0]?.split?.of ?? card.parts.length);
  const target = logRunOf(card);
  return (
    <li class="work-card" data-run-id={run?.runId}>
      <div class="work-card-head">
        <span class="work-card-dot" aria-hidden="true" />
        <button type="button" class="work-card-note" title={target ? `${note} – show in the activity log` : note} onClick={() => target && props.onJump(target)}>{note}</button>
        <Elapsed startedAt={card.startedAt} />
        {run && can('runs.cancel') && <StopRun runId={run.runId} name={name} class="work-card-stop" />}
      </div>
      <div class="work-card-meta">
        {chat && (canOpenChat(chat.id)
          ? <button type="button" class="work-link" onClick={() => go.chat(chat.id)}><Icon name="chat-circle" size={14} /><span>{chatTitle(chat)}</span></button>
          : <span class="work-link static"><Icon name="chat-circle" size={14} /><span>{chatTitle(chat)}</span></span>)}
        {run?.taskId && (can('tasks.get')
          ? <button type="button" class="work-link" onClick={() => openTaskDetail(run.taskId!)}><Icon name="list-checks" size={14} /><span>{task?.title ?? 'Task'}</span></button>
          : <span class="work-link static"><Icon name="list-checks" size={14} /><span>{task?.title ?? 'Task'}</span></span>)}
        {run && !chat && !run.taskId && run.origin?.label && <span class="work-link static">{run.origin.label}</span>}
        {model && <span class="work-card-model tabular" title={model}>{model}</span>}
      </div>
      {card.parts.length > 0 && (
        <ul class="work-card-parts">
          {card.parts.map((part) => (
            <li key={part.runId}>
              <button type="button" class="work-link" onClick={() => go.split(agentId, part.split!.id)}>{partLabel(part.split!)}</button>
              <span class="work-part-note">{noteText(part.note)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Not working right now." and the last ended run the log knows: "Last run ended 10:42 after 3 min 4 s · <summary>". */
function Idle(props: { last: Run | undefined }) {
  const { last } = props;
  const about = last?.endedAt !== undefined
    ? [`Last run ended ${time(last.endedAt)}`, last.startedAt ? `after ${durationText(last.startedAt, last.endedAt)}` : '', last.summary ?? ''].filter(Boolean).join(' · ')
    : '';
  return (
    <p class="work-idle">
      <span>Not working right now.</span>
      {about && <span class="work-idle-last" title={about}>{about}</span>}
    </p>
  );
}

export function WorkNow(props: { agentId: string; cards: NowCard[]; last: Run | undefined; onJump: (runId: string) => void }) {
  return (
    <section class="agent-section work-now" aria-label="Now">
      <h3 class="agent-section-title">Now</h3>
      {props.cards.length
        ? <ul class="work-cards">{props.cards.map((card) => <Card key={card.key} card={card} agentId={props.agentId} onJump={props.onJump} />)}</ul>
        : <Idle last={props.last} />}
    </section>
  );
}

/** A row of Active tasks: a quest or a to-do, `running` while a turn works on it. */
type Listed = Task & { running: boolean };

function TaskLine(props: { task: Listed; detail: string }) {
  const { task } = props;
  const title = can('tasks.get')
    ? <button type="button" class="work-task-title" onClick={() => openTaskDetail(task.id)}>{task.title}</button>
    : <span class="work-task-title">{task.title}</span>;
  return (
    <li class="work-task" data-task-id={task.id}>
      {title}
      <span class="work-task-meta" title={props.detail}>{props.detail}</span>
    </li>
  );
}

/** An open task's line under its title: running now, where it sits among the quests, plan progress, its last move. */
function openDetail(task: Listed, every: ReadonlyMap<string, Task>): string {
  return [task.running ? 'Working on it now' : '', questLine(task, every) ?? '', planProgress(task.ledger?.plan) ?? '', `moved ${relative(movedAt(task))}`].filter(Boolean).join(' · ');
}

/** A folded group of tasks: one fixed toggle row; opening it only adds its rows below. */
function Fold(props: { label: string; list: Listed[]; detail: (task: Listed) => string }) {
  const [open, setOpen] = useState(false);
  if (!props.list.length) return null;
  return (
    <>
      <button type="button" class="agent-fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={12} /><span>{props.label}</span>
      </button>
      {open && <ul class="work-task-list folded">{props.list.map((task) => <TaskLine key={task.id} task={task} detail={props.detail(task)} />)}</ul>}
    </>
  );
}

export function WorkTasks(props: { agentId: string }) {
  const every = everyTask(tasks.value); // the open tasks and their quests' to-dos, each once
  const working = new Set(activity.value.map((run) => run.taskId));
  const list: Listed[] = [...every.values()].map((task) => ({ ...task, running: working.has(task.id) }));
  const { open, older, waiting } = activeTasks(list, props.agentId);
  const detail = (task: Listed) => openDetail(task, every);
  return (
    <section class="agent-section work-tasks" aria-label="Active tasks">
      <h3 class="agent-section-title">Active tasks</h3>
      {open.length
        ? <ul class="work-task-list">{open.map((task) => <TaskLine key={task.id} task={task} detail={detail(task)} />)}</ul>
        : <p class="work-empty">{older.length || waiting.length ? 'Nothing moved in the last 24 hours.' : 'No open tasks.'}</p>}
      <Fold label={`${older.length} older open`} list={older} detail={detail} />
      <Fold label={`${waiting.length} waiting`} list={waiting} detail={(task) => waitingLine(task, agentName) ?? 'Waiting'} />
      <button type="button" class="text-button work-all-tasks" onClick={() => go.tasks(undefined, props.agentId)}>All tasks</button>
    </section>
  );
}
