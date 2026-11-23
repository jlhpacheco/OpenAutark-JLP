// A plan's limit readings between the company's PCs (mesh method 'sync.reading'; owner 22.11.2026: the Codex plan's
// usage stood greyed out on the PC where the agent worked – "es macht ja gar keinen Sinn, dass es ausgegraut ist … das
// kann er direkt abrufen von dem PC"). A limit is the plan's, not a PC's: whichever PC read it last (accounts/monitor.ts
// – its own CLI, its own login) has the plan's current numbers, so every reading goes to each PC that shares the plan
// (plan-peers.ts) within a moment, and the newer reading wins by its own time (readAt). A PC whose own read fails (its
// network gone, its login rotated away while the link was down) shows the plan's numbers another PC read; greyed out
// ("stale reading") then means that no PC of the company read the plan lately. Each PC keeps reading itself. A reading's
// time is turned into this PC's clock by the link's measured offset (link-quality.ts).
// Owns: sending, checking and storing those readings. Never: a login, a token, a state or a cooling time (those are
// each PC's own: its own turns tell), or a reading of a plan kept on its PC.

import type { RuntimeServices } from '../../contracts.ts';
import type { Account, AccountLimits, LimitWindow, ResetCredit } from '../../../shared/model/providers.ts';
import { isPlanProvider } from '../../../shared/model/plan-roles.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { linkOf } from './home.ts';
import { DevicesRepo } from '../repo.ts';
import { planPeers, sharesPlan } from './plan-peers.ts';
import { linkQuality } from '../link-quality.ts';
import { noMethod } from './no-method.ts';

export const READING_METHOD = 'sync.reading';
/** One reading as it travels. */
export interface Reading { account: string; limits: AccountLimits }

/** How long changes gather before they go (a check stores state and limits in one step, a push follows soon). */
const SETTLE_MS = 300;
/** A reading from a clock ahead of this one by more than this counts as read now (it never stays "newest" for good). */
const AHEAD_MS = 60_000;

const short = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function windowOf(value: unknown): LimitWindow | undefined {
  const w = value as LimitWindow;
  if (!w || !short(w.name, 64) || !finite(w.windowMinutes) || !finite(w.usedPercent) || (w.resetsAt !== undefined && !finite(w.resetsAt))) return undefined;
  return { name: w.name, windowMinutes: w.windowMinutes, usedPercent: Math.min(100, Math.max(0, w.usedPercent)), ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) };
}

function creditOf(value: unknown): ResetCredit | undefined {
  const c = value as ResetCredit;
  if (!c || !short(c.id) || (c.title !== undefined && !short(c.title)) || (c.expiresAt !== undefined && !finite(c.expiresAt))) return undefined;
  return { id: c.id, ...(c.title !== undefined ? { title: c.title } : {}), ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}) };
}

/** The reading as this PC stores it, or undefined when anything in it is not a reading. */
export function readingOf(value: unknown, now: number): Reading | undefined {
  const item = value as Reading;
  const limits = item?.limits;
  if (!item || !short(item.account) || !limits || !finite(limits.readAt) || !Array.isArray(limits.windows) || limits.windows.length > 20) return undefined;
  const windows = limits.windows.map(windowOf);
  if (windows.some((w) => !w)) return undefined;
  let resets: AccountLimits['resets'];
  if (limits.resets !== undefined) {
    const r = limits.resets;
    if (!r || !finite(r.available) || (r.credits !== undefined && (!Array.isArray(r.credits) || r.credits.length > 20))) return undefined;
    const credits = r.credits?.map(creditOf);
    if (credits?.some((c) => !c)) return undefined;
    resets = { available: Math.max(0, Math.round(r.available)), ...(credits ? { credits: credits as ResetCredit[] } : {}) };
  }
  return { account: item.account, limits: { windows: windows as LimitWindow[], readAt: Math.min(limits.readAt, now + AHEAD_MS), ...(resets ? { resets } : {}) } };
}

const plan = (account: Account | undefined): account is Account & { limits: AccountLimits } =>
  Boolean(account?.limits) && isPlanProvider(account!.provider) && !account!.thisPcOnly;

export class ReadingSync {
  private readonly s: RuntimeServices;
  /** Per `peer/account`: the newest reading that PC has (sent from here or come from there) – never sent again. */
  private readonly has = new Map<string, number>();
  /** PCs whose version has no 'sync.reading': nothing goes there until the next link-up (catchUp). */
  private readonly older = new Set<string>();
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(s: RuntimeServices) {
    this.s = s;
  }

  /** Hears every stored reading here (a check, a push, one from another PC); returns the off switch. */
  attach(): () => void {
    const off = this.s.bus.on('account.upserted', (account) => { if (plan(account)) this.soon(account.id); });
    return () => {
      off();
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    };
  }

  private soon(id: string): void {
    this.pending.add(id);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, SETTLE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async flush(): Promise<void> {
    const accounts = [...this.pending].map((id) => this.s.accounts.get(id)).filter(plan);
    this.pending.clear();
    for (const peer of planPeers(this.s.db)) if (this.s.devices.online(peer)) await this.post(peer, accounts);
  }

  /** Sends `peer` each reading of `accounts` that it shares and has no newer of; false when the call failed. */
  private async post(peer: string, accounts: readonly Account[]): Promise<boolean> {
    if (this.older.has(peer)) return true;
    const link = linkOf(new DevicesRepo(this.s.db).get(peer));
    const fresh = accounts.filter(plan).filter((account) => sharesPlan(this.s.db, link, account) && (this.has.get(`${peer}/${account.id}`) ?? -Infinity) < account.limits.readAt);
    if (!fresh.length) return true;
    const readings: Reading[] = fresh.map((account) => {
      const { stale: _stale, partial: _partial, ...limits } = account.limits;
      return { account: account.id, limits };
    });
    try {
      await this.s.devices.call(peer, READING_METHOD, { readings });
      for (const reading of readings) this.has.set(`${peer}/${reading.account}`, reading.limits.readAt);
      return true;
    } catch (error) {
      if (noMethod(error)) { this.older.add(peer); this.s.log.info('readings not sent: that PC has none', { peer }); return false; }
      this.s.log.info('readings not sent', { peer, count: readings.length, error: error instanceof WorkforceError ? error.code : 'failed' });
      return false;
    }
  }

  /** What a link-up (`again` false: every reading) or a round in rhythm (only newer ones) owes `peer`. */
  async catchUp(peer: string, again = false): Promise<boolean> {
    if (!again) { this.older.delete(peer); for (const key of [...this.has.keys()]) if (key.startsWith(`${peer}/`)) this.has.delete(key); }
    return this.post(peer, this.s.accounts.list());
  }

  /** 'sync.reading' from a PC that shares the plan: a newer reading is stored here (and goes on from the account change). */
  async receive(params: unknown, from: string): Promise<{ ok: true; applied: number }> {
    const link = linkOf(new DevicesRepo(this.s.db).get(from));
    if (!link) throw new WorkforceError('forbidden', 'This PC takes no readings from that PC.');
    const list = (params as { readings?: unknown } | null)?.readings;
    // that PC's clock, NTP-style from the pings (link-quality.ts): its readAt in this PC's time, so a clock behind never loses
    const offset = linkQuality(from)?.offsetMs ?? 0;
    const now = this.s.clock.now();
    let applied = 0;
    for (const read of (Array.isArray(list) ? list.slice(0, 50) : []).map((item) => readingOf(item, now + offset))) {
      const reading = read && { ...read, limits: { ...read.limits, readAt: read.limits.readAt - offset } };
      const account = reading && this.s.accounts.get(reading.account);
      if (!reading || !account || !isPlanProvider(account.provider) || !sharesPlan(this.s.db, link, account)) continue;
      const key = `${from}/${account.id}`;
      this.has.set(key, Math.max(this.has.get(key) ?? -Infinity, reading.limits.readAt));
      if ((account.limits?.readAt ?? -Infinity) >= reading.limits.readAt) continue; // this PC read it later itself
      this.s.accounts.updateLimits(account.id, reading.limits);
      applied += 1;
    }
    return { ok: true, applied };
  }
}
