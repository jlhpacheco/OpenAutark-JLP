// What Send does and says (feedback panel): one button – "Send" where this build can send (feedback.status: the
// release's receiver), else "Save" (also while that is still unknown: a click never sends more than its label said)
// – and one result line. A report is always saved on the PC first; sending is one feedback.send on top. A confirmed
// send names its short report number; when it was not confirmed (the report is only saved), the line says "Not
// sent" and the result's one action cell says "Send again" instead of Close and sends the same saved report.
// Feedback 16.11.2026 (F11): a confirmed send closes the form at once and says so in one status-line toast,
// "Feedback sent · No. ABCD1234", for SENT_TOAST_MS. A report the PC could not be reached for waits in this page
// (outbox.ts) and the line says where it is (heldText). The last answer of feedback.status is remembered in this
// page (localStorage), so the "only My day" screen without the PC still says Send where this build sends.
// Owns: the can-we-send answer, the button's label, the result line and the sent toast. Never: publishes without a
// click or opens a browser.

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { FeedbackReport } from '../../shared/model/system.ts';
import { FEEDBACK_IMAGES_MAX, reportNumber } from '../../shared/model/feedback-delivery.ts';
import { bridge } from '../lib/platform.ts';
import { errorText, RpcError, rpc } from '../lib/rpc.ts';
import { session } from '../lib/session.ts';
import { builtInReceiver } from './direct.ts';
import { pushToast } from '../lib/toasts.ts';

const SENDING_KEY = 'wf.feedbackSending';

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The last answer this page had (undefined when it never had one). */
function remembered(): boolean | undefined {
  try {
    const value = storage()?.getItem(SENDING_KEY);
    return value === '1' ? true : value === '0' ? false : undefined;
  } catch { return undefined; }
}

/** Can this build send feedback? The last known answer until the runtime answers; a failed read shows false (Save). */
/** 18.11.2026: a phone or browser with the team's receiver built in sends itself (direct.ts) – no question to the PC. */
const sendsItself = !bridge && builtInReceiver() !== null;
export const feedbackSending = signal<boolean | undefined>(sendsItself ? true : remembered());
let asking: Promise<void> | undefined;

/** The current answer (undefined while unknown); asked each time a panel opens and when the session changes – a
 *  receiver set up while the app runs (`wf feedback setup`) says Send at the next open. */
export function useFeedbackSending(): boolean | undefined {
  const info = session.value;
  useEffect(() => {
    if (sendsItself) return;
    asking ??= rpc.call('feedback.status')
      .then((status) => {
        feedbackSending.value = status.sending === true;
        try { storage()?.setItem(SENDING_KEY, status.sending === true ? '1' : '0'); } catch { /* storage blocked */ }
      })
      .catch(() => { if (feedbackSending.peek() === undefined) feedbackSending.value = false; })
      .finally(() => { asking = undefined; });
  }, [info]);
  return feedbackSending.value;
}

/** Sends the saved report; the report as the runtime now holds it. */
export function sendReport(id: string): Promise<FeedbackReport> {
  return rpc.call('feedback.send', { id });
}

/** The button: Send where this build can send, else Save – also while that is unknown. */
export function sendLabel(sending: boolean | undefined, busy: boolean): string {
  if (sending === true) return busy ? 'Sending…' : 'Send';
  return busy ? 'Saving…' : 'Save';
}

/** After an unconfirmed send (only saved on the PC) where this build can send: the result's action is "Send again". */
export function canSendAgain(status: FeedbackReport['status'], sending: boolean | undefined): boolean {
  return sending === true && (status === 'local' || status === 'draft' || status === 'queued');
}

/** Feedback 16.11.2026 (F11): how long the status line says "Feedback sent · No. …". */
export const SENT_TOAST_MS = 4000;

/** A confirmed send closes the form at once (the toast says it); a saved, held or failed one keeps the result line. */
export function closesAtOnce(report: Pick<FeedbackReport, 'status'> | null, error: string | null): boolean {
  return report?.status === 'sent' && !error;
}

/** The sent toast's words: the short number both sides show. */
export function sentText(report: Pick<FeedbackReport, 'receiptId'>): string {
  const number = reportNumber(report.receiptId);
  return number ? `Feedback sent · No. ${number}` : 'Feedback sent';
}

/** The one short line in the status line after a confirmed send. */
export function announceSent(report: Pick<FeedbackReport, 'receiptId'>): void {
  pushToast({ title: sentText(report) }, SENT_TOAST_MS);
}

/** Why a send left the report saved on the PC: no connection there goes again by itself (the PC resends), else the reason. */
export function notSentLine(error: unknown): string {
  const reason = error instanceof RpcError ? error.data.details?.reason : undefined;
  if (reason === 'offline' || reason === 'timeout' || reason === 'server') return 'Not sent yet – it goes by itself when the connection is back.';
  return errorText(error);
}

/** Where a report waits that could not go yet: this page (outbox.ts) sends it once there is a connection again. */
export function heldText(where: 'window' | 'phone' | 'browser'): string {
  if (where === 'window') return 'Saved in this window – it goes out as soon as the app is back.';
  return `Saved ${where === 'phone' ? 'on this phone' : 'in this browser'} – it goes by itself as soon as there is a connection.`;
}

export function sendAgainLabel(busy: boolean): string {
  return busy ? 'Sending…' : 'Send again';
}

/** The screenshot row: the checkbox and the one line under it. */
export const SHOT_LABEL = 'Screenshot';
export const SHOT_HINT = 'Paint over anything private.';
export const SHOT_MISSING = 'The window could not be captured.';
export const SHOT_NO_ROOM = `A report carries at most ${FEEDBACK_IMAGES_MAX} images – remove a photo to send the screenshot.`;
/** The form's + (everywhere): the person adds a screenshot or photo instead of the window's. */
export const PHOTO_ADD = 'Add photo';
export const PHOTO_HINT = 'A screenshot or a photo.';
/** The crash row (an Android crash report the app handed over). */
export const CRASH_LABEL = 'Crash report attached';

/**
 * The result line after Send/Save: a confirmed send with its short report number (the team inbox shows the same),
 * else what happened to the saved report – `tried`: true = a send was tried and not confirmed ("Not sent"), false =
 * this build cannot send, undefined = only saved while that was not known yet. `here`: the desktop window (else a
 * phone: "your PC").
 */
export function doneText(report: Pick<FeedbackReport, 'status' | 'receiptId'>, tried: boolean | undefined, here = Boolean(bridge)): string {
  if (report.status === 'sent') {
    const number = reportNumber(report.receiptId);
    return number ? `Sent. Report no. ${number}` : 'Sent.';
  }
  if (report.status === 'received') return 'Received.';
  const pc = here ? 'this PC' : 'your PC';
  if (tried === undefined) return `Saved on ${pc}.`;
  return tried ? `Not sent. Your report is saved on ${pc}.` : `Saved on ${pc} – sending is not set up.`;
}
