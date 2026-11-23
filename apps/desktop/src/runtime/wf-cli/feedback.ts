// `wf feedback` (B-055 Q3) on the team's PC:
//   wf feedback setup --project <id> --api-key <key> --service-account <file.json> [--rotate]
//       the team key (made unless the vault has one; --rotate: a new one) and the service account into this PC's
//       vault, resources/feedback/receiver.json, then the Firestore rules to paste and the next steps;
//   wf feedback receive   fetch the mailbox now (opened and stored on this PC; the letters stay for the team's other PCs);
//   wf feedback status    whether this build sends and whether this PC receives.
// 16.11.2026 (the team works through its inbox in the terminal; the report number is the one both sides show):
//   wf feedback list [--open]             one line per report: number, date, mark, where it was written, first line;
//   wf feedback show <no>                 the whole report: text, facts, both diagnostics, its screenshot on this PC;
//   wf feedback mark <no> done|irrelevant|open   marks it (a marked report leaves this PC 7 days later) or opens it again.
// The runtime reads the key file itself (feedback.setup, owner only) – it is passed as an absolute path.
// Owns: what these call and print. Never: prints a private key or the service account (the runtime never returns
// them); report text reaches the terminal only through run.ts's terminalText.

import path from 'node:path';
import {
  FEEDBACK_HANDLED_KEEP_MS, inboxImageFile, INBOX_DIR, reportNumber, type FeedbackHandled, type FeedbackInboxFetch, type FeedbackInboxItem, type FeedbackSetupResult, type FeedbackStatus,
} from '../../shared/model/feedback-delivery.ts';
import { flag, text, type Parsed } from './args.ts';
import type { Command, Ctx } from './commands.ts';
import { CliError } from './errors.ts';
import { clock } from './format.ts';

const SETUP_OPTIONS = ['project', 'api-key', 'service-account'] as const;
const SUBS = ['setup', 'receive', 'status', 'list', 'show', 'mark'];
/** Positional words after the sub-command. */
const WORDS: Record<string, number> = { show: 1, mark: 2 };
const MARKS: Record<string, FeedbackHandled | null> = { done: 'done', irrelevant: 'irrelevant', open: null };
const MARK_TEXT: Record<FeedbackHandled, string> = { done: 'done', irrelevant: 'not relevant' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function check(parsed: Parsed): void {
  const [sub, ...rest] = parsed.args;
  if (!SUBS.includes(sub)) throw new CliError('bad_request', 'Use wf feedback setup, receive, status, list, show <no> or mark <no> done|irrelevant|open.');
  if (sub === 'setup') {
    for (const name of SETUP_OPTIONS) if (!text(parsed, name)?.trim()) throw new CliError('bad_request', `wf feedback setup needs --${name}.`);
    if (parsed.options.has('open')) throw new CliError('bad_request', '--open belongs to wf feedback list.');
    if (rest.length) throw new CliError('bad_request', 'wf feedback setup takes its values as options.');
    return;
  }
  for (const name of [...SETUP_OPTIONS, 'rotate']) if (parsed.options.has(name)) throw new CliError('bad_request', `--${name} belongs to wf feedback setup.`);
  if (sub !== 'list' && parsed.options.has('open')) throw new CliError('bad_request', '--open belongs to wf feedback list.');
  if (rest.length !== (WORDS[sub] ?? 0)) {
    throw new CliError('bad_request', sub === 'show' ? 'Use wf feedback show <no> – wf feedback list shows the numbers.'
      : sub === 'mark' ? 'Use wf feedback mark <no> done, irrelevant or open.' : `wf feedback ${sub} takes no more words.`);
  }
  if (sub === 'mark' && !(rest[1] in MARKS)) throw new CliError('bad_request', 'Use wf feedback mark <no> done, irrelevant or open.');
}

/** The report its number (the first 8 letters and digits of its id, as both sides show; any case) or its whole id names. */
function pick(items: readonly FeedbackInboxItem[], no: string): FeedbackInboxItem {
  const wanted = no.trim();
  const exact = items.find((item) => item.id === wanted);
  if (exact) return exact;
  const number = reportNumber(wanted);
  const found = number.length === 8 ? items.filter((item) => reportNumber(item.id) === number) : [];
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new CliError('bad_request', `${found.length} reports have the number ${number}; use the whole id from wf feedback list --json.`);
  throw new CliError('not_found', `No report ${wanted} in the inbox on this PC (wf feedback list shows them).`);
}

const markOf = (item: FeedbackInboxItem): string => (item.handled ? MARK_TEXT[item.handled.as] : 'open');

/** Where the report was written: the writing device's facts, else the sending PC's version and OS (older senders). */
function origin(item: FeedbackInboxItem): string {
  return item.client || [item.appVersion && `PC ${item.appVersion}`, item.os].filter(Boolean).join(' · ') || 'unknown';
}

function firstLine(value: string, max = 100): string {
  const line = value.trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function listLines(items: readonly FeedbackInboxItem[], open: boolean, now: number): string[] {
  const shown = open ? items.filter((item) => !item.handled) : items;
  if (!shown.length) return [open ? 'No open reports in the inbox on this PC.' : 'No reports in the inbox on this PC.'];
  return shown.map((item) => `${reportNumber(item.id)}  ${clock(item.createdAt, now)}  [${markOf(item)}]  ${origin(item)}${item.fromAgent ? ' · agent' : ''}  –  ${firstLine(item.text)}`);
}

function showLines(item: FeedbackInboxItem, dir: string, now: number): string[] {
  const facts = [
    `Written: ${clock(item.createdAt, now)} · fetched ${clock(item.receivedAt, now)}`,
    `From: ${origin(item)}`,
    ...(item.client ? [`Sending PC: ${[item.appVersion, item.os].filter(Boolean).join(' · ') || 'unknown'}`] : []),
    ...(item.company ? [`Company folder: ${item.company}`] : []),
    ...(item.view ? [`View: ${item.view}`] : []),
    ...(item.kind ? [`Kind: ${item.kind}`] : []),
    ...(item.fromAgent ? ['Filed by one of the sender\'s agents (unverified).'] : []),
    ...(item.dictated ? ['Dictated: the words are a transcript – read them for what was meant.'] : []),
    `Mark: ${markOf(item)}${item.handled ? ` (${clock(item.handled.at, now)})` : ''}`,
  ];
  const files = (item.images ?? []).map((image, index) => `Image ${index + 1}: ${path.join(dir, inboxImageFile(item.id, index, image.mime))}`);
  return [
    `Report ${reportNumber(item.id)} (${item.id})`, ...facts, '', item.text,
    ...(item.diagnostics ? ['', 'Diagnostics (the sending PC\'s log):', item.diagnostics] : []),
    ...(item.clientDiagnostics ? ['', 'Device diagnostics:', item.clientDiagnostics] : []),
    ...(files.length ? ['', ...files] : []),
  ];
}

async function inboxItems(ctx: Ctx): Promise<FeedbackInboxItem[]> {
  return await ctx.rpc.call('feedback.inboxList') as FeedbackInboxItem[];
}

function setupLines(result: FeedbackSetupResult, accountFile: string): string[] {
  const lines = [
    result.createdKey ? `New team key made. Public key: ${result.publicKey}` : `Kept the team key from this PC's vault. Public key: ${result.publicKey}`,
    `The private key and the service account are in this PC's vault ("Feedback team key", "Feedback mailbox service account"); no agent can use them.`,
  ];
  if (result.receiverFile) lines.push(`Wrote ${result.receiverFile}`);
  else lines.push('This app runs from a package, so receiver.json was not written. Save this as resources/feedback/receiver.json in the source tree:', JSON.stringify(result.receiver, null, 2));
  lines.push('', 'Next steps:',
    '1. Firebase console › Firestore Database › Rules: replace the rules with these and press Publish:', '',
    result.rules.trim() || '(resources/feedback/firestore.rules was not found)', '',
    '2. Build the app (npm run build, or npm run package for an installer): receiver.json ships with it, and reports from that build are sealed for this key.',
    `3. You may delete ${accountFile} now – the vault keeps a copy.`,
    '4. wf feedback receive fetches new reports; the feedback menu › Inbox does it when it opens.');
  if (!result.createdKey) lines.push('', 'To make a new key pair, run setup again with --rotate (letters sealed for the old key cannot be opened afterwards).');
  return lines;
}

function receiveLine(result: FeedbackInboxFetch): string {
  let line = `Fetched ${plural(result.added, 'new report')}; ${plural(result.total, 'report')} in the inbox on this PC.`;
  if (result.unreadable) line += ` ${plural(result.unreadable, 'letter')} could not be opened with this PC's key.`;
  if (result.more) line += ' More are waiting – run wf feedback receive again.';
  return line;
}

export const feedbackCommand: Command = {
  usage: 'feedback setup --project <id> --api-key <key> --service-account <file.json> [--rotate] | feedback receive | feedback status | feedback list [--open] | feedback show <no> | feedback mark <no> done|irrelevant|open',
  summary: 'The team\'s feedback mailbox: setup stores the team key and service account on this PC and writes resources/feedback/receiver.json; receive fetches new reports now; status says whether this build sends and this PC receives; list, show and mark work through the inbox on this PC by report number.',
  options: [...SETUP_OPTIONS, 'rotate', 'open'],
  arity: [1, 3],
  check,
  async run(ctx) {
    check(ctx.parsed);
    const [sub, no, word] = ctx.parsed.args;
    if (sub === 'list') {
      const items = await inboxItems(ctx);
      const open = flag(ctx.parsed, 'open');
      if (ctx.json) ctx.out.json(open ? items.filter((item) => !item.handled) : items);
      else ctx.out.lines(listLines(items, open, ctx.now()));
      return;
    }
    if (sub === 'show') {
      const item = pick(await inboxItems(ctx), no);
      if (ctx.json) ctx.out.json(item);
      else ctx.out.lines(showLines(item, path.join(ctx.dataDir, INBOX_DIR), ctx.now()));
      return;
    }
    if (sub === 'mark') {
      const item = pick(await inboxItems(ctx), no);
      const marked = await ctx.rpc.call('feedback.inboxMark', { id: item.id, as: MARKS[word] }) as FeedbackInboxItem;
      if (ctx.json) { ctx.out.json(marked); return; }
      ctx.out.line(marked.handled
        ? `Report ${reportNumber(marked.id)} is marked ${MARK_TEXT[marked.handled.as]}; it leaves the inbox on this PC ${Math.round(FEEDBACK_HANDLED_KEEP_MS / 86_400_000)} days from now.`
        : `Report ${reportNumber(marked.id)} is open again.`);
      return;
    }
    if (sub === 'setup') {
      const accountFile = path.resolve(text(ctx.parsed, 'service-account')!);
      const result = await ctx.rpc.call('feedback.setup', {
        project: text(ctx.parsed, 'project')!.trim(), apiKey: text(ctx.parsed, 'api-key')!.trim(), serviceAccountPath: accountFile,
        ...(flag(ctx.parsed, 'rotate') ? { rotate: true } : {}),
      }) as FeedbackSetupResult;
      if (ctx.json) ctx.out.json(result);
      else ctx.out.lines(setupLines(result, accountFile));
      return;
    }
    if (sub === 'receive') {
      const result = await ctx.rpc.call('feedback.inboxFetch') as FeedbackInboxFetch;
      if (ctx.json) ctx.out.json(result);
      else ctx.out.line(receiveLine(result));
      return;
    }
    const status = await ctx.rpc.call('feedback.status') as FeedbackStatus;
    const inbox = status.receiving ? (await ctx.rpc.call('feedback.inboxList') as FeedbackInboxItem[]).length : undefined;
    if (ctx.json) { ctx.out.json({ ...status, ...(inbox !== undefined ? { inbox } : {}) }); return; }
    ctx.out.lines([
      status.sending ? 'Sending: set up – reports are sealed for the team and dropped into the mailbox.' : 'Sending: not set up in this build – reports stay on the PC (no resources/feedback/receiver.json).',
      inbox !== undefined ? `Receiving: this PC holds the team key – ${plural(inbox, 'report')} in its inbox.` : 'Receiving: no – this PC has no team key (wf feedback setup).',
    ]);
  },
};
