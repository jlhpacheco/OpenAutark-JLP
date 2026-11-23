// The side pane between people (owner 21.11.2026: "auf welchem PC vom User … und man kann es mit anderen Mitgliedern
// teilen … die KI kann das gleiche auch machen"). One principle: a tab runs on one PC – its origin (a website loads
// there with that PC's logins, a file lies there, an agent's own browser runs where the agent runs) – and shows in the
// panes of the people it is given to; a person sees their own pane on every PC and phone of theirs. Open on puts a tab
// on a PC of any person (a website then runs there); Share with lets other people see and use a tab while it keeps
// running on its origin (runtime/pane/shares.ts records it there and every call from another person's PC is checked
// against it). A person with no PC of their own (a phone or browser invited to the company) keeps their pane on the
// company's PCs, in the space 'person:<id>'. Ids are in the terms of the PC that holds them: 'human' its own person,
// 'per_…' a colleague, 'owner' the CEO seen from an employee's PC (people/perspective.ts).
// pane.* are merged into Methods by module augmentation.
// Owns: these shapes and the share key of a tab. Never: behaviour.

import type { SideEntry } from '../api/workspace-browser.ts';

/** A PC a person's pane lives on, as this PC knows it. */
export interface PanePc { id: string; name: string; online: boolean; self?: true }

/** A person of the company and the PCs of theirs this PC can reach (none: their pane lives on the company's PCs). */
export interface PanePerson { id: string; name: string; me: boolean; pcs: PanePc[] }

/** pane.open: put `entry` (a tab of this PC's pane, in its terms) on PC `pc` of `person` and show it there. */
export interface PaneOpen { person?: string; pc?: string; entry: SideEntry }
/** pane.share: `add` / `remove` people, or the whole set (`people`, [] ends it); none of them reads who has it now. A new
 *  person gets it on their pane's default PC, or `pcs[person]`. The answer is everyone who has it after. */
export interface PaneShare { entry: SideEntry; people?: string[]; add?: string[]; remove?: string[]; pcs?: Record<string, string> }

/** What a share is recorded under on the tab's origin: its website tab, an agent's browser, or a path. */
export function shareKey(entry: SideEntry): string | undefined {
  if (entry.panel === undefined && /^web-/.test(entry.id)) return entry.id;
  if (entry.panel === 'remote' && typeof entry.tab === 'string') return entry.tab;
  if (entry.panel === 'agent' && typeof entry.agentId === 'string') return `agent:${entry.agentId}`;
  if ((entry.panel === 'file' || entry.panel === 'folder' || entry.panel === 'media') && typeof entry.path === 'string') return `path:${entry.path}`;
  return undefined;
}

/** The space a person without a PC of their own keeps their pane in, on the company's PCs. */
export const personSpace = (personId: string): string => `person:${personId}`;

declare module '../api/methods.ts' {
  interface Methods {
    /** Every person of the company with the PCs their pane lives on (me first). */
    'pane.targets': { params: void; result: PanePerson[] };
    'pane.open': { params: PaneOpen; result: { ok: true; pc?: string } };
    'pane.share': { params: PaneShare; result: { ok: true; people: string[] } };
  }
}

export {};
