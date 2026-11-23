// B-088 (owner 10.11.2026: "es ging mal richtig schnell, jetzt dauert das Transkribieren ultra lange"): a dictation
// is written down by the person's ChatGPT plan in ONE request, the way the Codex app's own microphone does it:
// POST chatgpt.com/backend-api/transcribe with the take as the file (and a language when one is known) answers {text}.
// Measured 10.11.2026 on the plan login of this PC (probe, d0511.wav): 42 s of speech in 1.8 s, 125 s in 4.3 s, the
// language detected without a hint, and the call went through while Codex's weekly limit stood at 100 % (it is no
// Codex turn). A Codex turn hears audio only on a model the catalog lists as hearing (decision/listener.ts
// hearsAudio; on 17.11.2026 the plan's frontier model, never its small one); a dictation goes here, one request without
// a model turn, and nothing of the CLI's own context goes along: the file and the language are the whole request.
// The take goes up as it is stored: a WAV, or once the plan heard the page's last piece, Ogg Opus (ui/lib/ogg-opus.ts).
// The endpoint is not documented by OpenAI; every failure (no plan login, a rejected login, a limit, the network, an
// answer without text) throws a user-safe WorkforceError and transcribe.ts goes on with this PC's model as before.
// The login: the one place the app reads a plan token (owner-visible exception to the old "never read tokens" rule,
// docs/DECISIONS.md B-088): the access token and the account id of the plan's CODEX_HOME auth.json are read per
// request, kept in memory only and sent nowhere but to chatgpt.com, the issuer – and, since STIMME 21.11.2026 (owner:
// "transcribing via Codex does not have to go over the PC"), to the person's own paired phone over its secure link
// (phoneLogin, RPC voice.planLogin: the access token, the account id and the token's own expiry, never the refresh
// token), whose app sends a dictation to the same endpoint itself and keeps the login in memory until it expires. The
// app never refreshes a token itself (refresh tokens rotate, a second client would log Codex out): on a rejection – here
// or on the phone, which then asks for a fresh login – the account's own Codex server is asked to refresh (account/read
// refreshToken) and the file is read once more.
// The answer names the uploaded audio as an asset with a 30-day lifetime (asset_ttl, measured 10.11.2026): the ChatGPT
// side keeps the take that long, like a dictation made in ChatGPT itself. The owner was told on 10.11.2026.
// Owns: reading the login, the request, the one refresh-and-retry and the phone's copy of the login. Never: logs or
// stores a token, an account id or the answer's asset pointer, or returns them to anyone but phoneLogin's caller;
// refreshes a token itself; sends audio anywhere but the one endpoint.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Account } from '../../shared/model/providers.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { defaultHome } from '../accounts/cli-homes.ts';
import { accountCharge } from '../../shared/model/charge.ts';
import { endpointHeard, uploadOf, uploadWay, type FetchFn, type Heard } from './transcribe-endpoint.ts';

export const PLAN_TRANSCRIBE_URL = 'https://chatgpt.com/backend-api/transcribe';
/** One request's limit: a dictation that takes longer is given up on, this PC's model hears it instead. */
export const PLAN_TRANSCRIBE_MS = 45_000;
/** The account's own server refreshes its login within this (account/read refreshToken). */
export const PLAN_REFRESH_MS = 20_000;
const AUTH_FILE_MAX_BYTES = 256 * 1024;
/** A login whose token names no expiry goes to the phone for this long. */
export const PHONE_LOGIN_UNKNOWN_MS = 10 * 60_000;
/** A token this close to its expiry is refreshed before it goes to the phone. */
export const PHONE_LOGIN_MARGIN_MS = 60_000;

/** The plan's transcription of one take (this module's default; tests replace it). */
export type PlanTranscription = (s: RuntimeServices, ref: FileRef, language: string | undefined, fetch?: FetchFn) => Promise<Heard>;

/**
 * The plan logins a dictation may use (16.11.2026, owner: "der transkriptions-Service ist schlecht"; KI-Runde 17.11.2026:
 * from the day the Codex week ran out every line was heard by this PC's small model): read from every account, not
 * the router's candidates – those leave out an account whose window is used up or that cools, and the dictation endpoint
 * is no Codex turn, so a Codex limit does not stop it (measured 10.11.2026 at 100 % weekly). A model list that timed out
 * ('error') or a state not probed yet ('unknown') says nothing about the login either. Only a login that is gone
 * ('needs_login') or an account that is switched off is skipped.
 */
function planLogins(s: Pick<RuntimeServices, 'accounts'>): Account[] {
  let accounts: Account[];
  try { accounts = s.accounts.list(); } catch { return []; }
  return accounts.filter((account) => account.provider === 'codex' && accountCharge(account) === 'plan').sort((a, b) => a.priority - b.priority);
}

const usable = (account: Account) => account.enabled && account.state !== 'needs_login' && account.state !== 'disabled';

/** The plan login a dictation uses: a ready one first, else one in any other signed-in state; undefined when none is signed in. */
export function planAccount(s: Pick<RuntimeServices, 'accounts'>): Account | undefined {
  const logins = planLogins(s).filter(usable);
  return logins.find((account) => account.state === 'ok') ?? logins[0];
}

/** A signed-in ChatGPT plan login (Codex) is here: the one thing the default way needs (cheap: no file read, no network). */
export function planReady(s: Pick<RuntimeServices, 'accounts'>): boolean {
  return planAccount(s) !== undefined;
}

/** Why a dictation went without the plan, for the log line (no names, no ids). */
export function planMissing(s: Pick<RuntimeServices, 'accounts'>): 'no_plan_login' | 'needs_login' | 'disabled' {
  const logins = planLogins(s);
  if (logins.some((account) => account.enabled && account.state === 'needs_login')) return 'needs_login';
  if (logins.length) return 'disabled';
  return 'no_plan_login';
}

interface PlanLogin { token: string; accountId: string | undefined }

/** The plan login of an account's home: undefined when the file or its ChatGPT tokens are not there (an API-key login has none). */
async function readLogin(account: Account): Promise<PlanLogin | undefined> {
  const home = account.home ?? defaultHome('codex');
  if (!home) return undefined;
  const file = path.join(home, 'auth.json');
  try {
    if ((await stat(file)).size > AUTH_FILE_MAX_BYTES) return undefined;
    const tokens = (JSON.parse(await readFile(file, 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } } | null)?.tokens;
    const token = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : '';
    if (!token || /\s/.test(token)) return undefined;
    const accountId = typeof tokens?.account_id === 'string' && tokens.account_id.trim() ? tokens.account_id.trim() : undefined;
    return { token, accountId };
  } catch { return undefined; }
}

/** The account's own Codex server refreshes its login (the official CLI owns it); false when that did not work. */
async function refresh(s: RuntimeServices, account: Account): Promise<boolean> {
  try {
    const engine = s.engines.get('codex');
    if (!engine.realtime) return false;
    const link = await engine.realtime(account);
    const release = link.hold();
    try { await link.request('account/read', { refreshToken: true }, PLAN_REFRESH_MS); return true; } finally { release(); }
  } catch { return false; }
}

/** The take written down by the plan's dictation; throws a user-safe error so the caller goes on with this PC's model. */
export const planTranscribe: PlanTranscription = async (s, ref, language, fetchFn) => {
  const account = planAccount(s);
  if (!account) throw new WorkforceError('unavailable', 'No ChatGPT plan login is signed in here.');
  const upload = await uploadOf(s, ref, uploadWay(s, ref));
  const fetchUsed = fetchFn ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const login = await readLogin(account);
    if (!login) throw new WorkforceError('unavailable', 'The ChatGPT plan login has no usable token here.');
    try {
      return await endpointHeard({
        url: PLAN_TRANSCRIBE_URL, key: login.token, ...(login.accountId ? { headers: { 'ChatGPT-Account-Id': login.accountId } } : {}),
        ...(language ? { language } : {}), dictation: true, fetch: fetchUsed, timeoutMs: PLAN_TRANSCRIBE_MS,
      }, upload);
    } catch (error) {
      const rejected = error instanceof WorkforceError && error.details?.status === 401;
      if (!rejected || attempt > 0 || !await refresh(s, account)) throw error;
    }
  }
};

/** The plan login as the person's own phone gets it (RPC voice.planLogin): `expiresAt` from the token's own exp. */
export interface PhoneLogin { token: string; accountId?: string; expiresAt: number }

/** The token's own expiry (a JWT's exp, in ms), or undefined when it names none. */
export function tokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown } | null)?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch { return undefined; }
}

/**
 * The plan login for the person's own phone (the caller checked it is that phone): read like a dictation here; `fresh`
 * – the phone's copy was rejected – or a token about to expire is refreshed by the account's own Codex server first.
 * Throws a user-safe error (no login, no refresh) and the phone sends its take to the PC as before.
 */
export async function phoneLogin(s: RuntimeServices, fresh: boolean, now: number): Promise<PhoneLogin> {
  const account = planAccount(s);
  if (!account) throw new WorkforceError('unavailable', 'No ChatGPT plan login is signed in here.');
  const refreshed = async () => {
    if (!await refresh(s, account)) throw new WorkforceError('unavailable', 'The ChatGPT plan login could not be refreshed here.');
    return readLogin(account);
  };
  let login = fresh ? await refreshed() : await readLogin(account);
  let expiry = login && tokenExpiry(login.token);
  if (login && !fresh && expiry !== undefined && expiry - now < PHONE_LOGIN_MARGIN_MS) {
    login = await refreshed();
    expiry = login && tokenExpiry(login.token);
  }
  if (!login) throw new WorkforceError('unavailable', 'The ChatGPT plan login has no usable token here.');
  if (expiry !== undefined && expiry - now < PHONE_LOGIN_MARGIN_MS) throw new WorkforceError('unavailable', 'The ChatGPT plan login here has expired.');
  return { token: login.token, ...(login.accountId ? { accountId: login.accountId } : {}), expiresAt: expiry ?? now + PHONE_LOGIN_UNKNOWN_MS };
}
