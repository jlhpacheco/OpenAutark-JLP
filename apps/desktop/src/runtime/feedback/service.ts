// Owns: local human/agent reports, redaction, deduplication (agents: the same text; 16.11.2026 people: the writing
// device's clientId), the report's context (this PC's version and OS, where it was written, this company's folder),
// whether this build can send (`status`: a receiver shipped in resources/feedback/receiver.json) and delivery
// (delivery.ts: sealed for the team, B-055), plus the team side on the PC holding the team's key (inbox.ts, setup.ts),
// and the feedback log lines (B-085): at start whether sending is set up, then one line per sent (id, receipt) or
// failed (id, code, reason, status) report.
// 16.11.2026 (owner: "dass das Feedback verloren geht, … wäre sehr schlecht"): a report whose sealed letter is still to
// go is sent again by itself – at start, after any send that went through, and once RESEND_AFTER_MS after a send that
// found no connection or server (one unref'd timer, only while such a report waits). 21.11.2026: whoever wrote it – an
// agent's report is sealed only when its own tool sent it (Trust AI mode), so an older build's agent report that waits
// under Settings › Feedback › From agents has no letter and stays as it is; an agent's waiting letter goes only while
// the company is in Trust AI mode (feedbackOpen – switched to Secure, it waits). A letter the mailbox refused never
// goes by itself.
// Owner 21.11.2026: a report carries up to FEEDBACK_IMAGES_MAX images (`imageFileIds`, in order).
// Never: opens an issue form, publishes anything (every report is sealed for the team; `visibility` is ignored),
// claims delivery before the mailbox answered, polls, or logs a report's text. Older browser drafts ('queued', with
// their stored url) stay readable.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { FeedbackApi } from '../rpc/extras.ts';
import { type FeedbackKind, type FeedbackReport, type FeedbackVisibility } from '../../shared/model/system.ts';
import { FEEDBACK_CLIENT_DIAGNOSTICS_MAX, FEEDBACK_CLIENT_MAX, FEEDBACK_IMAGES_MAX, type FeedbackContext, type FeedbackSetupResult, type FeedbackStatus } from '../../shared/model/feedback-delivery.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { FeedbackRepo } from '../store/feedback.ts';
import { FIRST_FOLDER } from '../../shared/model/companies.ts';
import { redactText } from '../../shared/secrets/redact-text.ts';
import { deliver, OUTBOX, resendable, type OutboxEntry } from './delivery.ts';
import type { DropReason } from './drop.ts';
import { FeedbackInbox } from './inbox.ts';
import { readReceiver, receiverPath, type ReceiverConfig } from './receiver.ts';
import { setupReceiver, type SetupInput } from './setup.ts';

const KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];
const MAX_TEXT = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** New reports one agent may file per 24 h (repeats of the same text only raise `count`). */
export const AGENT_REPORTS_PER_DAY = 5;
/** After a send that found no connection or server, the reports still to go are tried again once this much later. */
export const RESEND_AFTER_MS = 10 * 60 * 1000;
/** Why a send may go by itself later; 'refused' and 'not_set_up' wait for a person. */
const PASSING: readonly DropReason[] = ['offline', 'timeout', 'server'];

export interface FeedbackInput {
  /** Agents always; a person's report may leave it out. */
  kind?: FeedbackKind;
  text: string;
  /** The report's images in order (stored file ids, each as it goes), at most FEEDBACK_IMAGES_MAX. */
  imageFileIds?: string[];
  /** People only: the text was dictated – it is the transcript (owner 20.11.2026: a report never carries a recording). */
  dictated?: boolean;
  view?: string;
  conversationId?: string;
  /** The agent run that filed the report (agent reports only). */
  runId?: string;
  /** People only: the writing device's id for the report – the same id returns the stored report. */
  clientId?: string;
  /** People only: where the report was written (the page's facts), kept to FEEDBACK_CLIENT_MAX. */
  client?: string;
  /** People only: the writing device's own diagnostics, kept to FEEDBACK_CLIENT_DIAGNOSTICS_MAX. */
  clientDiagnostics?: string;
  author: string;
}

/** This company's data folder on this PC: 'first' (the app's own folder) or its id ('company-2'); undefined without companies (tests, headless). */
export function companySlot(s: Pick<RuntimeServices, 'host' | 'paths'>): string | undefined {
  const info = s.host.app.companies;
  if (!info) return undefined;
  return path.resolve(s.paths.data) === path.resolve(info.first) ? FIRST_FOLDER : path.basename(s.paths.data);
}

/**
 * True when this company runs in Trust AI mode – the only mode with feedback.report and the only one in which an agent's
 * waiting letter goes out by itself; unreadable counts as not.
 */
export function feedbackOpen(services: Pick<RuntimeServices, 'security'>): boolean {
  try { return services.security?.current().mode === 'trust'; } catch { return false; }
}

/** A failed send that may go by itself later (no connection, no answer in time, a server error). */
export function passing(error: unknown): boolean {
  return error instanceof WorkforceError && PASSING.includes(error.details?.reason as DropReason);
}

export interface SendOptions {
  /** Accepted for older clients and ignored: every report is sealed for the team (B-055). */
  visibility?: FeedbackVisibility;
  /** Accepted for older clients; images are transferred with the report. */
  reveal?: boolean;
}

/** Delay of the start's resend and its one inbox fetch (receiving PCs only), so neither competes with the start itself. */
export const START_FETCH_DELAY_MS = 15_000;

export interface FeedbackDeps {
  services: () => RuntimeServices;
  repo?: FeedbackRepo;
  /** OS label for reports (tests); default "<platform> <release> <arch>". */
  os?: string;
  /** The receiver (tests); default resources/feedback/receiver.json. `null`: sending is not set up. */
  receiver?: ReceiverConfig | null;
  fetch?: typeof globalThis.fetch;
  /** Google's endpoints for the team inbox (tests). */
  firestore?: string;
  tokenUrl?: string;
}

/** Comparison key for "the same report": case and whitespace do not matter. */
function sameTextKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The log facts of a failed send: our own error code, reason and status – never the report or a remote body. */
export function sendFailure(id: string, error: unknown): Record<string, unknown> {
  const details = error instanceof WorkforceError ? error.details : undefined;
  return {
    id,
    code: error instanceof WorkforceError ? error.code : 'internal',
    ...(details?.reason !== undefined ? { reason: details.reason } : {}),
    ...(details?.status !== undefined ? { status: details.status } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
}

export class FeedbackService implements FeedbackApi {
  private readonly deps: FeedbackDeps;
  private repoInstance: FeedbackRepo | undefined;
  private readonly sending = new Map<string, Promise<FeedbackReport>>();
  /** The running resend pass (one at a time) and the one timer of the next try after a failed send. */
  private resending: Promise<number> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** The team inbox (owner only, RPC feedback.inbox*); empty on every PC without the team's key. */
  readonly inbox: FeedbackInbox;

  constructor(deps: FeedbackDeps) {
    this.deps = deps;
    this.repoInstance = deps.repo;
    this.inbox = new FeedbackInbox({ services: deps.services, fetch: deps.fetch, firestore: deps.firestore, tokenUrl: deps.tokenUrl });
  }

  /**
   * Once at app start: one line whether this build can send; shortly after, the reports still to go are sent again and,
   * on the team's PC, the inbox is fetched once (no timer after it).
   */
  start(): void {
    const s = this.deps.services();
    const receiver = this.receiver(s);
    if (receiver) s.log.info('feedback sending set up', { project: receiver.project });
    else s.log.warn('feedback sending not set up: reports stay on this PC', { receiverFile: receiverPath(s) });
    const timer = setTimeout(() => {
      void this.resendPending();
      if (!this.inbox.receiving()) return;
      this.inbox.fetch().catch((error: unknown) => this.deps.services().log.warn('feedback inbox fetch failed', { error: error instanceof Error ? error.message : String(error) }));
    }, START_FETCH_DELAY_MS);
    timer.unref?.();
  }

  /**
   * Sends every report again whose sealed letter is still to go (oldest first); answers how many went. A
   * pass that finds no connection stops there and tries once more RESEND_AFTER_MS later. One pass at a time.
   */
  resendPending(): Promise<number> {
    this.resending ??= this.resendOnce()
      .catch((error: unknown) => { this.deps.services().log.warn('feedback resend failed', { error: error instanceof Error ? error.message : String(error) }); return 0; })
      .finally(() => { this.resending = undefined; });
    return this.resending;
  }

  private async resendOnce(): Promise<number> {
    const s = this.deps.services();
    if (!this.receiver(s)) return 0;
    const kv = new KvRepo(s.db);
    let sent = 0;
    const agentsMay = feedbackOpen(s);
    for (const report of this.repo(s).byStatus('local')) {
      if (report.author !== HUMAN_ID && !agentsMay) continue; // Secure mode: nothing of an agent's leaves this PC
      if (!resendable(kv.get<OutboxEntry>(OUTBOX, report.id))) continue;
      try {
        await this.send(report.id);
        sent += 1;
      } catch (error) {
        if (passing(error)) return sent; // no connection: the timer send() armed tries again
      }
    }
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; } // nothing that can go by itself waits now
    return sent;
  }

  /** The one timer of the next resend, armed after a failed send while no other waits. */
  private retryLater(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.resendPending(); }, RESEND_AFTER_MS);
    this.retry.unref?.();
  }

  /** wf feedback setup (owner only). */
  setup(input: SetupInput): Promise<FeedbackSetupResult> {
    return setupReceiver(this.deps.services(), input);
  }

  create(input: FeedbackInput): FeedbackReport {
    const s = this.deps.services();
    const author = input.author || HUMAN_ID;
    const human = author === HUMAN_ID;
    if (input.kind !== undefined ? !KINDS.includes(input.kind) : !human) throw new WorkforceError('bad_request', 'Choose bug, idea, change or praise.');
    const clientId = human ? input.clientId : undefined;
    const known = clientId ? this.repo(s).byClientId(HUMAN_ID, clientId) : undefined;
    if (known) return known; // the device's retry after a lost answer: no second report
    const textValue = typeof input.text === 'string' ? input.text.trim() : '';
    if (!textValue) throw new WorkforceError('bad_request', 'Describe the problem or idea.');
    if (textValue.length > MAX_TEXT) throw new WorkforceError('bad_request', `Keep the report under ${MAX_TEXT} characters.`);
    const imageFileIds = input.imageFileIds ?? [];
    if (imageFileIds.length > FEEDBACK_IMAGES_MAX) throw new WorkforceError('bad_request', `Attach at most ${FEEDBACK_IMAGES_MAX} images.`);
    for (const id of imageFileIds) {
      if (!s.files.get(id)) throw new WorkforceError('not_found', 'An attached image was not found.');
    }
    const now = s.clock.now();
    const text = this.redact(s, textValue);
    if (!human) {
      const repeated = this.agentRepeat(s, author, text, now);
      if (repeated) return repeated;
    }
    const client = human && input.client ? this.redact(s, input.client).replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_CLIENT_MAX) : '';
    const clientDiagnostics = human && input.clientDiagnostics?.trim() ? this.redact(s, input.clientDiagnostics.trim()).slice(0, FEEDBACK_CLIENT_DIAGNOSTICS_MAX) : '';
    const company = companySlot(s);
    const report: FeedbackReport = {
      id: newId('fb', now),
      text,
      author,
      context: {
        version: s.host.app.version,
        os: this.deps.os ?? `${process.platform} ${os.release()} ${process.arch}`,
        ...(input.view?.slice(0, 120) ? { view: input.view.slice(0, 120) } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(!human && input.runId ? { runId: input.runId } : {}),
        ...(client ? { client } : {}),
        ...(company ? { company } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientDiagnostics ? { clientDiagnostics } : {}),
      },
      status: 'local',
      createdAt: now,
    };
    if (input.kind) report.kind = input.kind;
    if (imageFileIds.length) report.imageFileIds = [...imageFileIds];
    if (human && input.dictated) report.dictated = true;
    this.repo(s).save(report);
    s.bus.emit('feedback.upserted', report);
    return report;
  }

  list(): FeedbackReport[] {
    return this.repo(this.deps.services()).list(200);
  }

  /** Whether Send can deliver in this build (a receiver is shipped) and whether this PC holds the team's key; never a network call. */
  status(): FeedbackStatus {
    return { sending: Boolean(this.receiver(this.deps.services())), receiving: this.inbox.receiving() };
  }

  /** Owner 24.11.2026: what only this runtime adds to a report the window seals itself; nothing is saved or sent. */
  context(text: string): FeedbackContext {
    const s = this.deps.services();
    const company = companySlot(s);
    const diagnostics = this.diagnostics(s);
    return { text: this.redact(s, text), ...(diagnostics ? { diagnostics } : {}), ...(company ? { company } : {}) };
  }

  /**
   * Seals the report for the team and drops it into the mailbox – a person's Send, an agent's feedback tool, or the
   * resend of a report still to go. Concurrent calls share one request; `visibility` is ignored (nothing is public any more). A send that
   * went through sends what else waits; one that found no connection or server arms the one resend timer.
   */
  async send(id: string, options: SendOptions = {}): Promise<FeedbackReport> {
    const s = this.deps.services();
    const repo = this.repo(s);
    const report = repo.get(id);
    if (!report) throw new WorkforceError('not_found', 'This report no longer exists.');
    if (options.visibility !== undefined && options.visibility !== 'public' && options.visibility !== 'private') throw new WorkforceError('bad_request', 'Unknown feedback audience.');
    if (report.status === 'sent') return report;
    let active = this.sending.get(id);
    if (!active) {
      // B-078 (D17): every report carries the redacted log tail; feedback.includeDiagnostics is no longer read.
      active = deliver(s, report, this.diagnostics(s), this.receiver(s), this.deps.fetch)
        .then((sent) => {
          repo.save(sent);
          s.bus.emit('feedback.upserted', sent);
          s.log.info('feedback sent', { id, receipt: sent.receiptId });
          void this.resendPending(); // the way out works again: what else waits goes too
          return sent;
        }, (error: unknown) => {
          s.log.warn('feedback send failed', sendFailure(id, error));
          if (passing(error)) this.retryLater();
          throw error;
        })
        .finally(() => { this.sending.delete(id); });
      this.sending.set(id, active);
    }
    return active;
  }

  dismiss(id: string): FeedbackReport {
    const s = this.deps.services();
    const repo = this.repo(s);
    const report = repo.get(id);
    if (!report) throw new WorkforceError('not_found', 'This report no longer exists.');
    if (report.status === 'sent') throw new WorkforceError('conflict', 'This report was already sent.');
    if (report.status === 'dismissed') return report;
    const dismissed: FeedbackReport = { ...report, status: 'dismissed' };
    repo.save(dismissed);
    s.bus.emit('feedback.upserted', dismissed);
    return dismissed;
  }

  // ------------------------------------------------------------------ internals

  /** The team's receiver this build sends to (undefined = sending is not set up). */
  private receiver(s: RuntimeServices): ReceiverConfig | undefined {
    return this.deps.receiver === undefined ? readReceiver(s) : this.deps.receiver ?? undefined;
  }

  private repo(s: RuntimeServices): FeedbackRepo {
    this.repoInstance ??= new FeedbackRepo(s.db);
    return this.repoInstance;
  }

  /**
   * Agent reports: the same text from the same agent within 24 h raises the earlier report's
   * `count` (returned); a 6th new report within 24 h is refused with a short text the agent sees.
   */
  private agentRepeat(s: RuntimeServices, author: string, text: string, now: number): FeedbackReport | undefined {
    const repo = this.repo(s);
    const recent = repo.byAuthorSince(author, now - DAY_MS);
    const key = sameTextKey(text);
    const same = recent.find((entry) => sameTextKey(entry.text) === key);
    if (same) {
      const counted: FeedbackReport = { ...same, count: (same.count ?? 1) + 1 };
      repo.save(counted);
      s.bus.emit('feedback.upserted', counted);
      return counted;
    }
    if (recent.length >= AGENT_REPORTS_PER_DAY) {
      throw new WorkforceError('conflict', `You already filed ${AGENT_REPORTS_PER_DAY} feedback reports in the last 24 hours. Do not file more today; mention the problem in your reply instead.`, { details: { limit: AGENT_REPORTS_PER_DAY } });
    }
    return undefined;
  }

  private redact(s: RuntimeServices, value: string): string {
    let out = value;
    try { out = s.secrets.redact(out); } catch { /* pattern redaction still runs */ }
    return redactText(out);
  }

  /** Last warnings/errors of the runtime log (message + error text only), redacted. */
  private diagnostics(s: RuntimeServices): string | undefined {
    const file = path.join(s.paths.logs, 'runtime.log');
    let tail: string;
    try {
      const size = statSync(file).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = openSync(file, 'r');
      try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
      tail = buffer.toString('utf8');
    } catch {
      return undefined;
    }
    const lines: string[] = [];
    for (const line of tail.split('\n')) {
      let entry: { t?: string; level?: string; msg?: string; data?: { error?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.level !== 'warn' && entry.level !== 'error') continue;
      const error = typeof entry.data?.error === 'string' ? `: ${entry.data.error.slice(0, 160)}` : '';
      lines.push(`${entry.t ?? ''} ${entry.level} ${String(entry.msg ?? '').slice(0, 120)}${error}`);
    }
    if (!lines.length) return undefined;
    return this.redact(s, lines.slice(-15).join('\n')).slice(0, 2000);
  }
}
