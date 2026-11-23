// The optional recipient of a quick task (B-078, owner 06.11.: "vielleicht noch eben beim Plus-Symbol … erweiterte
// Einstellungen"; Quests 20.11.2026: the Tasks page's input line, LineExtras.tsx): no chip to choose first – the line's
// + menu carries a "Send to…" section (recipientSections: the agents, the managers' branches and the teams,
// center-model.ts recipientGroups – in the owner's session also the active people of the organisation, F-52: her task
// goes straight to her, in the owner's 1:1 chat with her; never on a phone or a person's device). A second pick of the
// same one goes back to none: the line is the person's own and their assistant sorts it. Whom it goes to shows as the
// line's chip (LineExtras.tsx); a recipient that left (archived agent, emptied team, removed person) is no longer offered.
// Owns: the section builder and who may be offered. Never: posts or routes itself (the caller's onPick does).

import type { QuickTaskTarget } from '../../shared/model/task-center.ts';
import type { Person } from '../../shared/model/people.ts';
import type { MenuItem, MenuSection } from '../lib/ui.tsx';
import { agents } from '../lib/store.ts';
import { people as peopleList } from '../lib/people.ts';
import { isOwner } from '../lib/session.ts';
import { recipientGroups, sameTarget, targetLabel } from './center-model.ts';
import type { Recipient } from './center-model.ts';

const NO_PEOPLE: readonly Person[] = [];

/** The people a quick task may go to on this connection: the owner's own session only (tasks.quickCreate refuses it elsewhere). */
export function recipientPeople(offer: boolean | undefined): readonly Person[] {
  return offer && isOwner() ? peopleList.value : NO_PEOPLE;
}

/** The + menu's "Send to…" sections, built when the menu opens. */
export function recipientSections(input: { value: QuickTaskTarget | undefined; onPick: (target: QuickTaskTarget | undefined) => void; people?: boolean }): MenuSection[] {
  const humans = recipientPeople(input.people);
  const groups = recipientGroups(agents.peek(), humans);
  const chosen = input.value && targetLabel(input.value, agents.peek(), humans) !== undefined ? input.value : undefined;
  const item = (recipient: Recipient): MenuItem => ({
    label: recipient.label, hint: recipient.hint, checked: sameTarget(chosen, recipient.target),
    onSelect: () => input.onPick(sameTarget(chosen, recipient.target) ? undefined : recipient.target),
  });
  return [
    { title: 'Send to…', items: groups.agents.map(item) },
    ...(groups.branches.length ? [{ title: 'Manager branches', items: groups.branches.map(item) }] : []),
    ...(groups.teams.length ? [{ title: 'Teams', items: groups.teams.map(item) }] : []),
    ...(groups.people.length ? [{ title: 'People', items: groups.people.map(item) }] : []),
  ].filter((section) => section.items.length > 0);
}
