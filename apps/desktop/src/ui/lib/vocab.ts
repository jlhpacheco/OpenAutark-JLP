// The one vocabulary of the main destinations (Tasks · Chats · Team – Quests round 20.11.2026: one Tasks page instead of
// B-041's My day and Work): their names in rail and phone-tab order, so every view says the same thing. Labels only:
// route keys and identifiers stay as they are.
// Owns: these UI words. Never: logic, routes or anything a view decides with them.

/** The main destinations' keys. 'home' is only a route alias of Tasks (no rail entry or tab of its own). */
export type NavKey = 'home' | 'tasks' | 'chats' | 'team';

/** The main destinations by nav key, in the order of the desktop rail and the phone tabs (Tasks · Chats · Team). */
export const DESTINATIONS: Readonly<Record<NavKey, string>> = {
  home: 'Tasks',
  tasks: 'Tasks',
  chats: 'Chats',
  team: 'Team',
};
