// Agent page, identity part: large avatar with the real status, name with the tiny "AI", role, team, space,
// manager and reports (each opens that agent – a person manager their page, B-041: no manager is the top –
// "You" on the owner's PC, the CEO on a person's device; people-model.ts managerOf), the live status – what it
// works on now (B-054: its task's title, else what started the run, the origin's label; the status label alone
// says "Working") and its live note –, the instructions (rendered Markdown, the first lines until "Show more")
// and "Edit", which opens the small editor (AgentEditor.tsx: avatar, name, role, instructions). 21.11.2026 (owner: "ein
// klareres System, wo ein Agent läuft"): "Runs on" names its PC (runs-on.ts) and moves one of mine to another own PC.
// The agent view passes `readOnly` for archived agents: then there is no Edit.
// Owns: identity display and when the editor shows. Never: changes the model or schedules (own sections),
// or shows invented status.

import { useState } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { AgentAvatar, Button, HumanAvatar } from '../lib/ui.tsx';
import { agentMap, agentName, agents, tasks, todos, upsertById } from '../lib/store.ts';
import { isPersonSession, peopleMap } from '../lib/people.ts';
import { go } from '../lib/router.ts';
import { relative } from '../lib/format.ts';
import { AGENT_STATUS_LABELS, effectiveStatus } from './model.ts';
import { AgentStatusAvatar, AiTag } from './parts.tsx';
import { managerOf } from './people-model.ts';
import { liveByAgent, spaces } from './org-state.ts';
import { everyTask } from '../../shared/model/tasks.ts';
import { AgentEditor } from './AgentEditor.tsx';
import { Markdown } from '../blocks/markdown.tsx';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { moveTargets, runsOn, runsOnText, watchPcs, type RunsOn } from './runs-on.ts';

/**
 * 21.11.2026: the PC the agent runs on; an agent of mine (not a company's) can move to this PC or another own PC that
 * is online – agents.update deviceId, the runtime's move (its record goes along, agents/move.ts).
 */
function RunsOnPick(props: { agent: Agent; where: RunsOn; readOnly?: boolean }) {
  const { agent, where } = props;
  const targets = moveTargets();
  const self = targets.find((device) => device.self);
  const current = where.id ?? self?.id ?? '';
  if (props.readOnly || where.company || !can('agents.update') || targets.length < 2) return <span>{runsOnText(where)}</span>;
  const move = (deviceId: string) => {
    if (deviceId === current) return;
    rpc.call('agents.update', { id: agent.id, patch: { deviceId } }).then((next) => upsertById(agents, next), (error: unknown) => toastError(error, `Could not move ${agent.name}`));
  };
  return (
    <select class="set-input agent-runs-on" aria-label={`PC ${agent.name} runs on`} value={current} onChange={(event) => move((event.currentTarget as HTMLSelectElement).value)}>
      {!targets.some((device) => device.id === current) && <option value={current}>{runsOnText(where)}</option>}
      {targets.map((device) => <option key={device.id} value={device.id}>{device.self ? `This PC (${device.name})` : device.name}</option>)}
    </select>
  );
}

export function AgentProfile(props: { agent: Agent; readOnly?: boolean }) {
  const { agent } = props;
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const live = liveByAgent.value.get(agent.id);
  const status = effectiveStatus(agent, live);
  const manager = managerOf(agent.managerId, { isAgent: (id) => agentMap.value.has(id), isPerson: (id) => peopleMap.value.has(id), personSession: isPersonSession() });
  const reports = agents.value.filter((entry) => entry.managerId === agent.id && !entry.archivedAt);
  const space = agent.spaceId ? spaces.value.find((entry) => entry.id === agent.spaceId) : undefined;
  // B-054: Now = the run's task title, else its origin's label (a chat-free run: a mail, a routine…).
  const taskTitle = live?.taskId ? everyTask(tasks.value, todos.value).get(live.taskId)?.title : undefined; // a to-do in a quest too
  const working = live ? taskTitle ?? live.origin?.label : undefined;
  const liveNote = live?.note || (agent.status !== 'idle' ? agent.statusNote : undefined);
  const note = liveNote && liveNote !== working ? liveNote : undefined;
  const longInstructions = agent.instructions.length > 280;
  watchPcs();
  const where = runsOn(agent); // 21.11.2026: shown once this PC has another PC beside it

  return (
    <section class="agent-profile" aria-label="Identity">
      <div class="agent-identity">
        <AgentStatusAvatar agent={agent} size={64} />
        <div class="agent-identity-text">
          <h1 class="agent-name">{agent.name}<AiTag /></h1>
          <p class="agent-role">{[agent.role, agent.team, space?.name].filter(Boolean).join(' · ')}</p>
          <p class={`agent-status-line status-${status}`}>
            <span class="agent-status-label">{AGENT_STATUS_LABELS[status]}</span>
            {working && <span class="agent-status-now"> · {working}</span>}
            {note && <span> · {note}</span>}
            {live && <span class="muted"> · {relative(live.startedAt)}</span>}
          </p>
        </div>
        {!props.readOnly && !editing && <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      {editing && <AgentEditor agent={agent} onDone={() => setEditing(false)} />}

      <dl class="agent-facts">
        <div>
          <dt>Reports to</dt>
          <dd>
            {manager.kind === 'agent'
              ? <button type="button" class="agent-link" onClick={() => go.agent(manager.id)}><AgentAvatar agentId={manager.id} size={20} />{agentName(manager.id)}</button>
              : manager.kind === 'person'
                ? <button type="button" class="agent-link" onClick={() => go.person(manager.id)}><AgentAvatar agentId={manager.id} size={20} />{agentName(manager.id)}</button>
                : <span class="agent-link static"><HumanAvatar size={20} />You</span>}
          </dd>
        </div>
        {reports.length > 0 && (
          <div>
            <dt>Reports</dt>
            <dd class="agent-reports">
              {reports.map((report) => (
                <button type="button" key={report.id} class="agent-link" onClick={() => go.agent(report.id)}>
                  <AgentAvatar agentId={report.id} size={20} working={liveByAgent.value.has(report.id)} />{report.name}
                </button>
              ))}
            </dd>
          </div>
        )}
        {where && (
          <div>
            <dt>Runs on</dt>
            <dd><RunsOnPick agent={agent} where={where} readOnly={props.readOnly} /></dd>
          </div>
        )}
      </dl>

      {!editing && agent.instructions && (
        <div class="agent-instructions">
          <h3 class="agent-section-title">Instructions</h3>
          <Markdown text={agent.instructions} class={`agent-instructions-text${longInstructions && !showAll ? ' clipped' : ''}`} />
          {longInstructions && <button type="button" class="text-button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : 'Show more'}</button>}
        </div>
      )}
    </section>
  );
}
