// Live work between the CEO's own PCs (feedback F10, 16.11.2026: "Der arbeitet gerade, obwohl ich hier nichts vom
// Arbeiten sehe"; owner 22.11.2026: "nur das, was eben neu ist … mit den IDs … kurzen Befehlen", a start notice that
// gets through on a bad line, and no line that stays for minutes once no sign of work comes). Runs do not travel between
// PCs (tables.ts); each PC tells its online 'ceo' links what it runs (chat/live.ts snapshot: each running run or split
// part with its activity, step and chats) over the mesh method 'sync.live', in the short form of live-wire.ts:
// - commands, each with this PC's counter `s` (+1 per change): start {s, a: the run}, change {s, i: its id, d: only the
//   fields that changed}, end {s, e: its id} – the changes of GAP_MS gathered into one message, an end at once;
// - a pulse {s, h: a short hash of the whole state} every LIVE_PULSE_MS while this PC has running work – in that round a
//   PC whose last message did not arrive (also the first whole state at link-up) gets the whole state instead;
// - the whole state {runs, s} at link-up and whenever a PC asks for it.
// Messages to one PC go one after the other; a pulse names the number and hash of what is queued before it. A receiver
// keeps the runs as they came (trimmed only for the bar, so every version hashes the same bytes) and applies a command
// only when it is the next number (an older one is in what it holds already); a gap, or a pulse whose `s` or hash is not
// what it holds, makes its answer ask for the whole state (`w`), which goes at once. It announces a PC's runs only when
// they changed, and drops them LIVE_TTL_MS after the last message from that PC – a
// timer per PC, armed while it shows that PC's runs – and when the link goes (device.upserted not online,
// device.removed). A PC on an older version (0.3.16) sends and expects the whole state {runs} and never repeats it: its
// state stays until its next one or its link goes, it hears this PC's state in the answer as before, and it gets the
// whole state on every change until it answers in this form (`v`) – the one branch for it.
// What changes the live bar of a chat is announced there (ChatLive.setRemote) and on the bus as this PC's own activity
// again – windows and phones hear it with the other PCs' runs added (rpc/server.ts, chat/live.ts allActivity). F21:
// 'sync.live.cancel' stops one run on the PC that runs it (runs.cancel forwards a run it does not have here –
// cancelOn); 20.11.2026: with the bar's agent and chat, so a run that is over there by then stops the same agent's run
// that chat shows there now (rpc/handlers/org.ts stopShown). A PC without either method is asked again after its next
// link-up.
// Owns: this exchange, its counter, pulse and expiry, and the forwarding of a Stop. Never: talks to a PC that is no
// 'ceo' link, stores anything, or sends more than the live bar's own fields (no tool input or output, no message text).

import { WorkforceError } from '../../../shared/errors.ts';
import { GAP_MS, type ChatLive, type LiveShare } from '../../chat/live.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { StopHere } from '../../rpc/handlers/org.ts';
import { isCeoPc, links } from './home.ts';
import { diffOf, pack, patched, shareOf, stateHash, unpack, validPacked, type Packed } from './live-wire.ts';

export const LIVE_METHOD = 'sync.live';
export const CANCEL_METHOD = 'sync.live.cancel';
/** While a PC has running work it says so this often (`s` and a short hash). */
export const LIVE_PULSE_MS = 5_000;
/** Another PC's runs leave this long after its last message (three pulses). */
export const LIVE_TTL_MS = 15_000;
/** The runs of one PC taken (more would be a fault there). */
const MAX_RUNS = 100;
/** How long a message or a forwarded Stop may take once it is sent. */
const CALL_MS = 15_000;

/** One command: start (`a`), change (`i` + `d`) or end (`e`), with the sender's counter. */
type Command = { s: number; a?: Packed; i?: string; d?: Packed; e?: string };
type Live = Pick<ChatLive, 'snapshot' | 'onChange' | 'setRemote' | 'remoteActivity' | 'of'>;
/** The live bar's Stop: the agent of its line and the chat it shows in. */
export interface ShownStop { agentId: string; chatId: string }
type Services = Pick<RuntimeServices, 'db' | 'devices' | 'bus' | 'log' | 'dispatcher'>;
type Timer = ReturnType<typeof setTimeout>;
/** What this PC holds of another PC: its runs as they came, the counter they are at (none from an older PC), the expiry. */
interface From { s?: number; runs: Map<string, Packed>; timer?: Timer }

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const errorText = (error: unknown) => String((error as Error)?.message ?? error);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const unref = (timer: Timer): Timer => { (timer as { unref?: () => void }).unref?.(); return timer; };

/** Applies one command to `runs`; false when it cannot be followed (a change of a run not held, a run that is no run). */
function follow(runs: Map<string, Packed>, command: Command): boolean {
  if (command.a !== undefined) {
    if (!validPacked(command.a) || (runs.size >= MAX_RUNS && !runs.has(command.a.i as string))) return false;
    runs.set(command.a.i as string, command.a);
    return true;
  }
  if (typeof command.e === 'string') { runs.delete(command.e); return true; }
  const before = typeof command.i === 'string' ? runs.get(command.i) : undefined;
  const next = before && plain(command.d) ? patched(before, command.d) : undefined;
  if (!validPacked(next) || next.i !== command.i) return false;
  runs.set(command.i!, next);
  return true;
}

export class LiveSync {
  private readonly s: Services;
  private readonly live: Live;
  private readonly cancelHere: (runId: string) => Promise<StopHere>;
  private readonly gapMs: number;
  private readonly pulseMs: number;
  private readonly ttlMs: number;
  private off?: () => void;
  private timer?: Timer;
  private pulse?: Timer;
  private sentAt = 0;
  /** This PC's counter and its runs as last told (what a pulse hashes). */
  private n = 0;
  private held = new Map<string, Packed>();
  /** Per PC: its messages one after the other; the whole state or a pulse waiting there is not queued twice. */
  private readonly lines = new Map<string, Promise<void>>();
  private readonly waiting = new Set<string>();
  /** PCs that answered in this form (the others get the whole state). */
  private readonly fresh = new Set<string>();
  /** PCs whose last message did not arrive: the next pulse round brings them the whole state. */
  private readonly missed = new Set<string>();
  /** PCs without the method (an older version): asked again after their next link-up. */
  private readonly older = new Set<string>();
  /** What this PC holds of the other PCs. */
  private readonly peers = new Map<string, From>();

  /** `cancelHere`: stops a run of this PC (rpc/handlers/org.ts cancelRunHere) – undefined when it has no such run. */
  constructor(s: Services, live: Live, cancelHere: (runId: string) => Promise<StopHere>, gapMs = GAP_MS, pulseMs = LIVE_PULSE_MS, ttlMs = LIVE_TTL_MS) {
    this.s = s;
    this.live = live;
    this.cancelHere = cancelHere;
    this.gapMs = gapMs;
    this.pulseMs = pulseMs;
    this.ttlMs = ttlMs;
  }

  /** A PC is linked: this PC's changes go out; returns the off switch (the other PCs' states go with it). */
  attach(): () => void {
    this.off ??= this.live.onChange(() => this.changed());
    return () => {
      this.off?.();
      this.off = undefined;
      for (const timer of [this.timer, this.pulse]) if (timer) clearTimeout(timer);
      this.timer = undefined;
      this.pulse = undefined;
      for (const peer of [...this.peers.keys()]) this.linkDown(peer);
    };
  }

  /** A CEO PC came online: it gets this PC's whole live state at once (its form is learned again from its answer). */
  linkUp(peer: string): void {
    this.older.delete(peer);
    this.fresh.delete(peer);
    this.missed.delete(peer);
    if (!this.off || !isCeoPc(this.s.db, peer)) return;
    this.flush(); // what changed goes to the others first, so the whole state here is what they hold too
    this.queue(peer, 'whole');
  }

  /** A PC's link went (or its runs stopped coming): what it ran leaves the live bars here. */
  linkDown(peer: string): void {
    const from = this.peers.get(peer);
    if (!from) return;
    if (from.timer) clearTimeout(from.timer);
    this.peers.delete(peer);
    if (from.runs.size) this.show(peer, new Map());
  }

  /** 'sync.live' from a CEO PC: its whole state, commands or a pulse. The answer says this form (`v`) and asks for the whole state when what came does not follow on (`w`). */
  receive(params: unknown, from: string): { v: 2; w?: 1 } | { ok: true; runs?: LiveShare[] } {
    if (!isCeoPc(this.s.db, from)) throw new WorkforceError('forbidden', 'Live work comes only from the CEO\'s own PCs.');
    const body = plain(params) ? params : {};
    const s = typeof body.s === 'number' ? body.s : undefined;
    if (Array.isArray(body.runs)) {
      const runs = new Map<string, Packed>();
      for (const run of body.runs.slice(0, MAX_RUNS)) {
        const packed = plain(run) ? pack(run as unknown as LiveShare) : undefined; // as it came: trimmed only for the bar (shares)
        if (validPacked(packed)) runs.set(packed.i as string, packed);
      }
      this.take(from, runs, s);
      if (s === undefined) { // an older PC: it gets the whole state, and hears this PC's state back as it expects
        this.fresh.delete(from);
        return this.off ? { ok: true, runs: this.shares(this.current()) } : { ok: true };
      }
      this.speaks(from);
      return { v: 2 };
    }
    this.speaks(from);
    const held = this.peers.get(from);
    if (Array.isArray(body.c)) {
      if (held?.s === undefined) return { v: 2, w: 1 };
      const runs = new Map(held.runs);
      let at = held.s;
      let gap = false;
      for (const command of body.c) {
        if (!plain(command) || typeof command.s !== 'number' || command.s <= at) continue; // in what this PC holds already
        if (command.s !== at + 1 || !follow(runs, command as Command)) { gap = true; break; } // the whole state comes instead
        at = command.s;
      }
      this.take(from, at === held.s ? held.runs : runs, at);
      return gap ? { v: 2, w: 1 } : { v: 2 };
    }
    if (s !== undefined && typeof body.h === 'string') {
      if (held) this.take(from, held.runs, held.s); // a sign of work: its runs stay
      return held?.s === s && stateHash(held.runs) === body.h ? { v: 2 } : { v: 2, w: 1 };
    }
    return { v: 2 };
  }

  /** `from` speaks this form: it gets commands and pulses from now on. */
  private speaks(from: string): void {
    if (this.fresh.has(from)) return;
    this.fresh.add(from);
    this.pace();
  }

  /** `from`'s runs as they are now (`s`: its counter; none from an older PC, whose runs never expire); announced only when they changed. */
  private take(from: string, runs: Map<string, Packed>, s: number | undefined): void {
    const before = this.peers.get(from);
    if (before?.timer) clearTimeout(before.timer);
    const timer = s !== undefined && runs.size ? unref(setTimeout(() => {
      this.s.log.info('live work of a PC expired', { peer: from });
      const held = this.peers.get(from);
      if (held) held.s = undefined; // what comes next starts with the whole state
      this.show(from, new Map());
    }, this.ttlMs)) : undefined;
    this.peers.set(from, { ...(s !== undefined ? { s } : {}), runs, ...(timer ? { timer } : {}) });
    if (stateHash(before?.runs ?? new Map()) !== stateHash(runs)) this.show(from, runs);
  }

  /** The live bars here show `runs` for `from` (none: that PC's runs leave). */
  private show(from: string, runs: Map<string, Packed>): void {
    const held = this.peers.get(from);
    if (held) held.runs = runs;
    this.live.setRemote(from, runs.size ? this.shares(runs) : undefined);
    try { this.s.bus.emit('agent.activity', { active: this.s.dispatcher.activity() }); } catch (error) {
      this.s.log.warn('live work not announced', { error: errorText(error) });
    }
  }

  private shares(runs: ReadonlyMap<string, Packed>): LiveShare[] {
    return [...runs.values()].map(unpack).filter((share): share is LiveShare => Boolean(share));
  }

  /**
   * 'sync.live.cancel' from a CEO PC: the Stop of one of this PC's runs – that run, else (it is over here, the asking
   * PC's bar a moment behind) the run of the bar's agent that its chat shows here now. ok: something stopped, or the run
   * is over here and nothing of that agent runs for that chat.
   */
  async cancel(params: unknown, from: string): Promise<{ ok: boolean }> {
    if (!isCeoPc(this.s.db, from)) throw new WorkforceError('forbidden', 'A Stop comes only from the CEO\'s own PCs.');
    const body = plain(params) ? params : {};
    const runId = str(body.runId);
    if (!runId) throw new WorkforceError('bad_request', 'runId names the run to stop.');
    const here = await this.cancelHere(runId);
    if (here === 'stopped') return { ok: true };
    const agentId = str(body.agentId);
    const chatId = str(body.chatId);
    const now = agentId && chatId ? this.live.of(chatId).filter((run) => !run.deviceId && run.agentId === agentId && !run.split && run.runId !== runId) : [];
    for (const run of now) if (await this.cancelHere(run.runId) === 'stopped') return { ok: true };
    return { ok: here === 'ended' && !now.length };
  }

  /** F21: the PC whose live state names this run (never this PC's own). */
  deviceOf(runId: string): string | undefined {
    return this.live.remoteActivity().find((entry) => entry.runId === runId)?.deviceId;
  }

  /** F21: the Stop of a run `peer` runs – true when that PC stopped it or had it over; false when it did not answer or did not know it. */
  async cancelOn(peer: string, runId: string, shown?: ShownStop): Promise<boolean> {
    try {
      const answer = await this.s.devices.call(peer, CANCEL_METHOD, { runId, ...(shown ?? {}) }, undefined, CALL_MS) as { ok?: unknown } | undefined;
      return answer?.ok === true;
    } catch (error) {
      this.s.log.info('stop not forwarded', { peer, runId, error: errorText(error).slice(0, 200) });
      return false;
    }
  }

  // ---------------------------------------------------------------- telling

  /** This PC's runs now, in the normal form, by id. */
  private current(): Map<string, Packed> {
    const runs = new Map<string, Packed>();
    for (const share of this.live.snapshot().map(shareOf)) if (share) runs.set(share.activity.runId, pack(share));
    return runs;
  }

  /** This PC's work changed: the changes of GAP_MS go together, a run's end at once. */
  private changed(): void {
    if (!this.off) return;
    const ended = [...this.held.keys()].some((id) => !this.live.snapshot().some((share) => share.activity.runId === id));
    if (this.timer && !ended) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = ended ? 0 : Math.max(0, this.sentAt + this.gapMs - Date.now());
    this.timer = unref(setTimeout(() => { this.timer = undefined; this.flush(); }, wait));
  }

  /** The commands from what was told to what runs now go to every online CEO PC (the whole state to one on an older form). */
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sentAt = Date.now();
    const now = this.current();
    const commands: Command[] = [];
    for (const [id, run] of now) {
      const before = this.held.get(id);
      const change = before ? diffOf(before, run) : undefined;
      if (!before) commands.push({ s: ++this.n, a: run });
      else if (Object.keys(change!).length) commands.push({ s: ++this.n, i: id, d: change });
    }
    for (const id of this.held.keys()) if (!now.has(id)) commands.push({ s: ++this.n, e: id });
    this.held = now;
    if (commands.length) for (const peer of this.targets()) this.queue(peer, this.fresh.has(peer) ? { c: commands } : 'whole');
    this.pace();
  }

  /** The online CEO PCs that take live work. */
  private targets(): string[] {
    return links(this.s.db).filter(({ record, link }) => link.kind === 'ceo' && !this.older.has(record.id) && this.s.devices.online(record.id)).map(({ record }) => record.id);
  }

  /**
   * While this PC has running work and a CEO PC is online, every LIVE_PULSE_MS each PC in this form gets a pulse and each
   * PC whose last message did not arrive the whole state (its first one at link-up too); none is armed otherwise.
   */
  private pace(): void {
    if (this.pulse || !this.off || (!this.held.size && !this.missed.size) || !this.targets().length) return; // a PC owed the whole state (also an empty one: a lost end) is retried without running work
    this.pulse = unref(setTimeout(() => {
      this.pulse = undefined;
      if (!this.off || (!this.held.size && !this.missed.size)) return;
      for (const peer of this.targets()) {
        if (this.missed.has(peer)) this.queue(peer, 'whole');
        else if (this.fresh.has(peer) && this.held.size) this.queue(peer, 'pulse');
      }
      this.pace();
    }, this.pulseMs));
  }

  /**
   * Queues one message for `peer` after the ones before it, not twice while one waits. A pulse names the number and hash
   * at the moment it is queued – what that PC holds once the messages before it are in; the whole state is made when it
   * goes (commands queued before it then carry numbers it holds already).
   */
  private queue(peer: string, message: 'whole' | 'pulse' | { c: Command[] }): void {
    const pulse = message === 'pulse' ? { s: this.n, h: stateHash(this.held) } : undefined;
    if (typeof message === 'string') {
      if (this.waiting.has(`${peer}|${message}`)) return;
      this.waiting.add(`${peer}|${message}`);
    }
    const next = (this.lines.get(peer) ?? Promise.resolve()).then(() => {
      if (typeof message !== 'string') return this.post(peer, message);
      this.waiting.delete(`${peer}|${message}`);
      return this.post(peer, pulse ?? { runs: this.shares(this.held), s: this.n });
    });
    this.lines.set(peer, next);
    void next.finally(() => { if (this.lines.get(peer) === next) this.lines.delete(peer); });
  }

  private async post(peer: string, message: Plain): Promise<void> {
    try {
      const answer = await this.s.devices.call(peer, LIVE_METHOD, message, undefined, CALL_MS);
      this.missed.delete(peer);
      if (plain(answer) && answer.v === 2) {
        this.speaks(peer);
        if (answer.w) this.queue(peer, 'whole');
      } else {
        // an answer without `v` to a command or a pulse: that PC does not speak this form (a rollback behind a link swap) and
        // blanked our line – it gets the whole state again, and commands only after it answers with `v`
        if (!Array.isArray(message.runs)) { this.fresh.delete(peer); this.queue(peer, 'whole'); }
        if (plain(answer) && Array.isArray(answer.runs)) this.receive({ runs: answer.runs }, peer); // a session build answers with its whole state (0.3.16 / 6b6414b answer {ok:true})
      }
    } catch (error) {
      const text = errorText(error);
      if (/Unknown (peer|device) method/.test(text)) this.older.add(peer);
      else { this.missed.add(peer); this.pace(); } // the next pulse round brings it the whole state
      this.s.log.info('live work not sent', { peer, error: text.slice(0, 200) });
    }
  }
}

// ------------------------------------------------------------------ per runtime

const bound = new WeakMap<object, LiveSync>();

/** Binds this runtime's live sync (sync/service.ts), keyed by its RuntimeServices. */
export function bindLiveSync(services: object, live: LiveSync | undefined): void {
  if (live) bound.set(services, live);
  else bound.delete(services);
}

/** This runtime's live sync, while it has one (runs.cancel reaches it through ctx.services). */
export function liveSyncOf(services: object): LiveSync | undefined {
  return bound.get(services);
}
