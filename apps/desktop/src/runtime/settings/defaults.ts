// Default values for the full Settings shape, built from the definitions in schema.ts (each default is written
// down there once, next to what the key does). Language and time zone come from the OS. F07 (owner 15.11.2026: "die
// Standardsprache ist immer Englisch", another one only when the PC says so): the language is the PC's display language
// (AUTARK_SYSTEM_LANGUAGE, set by the desktop app, main/runtime-link.ts), Intl's locale only in a runtime started
// without the app, and English for anything unusable. A stored profile language stays as it is.
// Owns: what a fresh installation starts with and this PC's locale. Never: persistence or validation.
// Defaults follow the confirmed decisions: pushes only for human to-dos, blockers and important messages, with a
// sound (B-072); the day (B-041): working hours 08:00–20:00, 10 min buffer, the night until 06:00, AI helps on, keep
// awake on; B-044: Realtime call voice off; B-055: a new install starts with the feedback tour.

import type { Settings } from '../../shared/model/system.ts';
import { SECTIONS, defaultOf, type KeyDef, type PcDefaults } from './schema.ts';

export interface SystemEnvironment {
  locale?: string; // e.g. 'de-DE'; default Intl
  timezone?: string; // IANA; default Intl
}

/** This PC's display language (AUTARK_SYSTEM_LANGUAGE from the desktop app, else Intl's locale) and Intl's time zone. */
export function systemEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Required<SystemEnvironment> {
  const options = Intl.DateTimeFormat().resolvedOptions();
  return { locale: env.AUTARK_SYSTEM_LANGUAGE?.trim() || options.locale || 'en', timezone: options.timeZone || 'UTC' };
}

/** 'de-DE' → 'de'; anything unusable → 'en'. */
export function languageOf(locale: string): string {
  const match = /^([a-z]{2,3})(?:[-_]|$)/i.exec(locale.trim());
  return match ? match[1].toLowerCase() : 'en';
}

/** The defaults of every section that has them (schema.ts – the one place each default is written down). */
export function defaultSettings(env: SystemEnvironment = {}): Settings {
  const system = systemEnvironment();
  const pc: PcDefaults = { language: languageOf(env.locale ?? system.locale), timezone: env.timezone ?? system.timezone };
  const out: Record<string, unknown> = {};
  for (const section of SECTIONS) if (!section.optional) out[section.key] = defaultsOf(section.keys, pc);
  return out as unknown as Settings;
}

/** The keys of `defs` that have a default (nested objects included). */
function defaultsOf(defs: readonly KeyDef[], pc: PcDefaults): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const value = def.keys ? defaultsOf(def.keys, pc) : defaultOf(def, pc);
    if (value !== undefined) out[def.key] = value;
  }
  return out;
}
