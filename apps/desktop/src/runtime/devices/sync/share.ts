// Umzug 21.11.2026, part 2 (owner: "dann ist sie praktisch auf beiden PCs zu Hause … auch weitere Dinge synchronisiert,
// damit die KI wirklich übergreifend arbeiten kann, so wie Browser und Dateien"): what else stays the same on every PC
// an agent is at home on – its browser sign-ins (share-browser.ts) and its home project (share-project.ts). Mesh method
// 'sync.share', 'ceo' links only, and only between the PCs of one agent's homes: the PC it runs on (`deviceId`) and its
// `homes`, as this PC's own agents row names them (homePeers) – a PC outside them is refused, an agent at home on one
// PC shares nothing. The set is read again when an agent's row or its agent.json changes. At every catch-up (service.ts:
// at link-up and in rhythm) the browser states a home PC has not got go first (awaited: the wakes that follow may open a
// page; a repeat with nothing new sends nothing); at link-up the home projects' whole lists follow in the background –
// a list needs a look at the whole folder, like the file rescan, so between link-ups the folder watch and a take's
// ask-again carry the changes (share-project.ts). shareNow is
// the leave: the open browser's state and the project changes still waiting go to the other homes before the agent
// starts there. A home PC that does not mirror the project says why; the agent reads that once, on the PC it runs on,
// at the start of its next turn.
// Owns: this wiring, who an agent's home PCs are, and that one line. Never: sends to a PC that is no home of the agent
// or no 'ceo' link, or logs what travels.

import type { RuntimeServices } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { MAIN_THREAD } from '../../../shared/model/origin.ts';
import { saveRepairNotes } from '../../agents/turn-finish.ts';
import { profileHooks } from '../../browser/sessions.ts';
import { KvRepo } from '../../store/kv.ts';
import { homeElsewhere, isCeoPc, selfId } from './home.ts';
import { BrowserShare } from './share-browser.ts';
import { ProjectShare } from './share-project.ts';

export const SHARE_METHOD = 'sync.share';
const TOLD_NS = 'share.told';
/** Row and agent.json changes gather this long before the set of mirrors is read again. */
const REFRESH_MS = 300;
/** The longest a leave waits for shareNow. */
const NOW_MS = 10_000;

/** The other PCs `agentId` is at home on, as this PC sees it: my own linked PCs among the one it runs on and its `homes`; empty when this PC is none of them. */
export function homePeers(s: Pick<RuntimeServices, 'db' | 'org'>, agentId: string): string[] {
  try {
    const agent = s.org.get(agentId);
    const self = selfId(s.db);
    if (!agent || agent.archivedAt || !self) return [];
    const all = new Set([agent.deviceId || self, ...(agent.homes ?? [])]);
    return all.has(self) ? [...all].filter((id) => id !== self && isCeoPc(s.db, id)) : [];
  } catch {
    return [];
  }
}

const running = new WeakMap<object, ShareSync>();

export class ShareSync {
  private readonly s: RuntimeServices;
  readonly browser: BrowserShare;
  readonly project: ProjectShare;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(s: RuntimeServices) {
    this.s = s;
    const deps = {
      call: (peer: string, params: Record<string, unknown>) => s.devices.call(peer, SHARE_METHOD, params),
      peers: (agentId: string) => homePeers(s, agentId),
    };
    this.browser = new BrowserShare(s, deps);
    this.project = new ProjectShare(s, { ...deps, told: (agentId, peer, why) => this.told(agentId, peer, why) });
    // For the runtime's whole life: a browser that closes at shutdown still leaves its state for the next link-up.
    if (s.paths) profileHooks.set(s.paths, this.browser.hooks());
    running.set(s, this);
  }

  /** While a PC is linked: the agents' rows and agent.json files say which home projects are mirrored; returns the off switch. */
  attach(): () => void {
    const soon = () => {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.refresh(); }, REFRESH_MS);
      (this.timer as { unref?: () => void }).unref?.();
    };
    // settings.updated: this PC's security rules may have closed or opened a home folder (review R3 M3)
    const offs = [this.s.bus.on('agent.upserted', soon), this.s.bus.on('agentCore.changed', soon), this.s.bus.on('settings.updated', soon)];
    this.refresh();
    return () => {
      for (const off of offs) off();
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.project.stop();
    };
  }

  /** Reads who is at home where: mirrors open and close, and a state kept for an agent that is at home only here goes. */
  refresh(): void {
    try {
      this.project.refresh();
      for (const agentId of this.browser.agents()) if (!homePeers(this.s, agentId).length) void this.browser.forget(agentId).catch(() => undefined);
    } catch (error) {
      this.s.log.warn('homes not read', { error: String((error as Error)?.message ?? error) });
    }
  }

  /** What a catch-up owes one of my PCs: the browser states (awaited), then – at link-up, not `again` – the home projects' lists. */
  async catchUp(peer: string, again = false): Promise<void> {
    if (!isCeoPc(this.s.db, peer)) return;
    await this.browser.catchUp(peer);
    if (!again) this.project.catchUp(peer);
  }

  /** 'sync.share' from one of my PCs. */
  async receive(params: unknown, from: string): Promise<unknown> {
    if (!isCeoPc(this.s.db, from)) throw new WorkforceError('forbidden', 'This comes only from my own PCs.');
    const p = (params ?? {}) as { op?: unknown; agentId?: unknown };
    if (typeof p.agentId !== 'string') throw new WorkforceError('bad_request', 'Unknown share request.');
    return p.op === 'browser' ? this.browser.receive(p, from) : this.project.receive(p, from);
  }

  /** PC `pc` (undefined: this one) said why it does not mirror the project: the agent reads it once, on the PC it runs on (a new reason once more). */
  private told(agentId: string, pc: string | undefined, why: string | undefined): void {
    try {
      if (homeElsewhere(this.s, agentId)) return;
      const kv = new KvRepo(this.s.db);
      const key = `${agentId}/${pc ?? selfId(this.s.db)}`;
      const before = kv.get<string>(TOLD_NS, key);
      if (!why) { if (before !== undefined) kv.delete(TOLD_NS, key); return; }
      if (before === why) return;
      kv.set(TOLD_NS, key, why, this.s.clock.now());
      saveRepairNotes(this.s, agentId, MAIN_THREAD, [`My home project is not mirrored: ${why}.`]);
    } catch (error) {
      this.s.log.warn('home project line not kept', { agentId, error: String((error as Error)?.message ?? error) });
    }
  }
}

/**
 * The leave or hand-over moment: `agentId`'s open browser state and the home-project changes still waiting here go to its
 * other home PCs now. Resolves when they are on their way (bounded); never throws.
 */
export async function shareNow(s: RuntimeServices, agentId: string): Promise<void> {
  const share = running.get(s);
  if (!share) return;
  const done = Promise.all([share.browser.now(agentId), share.project.flush(agentId)]).catch(() => undefined);
  await Promise.race([done, new Promise<void>((resolve) => { (setTimeout(resolve, NOW_MS) as { unref?: () => void }).unref?.(); })]);
}
