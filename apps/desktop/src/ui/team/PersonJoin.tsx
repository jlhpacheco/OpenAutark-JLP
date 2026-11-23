// How a person's device joins – the one way (F13, owner 15.11.2026: "zusammenführen mit dem normalen System"): this PC's
// connect code as QR and digits (phone.pairLink – their phone scans it in the Autark app, Autark on their PC types it
// under Connect with an ID), then each request that arrives here as the Settings › Devices row with the person already set
// (connect-rows.tsx IncomingRow) – Accept makes it their device – and, while this PC has an address on the network,
// "Copy link" for a browser there (people.invite). CodeRow serves Team › Add person (PersonNew.tsx) too; PersonJoin is
// "Invite a device" / "Invite again" on a person's page: a card at its top (no modal, 17.11.2026), Escape or × closes it
// and focus returns where it was. 20.11.2026: it replaced the person-scoped invite card with its own QR and 6-digit
// code (a second way); one who never joined leaves with the person menu's Remove (menus.ts, F14).
// Owns: the connect code row and that card. Never: accepts a device without the owner's click.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Person } from '../../shared/model/people.ts';
import { isPersonSession } from '../lib/people.ts';
import { rpc } from '../lib/rpc.ts';
import { can, isOwner } from '../lib/session.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { Button, Icon } from '../lib/ui.tsx';
import { Group, Row, useAsync } from '../settings/controls.tsx';
import { IncomingRow, useConnectState } from '../settings/connect-rows.tsx';
import { groupDigits } from '../settings/connect-text.ts';
import { ADD_PERSON_CODE_HINT, browserReachable, requestSlotHint } from './people-model.ts';

/** This PC's connect code: the QR their phone scans and the digits their PC types (the same ID). */
export function CodeRow() {
  const code = useAsync(() => (can('phone.pairLink') ? rpc.call('phone.pairLink') : Promise.resolve(undefined)), []);
  const digits = code.data ? groupDigits(code.data.remoteId) : '';
  const hint = code.error ?? (digits ? `${digits} · ${ADD_PERSON_CODE_HINT}` : ADD_PERSON_CODE_HINT);
  return (
    <Row class="remote-phone-row" label="Connect code" hint={<span title={hint}>{hint}</span>}>
      <div class={`remote-qr${code.data || code.error ? '' : ' loading'}`} aria-busy={code.loading || undefined}>
        {code.data && <img class="remote-qr-code" src={code.data.qrDataUrl} alt="QR code for their phone" width={96} height={96} />}
      </div>
    </Row>
  );
}

/** Whether a browser on the network can open this PC's invite link (a CEO's device reaches this PC, people.invite answers its address). */
export function useLinkReachable(): boolean {
  const lan = useAsync(() => (can('pwa.state') ? rpc.call('pwa.state').then((state) => browserReachable(state.urls)) : Promise.resolve(isPersonSession() && can('people.invite'))), []);
  return lan.data === true;
}

/** The person's link for a browser on the network to the clipboard (people.invite: one use, 72 hours). */
export async function copyInviteLink(person: Pick<Person, 'id' | 'name'>): Promise<void> {
  const invite = await rpc.call('people.invite', { id: person.id });
  const allows = isOwner() ? 'You allow' : 'The owner of the organisation allows';
  await navigator.clipboard.writeText(invite.url).then(
    () => pushToast({ title: 'Link copied', body: `It opens once, for 72 hours, in a browser on this network. ${allows} ${person.name}'s device on the Tasks page.` }),
    (error: unknown) => toastError(error, 'Could not copy the link'),
  );
}

export function PersonJoin(props: { person: Person; onClose: () => void }) {
  const { person } = props;
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [person.id]);
  const { remote } = useConnectState();
  const reachable = useLinkReachable();
  const [copying, setCopying] = useState(false);
  const requests = (remote.data?.incoming ?? []).filter((request) => request.role !== 'ceo');
  const copy = () => {
    setCopying(true);
    copyInviteLink(person).catch((error: unknown) => toastError(error, 'Could not make the link')).finally(() => setCopying(false));
  };
  return (
    <section ref={card} class="person-join-card" aria-label={`Invite ${person.name}`} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
      <Group title={`${person.name}'s phone or PC`} id="person-join"
        actions={<button type="button" class="icon-button small" aria-label="Close" onClick={props.onClose}><Icon name="x" size={18} /></button>}>
        <CodeRow />
        {requests.map((request) => (
          <IncomingRow key={request.id} request={request} people={[person]} personId={person.id} onDecided={(yes) => { if (yes) props.onClose(); }} />
        ))}
        {!requests.length && <Row label="Their request" hint={requestSlotHint({ named: true, waiting: 0 })} reserve />}
        {reachable && (
          <Row label="Link for a browser on this network" hint="Opens once, for 72 hours · you allow their device on the Tasks page" reserve>
            <Button variant="ghost" class="small" busy={copying} onClick={copy}>Copy link</Button>
          </Row>
        )}
      </Group>
    </section>
  );
}
