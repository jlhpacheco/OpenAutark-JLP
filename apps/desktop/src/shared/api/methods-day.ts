// RPC contract part, COMPATIBILITY ONLY: the four day.* methods 0.3.16/0.3.17 clients still call (cached PWA page, old
// phone UI). My day became the Tasks page (Quests round 20.11.2026); handlers/day.ts answers on today's primitives – the
// person's line (tasks.quickCreate), no planner, no briefing, the work given others. Tier 'todo' as before. New code
// uses tasks.quickCreate / tasks.list; nothing here is for it. Merged into Methods by module augmentation.
// Owns: these method shapes. Never: behaviour.

import type { TaskView } from '../model/tasks.ts';

/** What day.plan answered in 0.3.17; it places nothing any more (the planner is gone), so the lists stay empty. */
export interface LegacyDayPlanResult {
  date: string;
  placed: string[];
  moved: string[];
  unplanned: Array<{ taskId: string; reason: string }>;
  staleSources: string[];
}

declare module '../api/methods.ts' {
  interface Methods {
    /** 'todo' (compat): the person's own input; one plain to-do per line, made like tasks.quickCreate's. `date` (YYYY-MM-DD) is
     *  checked and no longer kept (to-dos have no day-only window). */
    'day.add': { params: { text: string; private?: boolean; clientId?: string; date?: string }; result: { tasks: TaskView[] } };
    /** 'todo' (compat): there is no planner any more – answers an empty result for `date`. */
    'day.plan': { params: { date: string; mode: 'plan' | 'replan' }; result: LegacyDayPlanResult };
    /** 'todo' (compat): there is no morning briefing any more – always null. */
    'day.briefing': { params: { date: string }; result: null };
    /** 'todo' (compat): open and recently done tasks the person gave that others own ("Given by me"). */
    'day.handedOff': { params: { since?: number }; result: TaskView[] };
  }
}
