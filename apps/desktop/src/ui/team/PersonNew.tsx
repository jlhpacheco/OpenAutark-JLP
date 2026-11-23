// Team › Add person (#/team/person/new; F13, owner 15.11.2026: no pop-up over everything, and one way for people's
// devices – "zusammenführen mit dem normalen System"): a page in the main zone, on the phone a pushed screen with Back.
// First name, title and whom they report to; below, on the same page, how their device joins (PersonJoin.tsx – the one
// way, also "Invite a device" on a person's page): this PC's connect code as QR and digits, then each request that arrives here (remote.state; my own PCs' requests stay in Settings › Devices) as the
// Settings › Devices row with this person already named (connect-rows.tsx IncomingRow `newPerson`): Accept makes the
// person as their device links (remote.decide newPerson) and their page opens once they are in. Until a name is typed
// one fixed row holds the requests' place and says what to do. Only while this PC has an address on the network
// (pwa.state) "Copy link" for a browser there: the person is made now (Team › Invited until they join), their one-time
// link (people.invite) goes to the clipboard and their page opens. Everything has its fixed place, so nothing above
// moves when the code, a request or the link row arrives.
// F13: the owner picks the role – a member, or a CEO beside them (choosing CEO puts them at the top); the role travels
// with Accept (newPerson) and Copy link. A CEO adding a member here gets "Copy link" (people.invite on this PC's address).
// Owns: this page. Never: accepts a device without the owner's click, or makes a person before Accept or Copy link.

import { useEffect, useState } from 'preact/hooks';
import { Header, backCell } from '../lib/header.tsx';
import { people, upsertPerson } from '../lib/people.ts';
import { rpc } from '../lib/rpc.ts';
import { back, navigate } from '../lib/router.ts';
import { withSelf } from '../lib/self-identity.ts';
import { can, isOwner } from '../lib/session.ts';
import type { PersonRole } from '../../shared/model/people.ts';
import { agents, isMobile, settings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, EmptyState, Select } from '../lib/ui.tsx';
import { phoneFeedbackCells } from '../feedback/cell.tsx';
import { Group, Row } from '../settings/controls.tsx';
import { IncomingRow, useConnectState } from '../settings/connect-rows.tsx';
import { managerOptions, newPersonOf, requestSlotHint, ROLE_OPTIONS, roleHint } from './people-model.ts';
import { CodeRow, copyInviteLink, useLinkReachable } from './PersonJoin.tsx';

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

export function PersonNew() {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [manager, setManager] = useState('human');
  const [role, setRole] = useState<PersonRole>('member');
  const [copying, setCopying] = useState(false);
  const [accepted, setAccepted] = useState<{ name: string; before: string[] } | null>(null);
  const { remote } = useConnectState();
  const reachable = useLinkReachable(); // F13: a CEO's device reaches this PC too (people.invite answers its address)
  const pickRole = (next: PersonRole) => {
    if (next === 'ceo' && role !== 'ceo') setManager(''); // a CEO sits at the top
    setRole(next);
  };
  const list = people.value;
  // Accepted: the person is made when their device links – their page opens then.
  useEffect(() => {
    const made = accepted && list.find((person) => person.name === accepted.name && !accepted.before.includes(person.id));
    if (made) navigate({ view: 'team', personId: made.id }, { replace: true });
  }, [accepted, list]);
  const lead = isMobile.value ? backCell(back) : undefined;
  const header = <Header zone="main" class="person-header" lead={lead} title="Add person" cells={phoneFeedbackCells()} />;
  if (!can('people.save')) {
    return <div class="team-view person-view">{header}<div class="agent-scroll"><div class="agent-column"><EmptyState>People are added on your PC.</EmptyState></div></div></div>;
  }

  const fresh = newPersonOf({ name, title, managerId: manager, role });
  const requests = accepted ? [] : (remote.data?.incoming ?? []).filter((request) => request.role !== 'ceo');
  const rows = fresh ? requests : [];
  const copyLink = async () => {
    if (!fresh || copying) return;
    setCopying(true);
    try {
      const person = await rpc.call('people.save', { name: fresh.name, title: fresh.title ?? '', ...(fresh.managerId ? { managerId: fresh.managerId } : {}), ...(fresh.role ? { role: fresh.role } : {}) });
      upsertPerson(person);
      await copyInviteLink(person);
      navigate({ view: 'team', personId: person.id }, { replace: true });
    } catch (error) {
      toastError(error, 'Could not add the person');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div class="team-view person-view person-new-view">
      {header}
      <div class="agent-scroll">
        <div class="agent-column">
          <form class="person-new" aria-label="Add person" onSubmit={(event) => event.preventDefault()}>
            <div class="agent-editor-grid">
              <div class="agent-field">
                <label class="field-label" for="person-new-name">Name</label>
                <input id="person-new-name" class="input" type="text" value={name} maxLength={80} required autoFocus autoComplete="off" onInput={(event) => setName(value(event))} />
              </div>
              <div class="agent-field">
                <label class="field-label" for="person-new-title">Title</label>
                <input id="person-new-title" class="input" type="text" value={title} maxLength={80} placeholder="Optional" autoComplete="off" onInput={(event) => setTitle(value(event))} />
              </div>
            </div>
            {isOwner() && (
              <div class="agent-field">
                <label class="field-label" for="person-new-role">Role</label>
                <Select id="person-new-role" class="person-manager" label="Role" value={role} onChange={pickRole} options={ROLE_OPTIONS} />
                <small class="person-role-hint">{roleHint(role)}</small>
              </div>
            )}
            <div class="agent-field">
              <label class="field-label" for="person-new-manager">Reports to</label>
              <Select id="person-new-manager" class="person-manager" label="Reports to" value={manager} onChange={setManager}
                options={managerOptions(undefined, withSelf(list, settings.value?.profile), agents.value)} />
            </div>
          </form>
          <Group title="Their phone or PC" id="person-new-device">
            <CodeRow />
            {rows.map((request) => (
              <IncomingRow key={request.id} request={request} people={[]} newPerson={fresh}
                onDecided={(yes) => { if (yes && fresh) setAccepted({ name: fresh.name, before: list.map((person) => person.id) }); }} />
            ))}
            {!rows.length && <Row label="Their request" hint={requestSlotHint({ named: Boolean(fresh), waiting: requests.length, accepted: accepted?.name })} reserve />}
            {reachable && (
              <Row label="Link for a browser on this network" hint="Opens once, for 72 hours · you allow their device on the Tasks page" reserve>
                <Button variant="ghost" class="small" busy={copying} disabled={!fresh || Boolean(accepted)} onClick={() => void copyLink()}>Copy link</Button>
              </Row>
            )}
          </Group>
        </div>
      </div>
    </div>
  );
}
