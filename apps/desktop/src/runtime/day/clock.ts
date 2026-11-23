// The person's day as the runtime reads it (B-041 track A2): the profile zone (settings.profile.timezone) and the day
// settings with their defaults filled in. The zone and date math itself is shared/text/when.ts (wallOf/wallTime/addDays).
// Owns: these two reads. Never: reads the clock itself or stores anything.

import { DEFAULT_DAY_SETTINGS, daySettingsOf, type DaySettings } from '../../shared/model/day-settings.ts';
import type { RuntimeServices } from '../contracts.ts';

/** The profile zone (the process zone when settings cannot be read or name no valid zone). */
export function dayZone(s: Partial<Pick<RuntimeServices, 'settings'>>): string {
  try {
    const tz = s.settings?.get().profile.timezone;
    if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; }
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Settings › day with every key (defaults where settings are missing). */
export function daySettings(s: Partial<Pick<RuntimeServices, 'settings'>>): DaySettings {
  try { return daySettingsOf(s.settings?.get()); } catch { return { ...DEFAULT_DAY_SETTINGS }; }
}
