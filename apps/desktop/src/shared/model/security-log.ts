// The change log of Settings › Security (owner 16.11.2026: every change is written down – who, when, old → new – and can
// be read in the tab). Since 19.11.2026 it records the security mode, each of its switches and lists (settings.json
// section `security`), each topic text (the files <data>/security/<mode>/<topic>.md) and sharing in the public library.
// Owns: the shape of one entry, the field names and the limits. Never: logic (runtime/settings/security-log.ts).

import type { SecurityMode, SecuritySettings, SecurityTopic } from './security-settings.ts';

/**
 * What changed, named where it lives: `security.<key>` a key of settings.json's section `security` (the mode, a switch,
 * a list), `security/<mode>/<topic>.md` a topic file, `libraryPublish` sharing in the public library ('on' | 'off').
 * Entries written before 19.11.2026 may name 'pcAccess' or 'forEveryAgent', the two settings the section replaced.
 */
export type SecurityField =
  | `security.${keyof SecuritySettings & string}`
  | `security/${SecurityMode}/${SecurityTopic}.md`
  | 'libraryPublish'
  | 'pcAccess'
  | 'forEveryAgent';

/** Who changed it, as far as the runtime knows: the person at the PC, their phone, an agent, a colleague, or no caller (an edit of settings.json or of a file, a linked PC). */
export interface SecurityActor {
  kind: 'person' | 'phone' | 'agent' | 'colleague' | 'other';
  /** A name to show: the person's, the agent's; for 'other' what is known. */
  name: string;
  id?: string;
}

export interface SecurityChange {
  at: number;
  field: SecurityField;
  by: SecurityActor;
  /** The old and the new value, cut to SECURITY_LOG_TEXT characters. */
  from: string;
  to: string;
  /** Original length when only a prefix was kept; absent on older entries. */
  fromLength?: number;
  toLength?: number;
  /** Known prior evictions as of this entry. Older versions did not count them. */
  evictedTotal?: number;
}

/** The newest entries kept on a PC. */
export const SECURITY_LOG_MAX = 50;
/** Longest value kept per entry (a topic text can be long). */
export const SECURITY_LOG_TEXT = 600;
