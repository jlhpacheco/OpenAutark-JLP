// Home's "no AI" notice: after the first run while no model can answer (first-run-model.ts noUsableModel), Home's
// band says "No AI is connected yet – your team can't start." with [Connect] – Settings at its Models group. A status,
// not an offer: no Dismiss; it goes as soon as a model can answer.
// Owner 19.11.2026 (security modes; before: B-085's careful-access line): the Secure-mode notice beside it – after the
// first run, while the company is in Secure mode (settings.json `security`) and this connection may write settings, a
// quiet info line "Secure mode: the app asks you before the team goes beyond what you opened." with [Security settings]
// (Settings › Security, where a mode change needs the double confirm – never a one-click switch from here). Lowest priority.
// Owns: these notices (aiNotice and secureNotice are pure) and their registration (shell/StatusLine.tsx
// registerShellNotices calls registerAiNotice once per app start). Never: shows the no-AI line away from Home, either
// line before the snapshots are in or during the first run, or where this connection may not read the accounts (no
// AI) or write the settings (Secure mode).

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { securityOf, type Settings } from '../../shared/model/system.ts';
import { navigate } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { accounts, loaded, models, route, settings } from '../lib/store.ts';
import { NOTICE_PRIORITY, registerNotice, type Notice } from '../shell/notices.ts';
import { noUsableModel } from './first-run-model.ts';

export const AI_NOTICE_ID = 'no-ai';
export const AI_NOTICE_TEXT = "No AI is connected yet – your team can't start.";
export const SECURE_NOTICE_ID = 'secure-mode';
export const SECURE_NOTICE_TEXT = 'Secure mode: the app asks you before the team goes beyond what you opened.';
export const SECURE_NOTICE_ACTION = 'Security settings';
/** Below every other line: a standing state, never pushing a to-do or a status out of the three shown. */
export const SECURE_NOTICE_PRIORITY = 10;

export interface AiNoticeInput {
  onboarding: Settings['onboarding'] | undefined;
  /** The route is Home. */
  home: boolean;
  /** The snapshots are loaded (before that the account list is empty, not "nothing connected"). */
  loaded: boolean;
  /** This connection may read the accounts (the owner's window). */
  readable: boolean;
  models: readonly ModelInfo[];
  accounts: readonly Account[];
}

/** The band line while no model can answer after the first run, or null. */
export function aiNotice(input: AiNoticeInput, connect: () => void): Notice | null {
  if (!input.home || !input.loaded || !input.readable || input.onboarding?.step !== 'done') return null;
  if (!noUsableModel(input.models, input.accounts)) return null;
  return {
    id: AI_NOTICE_ID, tone: 'warn', priority: NOTICE_PRIORITY.setup,
    text: AI_NOTICE_TEXT,
    actions: [{ label: 'Connect', run: connect }],
  };
}

export interface SecureNoticeInput {
  settings: Pick<Settings, 'onboarding' | 'security'> | null | undefined;
  loaded: boolean;
  /** This connection may write the settings. */
  writable: boolean;
}

/** The quiet line while the company is in Secure mode after the first run, or null. */
export function secureNotice(input: SecureNoticeInput, open: () => unknown): Notice | null {
  const s = input.settings;
  if (!s || !input.loaded || !input.writable || s.onboarding.step !== 'done' || securityOf(s).mode !== 'secure') return null;
  return {
    id: SECURE_NOTICE_ID, tone: 'info', priority: SECURE_NOTICE_PRIORITY,
    text: SECURE_NOTICE_TEXT,
    actions: [{ label: SECURE_NOTICE_ACTION, run: open }],
  };
}

/** Registers both providers (once per app start); returns the function that removes them. */
export function registerAiNotice(): () => void {
  const offs = [
    registerNotice(() => aiNotice({
      onboarding: settings.value?.onboarding,
      home: route.value.view === 'home',
      loaded: loaded.value,
      readable: can('accounts.list'),
      models: models.value,
      accounts: accounts.value,
    }, () => navigate({ view: 'settings', section: 'models' }))),
    registerNotice(() => secureNotice({ settings: settings.value, loaded: loaded.value, writable: can('settings.update') },
      () => navigate({ view: 'settings', section: 'security' }))),
  ];
  return () => { for (const off of offs) off(); };
}
