// Home's "no AI" notice after the first run. In Home and chats a quota outage takes its place: one line
// with the next reset and a route to the existing account picker, never a dismissal or automatic adoption.
// Owner 19.11.2026 (security modes; before: B-085's careful-access line): the Secure-mode notice beside it – after the
// first run, while the company is in Secure mode (settings.json `security`) and this connection may write settings, a
// quiet info line "Secure mode: the app asks you before the team goes beyond what you opened." with [Security settings]
// (Settings › Security, where a mode change needs the double confirm – never a one-click switch from here). Lowest priority.
// Owns: these notices (aiNotice and secureNotice are pure) and their registration (shell/StatusLine.tsx
// registerShellNotices calls registerAiNotice once per app start). No account notice before the snapshots or
// during setup, or where the connection cannot read the accounts.

import { effect, signal } from '@preact/signals';
import { MEDIA_ONLY_PROVIDERS, type Account, type ModelInfo } from '../../shared/model/providers.ts';
import { isUsableState } from '../../shared/model/plan-roles.ts';
import { extraUsageAllowed, quotaResetAt } from '../../shared/model/plan-quota.ts';
import { resetClock } from '../lib/limits.ts';
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
  /** An open chat, where a quota hold otherwise only appears on each agent. */
  chat?: boolean;
  /** The snapshots are loaded (before that the account list is empty, not "nothing connected"). */
  loaded: boolean;
  /** This connection may read the accounts (the owner's window). */
  readable: boolean;
  models: readonly ModelInfo[];
  accounts: readonly Account[];
}

/** The band line while no model can answer after the first run, or null. */
export function aiNotice(input: AiNoticeInput, connect: () => void, now = Date.now()): Notice | null {
  if ((!input.home && !input.chat) || !input.loaded || !input.readable || input.onboarding?.step !== 'done') return null;
  const reset = firstQuotaReset(input.accounts, now);
  if (reset !== undefined) return {
    id: AI_NOTICE_ID, tone: 'warn', priority: NOTICE_PRIORITY.setup,
    text: 'Model accounts used up until ' + resetClock(reset, now),
    actions: [{ label: 'Use another account', run: connect }],
  };
  if (!input.home || !noUsableModel(input.models, input.accounts)) return null;
  return {
    id: AI_NOTICE_ID, tone: 'warn', priority: NOTICE_PRIORITY.setup,
    text: AI_NOTICE_TEXT,
    actions: [{ label: 'Connect', run: connect }],
  };
}

/** All signed-in work accounts must have a known account-wide hold. Missing readings do not prove an outage. */
function firstQuotaReset(accounts: readonly Account[], now: number): number | undefined {
  let first: number | undefined;
  for (const account of accounts) {
    if (!isUsableState(account) || account.provider === 'decision-api' || MEDIA_ONLY_PROVIDERS.includes(account.provider)) continue;
    const reset = extraUsageAllowed(account) ? undefined : quotaResetAt(account.limits, now);
    if (reset === undefined) return undefined;
    first = Math.min(first ?? Infinity, reset);
  }
  return first;
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
  const quotaTick = signal(0);
  const offs = [
    effect(() => {
      // Keep the status honest even when no account event arrives exactly as the window ends.
      quotaTick.value;
      const now = Date.now();
      const reset = firstQuotaReset(accounts.value, now);
      if (reset === undefined) return;
      const timer = setTimeout(() => { quotaTick.value++; }, Math.min(2_147_483_647, reset - now));
      return () => clearTimeout(timer);
    }),
    registerNotice(() => {
      quotaTick.value;
      return aiNotice({
        onboarding: settings.value?.onboarding,
        home: route.value.view === 'home',
        chat: route.value.view === 'chat',
        loaded: loaded.value,
        readable: can('accounts.list'),
        models: models.value,
        accounts: accounts.value,
      }, () => navigate({ view: 'settings', section: 'models' }));
    }),
    registerNotice(() => secureNotice({ settings: settings.value, loaded: loaded.value, writable: can('settings.update') },
      () => navigate({ view: 'settings', section: 'security' }))),
  ];
  return () => { for (const off of offs) off(); };
}
