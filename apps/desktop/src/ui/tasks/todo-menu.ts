// The ONE right-click menu of a to-do on the Tasks page (row, detail): Later › (in 10 minutes, in 1 hour, tomorrow at
// the start of work – its time moves), Repeat › Daily · Weekdays · Weekly (the to-do repeats at its time – a timer with
// the repeat; a Done moves it to the next time) and Stop repeating on a repeating one, Show as › (the widget), Move to
// quest › (one of the open quests, or out of its own), Can't do… (an asked to-do: declined with a reason, its asker
// hears it – the detail opens with the reason line), Send to team (the person's own: Autark picks an owner), Only me (the
// person does it; the AI keeps it in view and never takes it over), Important (priority 1, a mark on the row), Rename… (the detail opens with the caret in
// its title), Undo last change, Open in chat, Done (a mini-app that never reports back), Remove (one's own). Text only.
// Owns: the items. Never: settles a to-do itself (page-actions.ts calls).

import type { MenuItem, MenuSection } from '../lib/popover.tsx';
import { TODO_REPEATS, type Task, type TodoRepeat } from '../../shared/model/tasks.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { settings } from '../lib/store.ts';
import { canOpenChat, openTaskInChat } from './jump.ts';
import { later, moveToQuest, repeatTodo, sendToTeam, setImportant, setOnlyMe, showAs, stopRepeating, undoLast } from './page-actions.ts';
import { showAsOptions } from './todo-model.ts';
import { snoozeChoices } from './todo-time.ts';
import { todoActions } from './todo-actions.ts';

const REPEAT_LABEL: Record<TodoRepeat, string> = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' };

export interface TodoMenuHandlers {
  /** "Can't do…": the detail opens with the reason line. */
  onDecline: () => void;
  /** "Done" on a mini-app to-do, "Remove" on one's own (the take guard asks first). */
  onMarkDone: () => void;
  onRemove: () => void;
  /** "Rename…": the detail opens with the caret in its title. */
  onRename: () => void;
}

/** A quest the menu offers to move a to-do into (the quest column's open quests, the person's first). */
export type QuestChoice = Pick<Task, 'id' | 'title'>;

/** Move to quest ›: every offered quest but its own, then "Out of <quest>" for one in a quest. */
function moveItems(task: Task, quests: readonly QuestChoice[]): MenuItem[] {
  const own = task.parentId ? quests.find((quest) => quest.id === task.parentId) : undefined;
  return [
    ...quests.filter((quest) => quest.id !== task.parentId).map((quest) => ({ label: quest.title, onSelect: () => void moveToQuest(task, quest.id) })),
    ...(task.parentId ? [{ label: own ? `Out of ${own.title}` : 'Out of its quest', onSelect: () => void moveToQuest(task, null) }] : []),
  ];
}

export function todoMenu(task: Task, handlers: TodoMenuHandlers, quests: readonly QuestChoice[] = []): MenuSection[] {
  const actions = todoActions(task);
  const sections: MenuSection[] = [];
  if (actions.snooze) {
    const workStart = daySettingsOf(settings.value ?? undefined).workStart;
    sections.push({ title: 'Later', items: snoozeChoices(Date.now(), workStart).map((choice) => ({ label: choice.label, onSelect: () => void later(task, choice.until, choice.label) })) });
  }
  const options = showAsOptions(task);
  const repeat = task.widget?.type === 'timer' ? task.widget.repeat : undefined;
  if (repeat || (options.length && actions.snooze)) { // a to-do whose widget can change (no mini-app), or one that repeats
    const every: MenuItem[] = TODO_REPEATS.map((value) => ({
      label: REPEAT_LABEL[value], checked: repeat === value, onSelect: () => { if (repeat !== value) void repeatTodo(task, value); },
    }));
    sections.push({ title: 'Repeat', items: [...every, ...(repeat ? [{ label: 'Stop repeating', onSelect: () => void stopRepeating(task) }] : [])] });
  }
  if (options.length && actions.snooze) {
    sections.push({
      title: 'Show as',
      items: options.map((option) => ({ label: option.label, checked: task.widget?.type === option.type, onSelect: () => { if (task.widget?.type !== option.type) void showAs(task, option.type); } })),
    });
  }
  const move = actions.move ? moveItems(task, quests) : [];
  if (move.length) sections.push({ title: 'Move to quest', items: move });
  const more: MenuItem[] = [];
  if (actions.decline) more.push({ label: "Can't do…", onSelect: handlers.onDecline });
  if (actions.sendToTeam) more.push({ label: 'Send to team', onSelect: () => void sendToTeam(task) });
  if (actions.onlyMe) more.push({ label: 'Only me', description: 'I do this one; the AI keeps it in view', checked: Boolean(task.private), onSelect: () => void setOnlyMe(task, !task.private) });
  if (actions.important) more.push({ label: 'Important', checked: task.priority > 0, onSelect: () => void setImportant(task, !(task.priority > 0)) });
  more.push({ label: 'Rename…', onSelect: handlers.onRename });
  more.push({ label: 'Undo last change', onSelect: () => void undoLast(task) });
  if (canOpenChat(task.conversationId)) more.push({ label: 'Open in chat', onSelect: () => openTaskInChat(task) });
  sections.push({ items: more });
  const settle: MenuItem[] = [];
  if (actions.markDone) settle.push({ label: 'Done', onSelect: handlers.onMarkDone });
  if (actions.remove) settle.push({ label: 'Remove', danger: true, onSelect: handlers.onRemove });
  if (settle.length) sections.push({ items: settle });
  return sections;
}
