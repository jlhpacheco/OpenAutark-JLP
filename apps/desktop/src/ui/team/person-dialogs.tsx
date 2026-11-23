// The dialogs of a person (edit, invite a device, devices and chats), opened from the person menu (menus.ts) by setting
// `personDialog`. F13 (owner 15.11.2026: no pop-up for it): adding a person is a page, Team › Add person (PersonNew.tsx).
// Mounted by the team sidebar and, on the phone's pushed person page, by that page – never twice on screen.
// 17.11.2026: the invite is no dialog any more – `invite` opens the person's page with its card (PersonView.tsx renders
// PersonJoin there, inviteOpen), so nothing darkens the window.
// Owns: which person dialog is open. Never: decides what a dialog does (PersonDialog, PersonJoin, PersonDetails do).

import { signal } from '@preact/signals';
import type { Person } from '../../shared/model/people.ts';
import { people } from '../lib/people.ts';
import { PersonDialog } from './PersonDialog.tsx';
import { PersonDetails } from './PersonDetails.tsx';

export const personDialog = signal<{ kind: 'edit' | 'invite' | 'details'; id: string } | null>(null);

const close = () => { personDialog.value = null; };

/** The invite card open on `personId`'s page (null: none). */
export function inviteOpen(personId: string): boolean {
  const open = personDialog.value;
  return open?.kind === 'invite' && open.id === personId;
}

/** Closes the invite card (Done, Escape, Withdraw, or its page left – then only that person's, `personId`). */
export function closeInvite(personId?: string): void {
  const open = personDialog.peek();
  if (open?.kind === 'invite' && (!personId || open.id === personId)) personDialog.value = null;
}

export function PersonDialogs() {
  const open = personDialog.value;
  const person: Person | null = open ? people.value.find((entry) => entry.id === open.id) ?? null : null;
  return (
    <>
      <PersonDialog open={open?.kind === 'edit' && person !== null} person={person ?? undefined} onClose={close} />
      <PersonDetails person={open?.kind === 'details' ? person : null} onClose={close} />
    </>
  );
}
