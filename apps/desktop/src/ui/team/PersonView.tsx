// A person's page in Team (#/team/person/<id>; B-041 §8 – humans next to the agents, same page shape as the agent
// page): round avatar, name, title and status, whom they report to and who reports to them (people and agents,
// each opening their page; agents with the tiny "AI"), for the owner their devices, and one link to their work
// (the Tasks page narrowed to them; the caller's own is the page itself) and, for the owner, their next days (PersonCalendar.tsx, B-078,
// last on the page so its late arrival moves nothing). The NAME in the header is the dropdown with the person
// menu (menus.ts personMenu: Message · Edit · Invite a device · Devices and chats · Remove access, or Remove for one who
// never joined – F14: such a person is no report of anyone yet); a right click
// on the page opens the same. On the phone Back is the header's lead (the stack's one top row – shell/views.ts
// ownsTopRow), the feedback cell ends it (feedback/cell.tsx) and this page mounts the person dialogs the sidebar
// mounts on a computer. The caller's own page
// ('human') names them as the profile button does.
// 17.11.2026: "Invite a device" / "Invite again" shows its card at the top of this page (no modal) – 20.11.2026 the one
// way a device joins (PersonJoin.tsx: this PC's connect code, their request with Accept, a link for a browser).
// Renders before the people list is loaded (a spinner) and says so when the person is unknown.
// Team-Call 21.11.2026: under Tasks, "New chat" with them and the chats shared with them (MemberChats.tsx); a company
// colleague on an employee's PC (Person.fromEmployer) shows only the chats shared with them – no New chat, no manage
// actions (menus.ts): no chat made here can hold them.
// Owns: the person page. Never: changes people itself (the dialogs do) or shows messages of a person's chats.

import { useEffect } from 'preact/hooks';
import { hasJoined, type Person } from '../../shared/model/people.ts';
import { AgentAvatar, EmptyState, HumanAvatar, Spinner } from '../lib/ui.tsx';
import { Header, backCell } from '../lib/header.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { agentMap, agentName, agents, isMobile, loaded } from '../lib/store.ts';
import { people } from '../lib/people.ts';
import { back, go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { managerOf, statusLabel, topPersonId } from './people-model.ts';
import { ensureSpaces } from './org-state.ts';
import { AiTag } from './parts.tsx';
import { personMenu } from './menus.ts';
import { closeInvite, inviteOpen, PersonDialogs } from './person-dialogs.tsx';
import { PersonJoin } from './PersonJoin.tsx';
import { PersonCalendar } from './PersonCalendar.tsx';
import { TitleMenu } from './TitleMenu.tsx';
import { MemberChats } from './MemberChats.tsx';
import { phoneFeedbackCells } from '../feedback/cell.tsx';

/** A link to a member of the org: a person's page or an agent's insight. */
function MemberLink(props: { id: string }) {
  const agent = agentMap.value.get(props.id);
  return (
    <button type="button" class="agent-link" onClick={() => (agent ? go.agent(props.id) : go.person(props.id))}>
      <AgentAvatar agentId={props.id} size={20} />{agentName(props.id)}{agent && <AiTag />}
    </button>
  );
}

function Facts(props: { person: Person; admin: boolean }) {
  const { person } = props;
  const top = topPersonId(people.value) === person.id;
  const reports = [
    ...people.value.filter((entry) => entry.managerId === person.id && entry.status !== 'revoked' && hasJoined(entry)).map((entry) => entry.id), // F14: invited ones once they join
    ...agents.value.filter((agent) => !agent.archivedAt && (agent.managerId === person.id || (top && !agent.managerId))).map((agent) => agent.id),
  ];
  const boss = person.managerId ? managerOf(person.managerId, { isAgent: (id) => agentMap.value.has(id), isPerson: (id) => people.value.some((entry) => entry.id === id), personSession: false }) : undefined;
  return (
    <dl class="agent-facts">
      {boss && (
        <div>
          <dt>Reports to</dt>
          <dd>{boss.kind === 'self' ? <span class="agent-link static"><HumanAvatar size={20} />{agentName('human')}</span> : <MemberLink id={boss.id} />}</dd>
        </div>
      )}
      {reports.length > 0 && (
        <div>
          <dt>Reports</dt>
          <dd class="agent-reports">{reports.map((id) => <MemberLink key={id} id={id} />)}</dd>
        </div>
      )}
      {props.admin && !person.owner && person.devices && (
        <div>
          <dt>Devices</dt>
          <dd>{person.devices.length ? `${person.devices.length}` : 'None yet'}</dd>
        </div>
      )}
    </dl>
  );
}

export interface PersonViewProps {
  personId: string;
}

export function PersonView(props: PersonViewProps) {
  const { personId } = props;
  useEffect(() => { ensureSpaces(); }, []);
  useEffect(() => () => closeInvite(personId), [personId]); // the invite card goes with its page
  const person = people.value.find((entry) => entry.id === personId);
  const admin = can('people.save') && !person?.fromEmployer;
  const menu = useContextMenu(() => (person ? personMenu(person) : []));
  const self = personId === 'human';
  const name = self ? agentName('human') : person?.name ?? agentName(personId);
  const waiting = !person && (!loaded.value || (can('people.list') && !people.value.length));
  const lead = isMobile.value ? backCell(back) : undefined; // the phone: this page draws the stack's one top row (shell/views.ts)
  if (!person && (waiting || can('people.list'))) {
    return (
      <div class="team-view person-view">
        <Header zone="main" class="person-header" lead={lead} title={name} cells={phoneFeedbackCells()} />
        <div class="agent-scroll"><div class="agent-column">{waiting ? <Spinner /> : <EmptyState>This person is not in the organisation.</EmptyState>}</div></div>
      </div>
    );
  }
  const status = person ? statusLabel(person) : '';
  const role = [person?.title, status === 'Active' ? '' : status].filter(Boolean).join(' · ');
  return (
    <div class="team-view person-view">
      <Header zone="main" class="person-header" lead={lead} title={person ? <TitleMenu name={name} sections={() => personMenu(person)} /> : name} cells={phoneFeedbackCells()} />
      <div class="agent-scroll">
        <div class="agent-column" {...menu}>
          {person && inviteOpen(personId) && <PersonJoin person={person} onClose={() => closeInvite()} />}
          <section class="agent-profile" aria-label="Identity">
            <div class="agent-identity">
              <AgentAvatar agentId={personId} size={64} />
              <div class="agent-identity-text">
                <h1 class="agent-name">{self && person && !person.owner ? `${name} (you)` : name}</h1>
                {role && <p class="agent-role">{role}</p>}
              </div>
            </div>
            {person && <Facts person={person} admin={admin} />}
          </section>
          <button type="button" class="text-button agent-work-link" onClick={() => (self ? go.tasks() : go.tasks(undefined, personId))}>Tasks</button>
          {!self && <MemberChats memberId={personId} canStart={person?.status === 'active' && !person.fromEmployer && can('chats.create')} />}
          {admin && !self && person && person.status !== 'revoked' && <PersonCalendar personId={personId} />}
        </div>
      </div>
      {isMobile.value && <PersonDialogs />}
    </div>
  );
}
