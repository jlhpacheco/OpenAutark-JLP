// The one label every note in a turn's input carries: `[note · <time> · <subject>] <text>`.
// Owns: the label and the subjects (a task, a chat, my schedule). Never: reads services or decides which notes a turn gets.

import type { TaskView } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { displayZone, dueText } from '../context/time.ts';

/** The one label of every note: `[note · <time> · <subject>]` – my own situation, never a person's line. */
export function noteLabel(at: number, timezone: string | undefined, subject?: string): string {
  return `[note · ${dueText(at, displayZone(timezone), at)}${subject ? ` · ${subject}` : ''}]`;
}

/** A task as a note's subject: `task_… "<title, at most 60 characters>"`. */
export function taskSubject(task: Pick<TaskView, 'id' | 'title'>): string {
  return `${task.id} "${excerpt(task.title, 60)}"`;
}

/** A chat as a note's subject, as its lines name it: `ch_… "<title, at most 60 characters>"`. */
export function chatSubject(id: string, title: string | undefined): string {
  return title?.trim() ? `${id} "${excerpt(title, 60)}"` : id;
}

/** My schedule as a note's subject: `my schedule sch_… "<title, at most 60 characters>"`. */
export function scheduleSubject(id: string | undefined, title: string | undefined): string {
  return ['my schedule', id, title?.trim() ? `"${excerpt(title, 60)}"` : ''].filter(Boolean).join(' ');
}
