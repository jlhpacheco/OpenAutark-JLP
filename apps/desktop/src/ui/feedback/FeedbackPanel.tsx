// B-055 Q4: the feedback form – since feedback 16.11.2026 (F11, F15) the slim dock at the bottom of the snapshot
// overlay (FeedbackOverlay.tsx), three rows of fixed height: the attachments (the overlay's Screenshot chip, photos and
// Undo, an attached crash report – FeedbackRows.tsx –, the always reserved message slot (role=alert), the team's
// Inbox), then the close arrow (the draft stays), one field with the + (Add photo) and the mic inside it that grows with
// its text (tap to toggle, hold to talk – it keeps adding text) and one action: Send where this build can send, else Save
// (delivery.ts), and the privacy note. No categories. Owner 21.11.2026: the + adds photos (several, beside the window
// shot – never in its place); the report carries every image of the draft, each flattened with its marks into one JPEG
// at Send within its share of the image budget (draft.ts draftImages, paint-image.ts flatten – never a raw painted image). The draft lives in
// draft.ts, so closing keeps it; a sent report clears it. After a Save or an unconfirmed Send the dock says what
// happened in one line; when the send was not confirmed, the action cell of that line reads "Send again" (not Close)
// and sends the same saved report.
// Feedback 16.11.2026: Send first puts the report into this page's outbox (outbox.ts: written before any upload,
// with a clientId, so a lost answer never makes a second report), then delivers it. A confirmed send closes the
// form at once and the status line says "Feedback sent · No. …" for 4 s (F11); a report the PC could not be reached
// for waits in this page and goes on the next connect (the line says so); only a failure keeps the form open with
// "Send again". The report carries no kind (the person's report has no category), the device it was written on
// (client.ts) and an attached Android crash report (FeedbackRows.tsx); a crash report alone is enough to send.
// Owner 20.11.2026: a report is its words – a dictation goes as its transcript (`dictated`), never as a recording. While
// a take records or is transcribed (the field's mic or the cell's talk) the + turns 45° into × in one motion and cancels
// it: its words never reach the field. The mic cell only shows the state.
// Owns: the dock's form and submitting it. Never: starts an app change, requests a login, opens a browser or discards
// a failed submission.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../lib/icons.tsx';
import { errorText } from '../lib/rpc.ts';
import { bridge } from '../lib/platform.ts';
import { isMobile, settings } from '../lib/store.ts';
import { isPhoneApp } from '../pwa/native.ts';
import { pickedImage, useDictation } from './bridge.ts';
import { currentClient } from './client.ts';
import { addPhotos, appendDraftText, canSubmit, clearDraft, draftImages, feedbackDraft, photoRoom, reportText, sentDraft, shownDraft, updateDraft } from './draft.ts';
import type { FeedbackDraft } from './draft.ts';
import { announceSent, canSendAgain, closesAtOnce, doneText, heldText, notSentLine, PHOTO_ADD, PHOTO_HINT, sendAgainLabel, sendLabel, sendReport, useFeedbackSending } from './delivery.ts';
import { cancelTalk, talkError, talkState } from './FeedbackButton.tsx';
import { FeedbackInboxEntry } from './FeedbackInbox.tsx';
import { FeedbackPrivacyNote } from './FeedbackPrivacy.tsx';
import { CrashRow } from './FeedbackRows.tsx';
import { PlusCancel } from '../chat/composer/PlusCancel.tsx';
import { announce, draftOf, feedbackOutbox, newClientId } from './outbox.ts';
import type { OutboxEntry, Outcome, ReportLine } from './outbox.ts';
import { flatten } from './paint-image.ts';
import { here, snapshotSettled } from './popover-state.ts';
import { FEEDBACK_IMAGES_MAX, imageBudget } from '../../shared/model/feedback-delivery.ts';

/** How long the form waits for the PC before it says the report waits in this page (the delivery goes on). */
const FORM_WAIT_MS = 15_000;

/** The report's images as JPEG data URLs, each with its marks flattened in (unpainted: re-encoded) within its budget share. */
async function imagesOf(draft: FeedbackDraft): Promise<string[]> {
  const images = draftImages(draft);
  const budget = imageBudget(images.length);
  return Promise.all(images.map((image) => flatten(image.src, image.marks, budget)));
}

/** The outbox entry of what the draft holds now (only what the checkboxes let go). */
async function entryOf(draft: FeedbackDraft, send: boolean): Promise<OutboxEntry> {
  const images = await imagesOf(draft);
  return {
    clientId: newClientId(), at: Date.now(), send, text: reportText(draft),
    where: draft.where.view ? draft.where : here(),
    client: currentClient(settings.peek()?.profile.language),
    ...(images.length ? { images } : {}),
    ...(draft.dictated && draft.text.trim() ? { dictated: true as const } : {}),
    ...(draft.withDiagnostics && draft.diagnostics ? { clientDiagnostics: draft.diagnostics } : {}),
  };
}

/** Where a held report waits (heldText). */
const waitsIn = (): 'window' | 'phone' | 'browser' => (bridge ? 'window' : isPhoneApp() || isMobile.peek() ? 'phone' : 'browser');

/** Focus back on the feedback button after the form closed by itself (when the closed overlay left it nowhere). */
function focusBack(): void {
  requestAnimationFrame(() => {
    if (document.activeElement === document.body || !document.activeElement?.isConnected) document.querySelector<HTMLElement>('.feedback-toggle')?.focus({ preventScroll: true });
  });
}

/** The field grows with its text (one line to start; feedback.css caps it, then it scrolls). */
function fitField(area: HTMLTextAreaElement | null): void {
  if (!area) return;
  area.style.height = '';
  if (!area.scrollHeight) return; // not laid out yet (the overlay opens after the form): the stylesheet's height holds
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
}

/** The dock. `tools`: the overlay's screenshot box and paint tools (the first cells of the attachments row); `onInbox`: the team's inbox opens (the overlay closes). */
export function FeedbackForm(props: { onClose: () => void; onInbox: () => void; tools?: ComponentChildren }) {
  const draft = shownDraft(); // while a send is on its way: the draft as sent (17.11.2026)
  const sending = useFeedbackSending(); // undefined until known: "Save" (never sends) meanwhile
  const [submittingNow, setBusy] = useState(false);
  const busy = submittingNow || sentDraft.value !== null; // a form opened again during a send shows it, disabled
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReportLine | null>(null);
  const [held, setHeld] = useState(false); // the PC was not reached: the report waits in this page (outbox.ts)
  const [tried, setTried] = useState(false); // a feedback.send went out for the done report (else it was only saved)
  const submitting = useRef(false);
  const mounted = useRef(true);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dictation = useDictation(appendDraftText, settings.value?.profile.language);

  useEffect(() => {
    // The computer types at once; a phone keeps its keyboard down until the field is tapped (the frozen screen stays whole).
    const frame = isMobile.peek() ? 0 : requestAnimationFrame(() => {
      const area = field.current;
      if (!area) return;
      area.focus({ preventScroll: true });
      area.setSelectionRange(area.value.length, area.value.length);
    });
    return () => { cancelAnimationFrame(frame); mounted.current = false; };
  }, []);
  useLayoutEffect(() => fitField(field.current), [draft.text, held, done]);

  /** A delivery's outcome in the form – or, once the form is gone, in the status line. */
  const show = (outcome: Outcome, entry: OutboxEntry) => {
    if (!mounted.current) { announce(outcome, entry); return; }
    if (outcome.kind === 'sent' && closesAtOnce(outcome.report, null)) { // F11: read in a glance, the form goes at once
      props.onClose();
      announceSent(outcome.report);
      focusBack();
      return;
    }
    if (outcome.kind === 'held') { setHeld(true); return; }
    if (outcome.kind === 'refused') { feedbackDraft.value = draftOf(entry); setError(errorText(outcome.error)); return; }
    setDone(outcome.report); // saved on the PC; the line says so, the error says why it did not go
    if (outcome.error !== undefined) setError(notSentLine(outcome.error));
  };

  const submit = async () => {
    if (submitting.current || !canSubmit(feedbackDraft.peek())) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const send = sending === true; // what the button said: "Save" (unknown or not set up) never sends
      await snapshotSettled(); // a new snapshot on its way: the report carries it (bounded)
      const entry = await entryOf(feedbackDraft.peek(), send);
      await feedbackOutbox.put(entry); // kept before anything goes out
      sentDraft.value = feedbackDraft.peek(); // shown, disabled, until the outcome: what the person sent
      clearDraft(); // the outbox holds it now; the next press takes a fresh screenshot
      setTried(send);
      const delivery = feedbackOutbox.deliver(entry);
      const outcome = await Promise.race([delivery, new Promise<null>((resolve) => setTimeout(() => resolve(null), FORM_WAIT_MS))]);
      if (outcome) show(outcome, entry);
      else { void delivery.then((late) => announce(late, entry)); show({ kind: 'held' }, entry); }
    } catch (err) {
      setError(errorText(err)); // nothing left the page (the image could not be prepared): the draft is still here
    } finally {
      sentDraft.value = null;
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  // Not confirmed (only saved on the PC) where sending works: the same saved report goes out again, in the Close cell.
  const again = async (id: string) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setTried(true);
    try {
      const report = await sendReport(id);
      if (closesAtOnce(report, null)) { props.onClose(); announceSent(report); focusBack(); return; }
      setDone(report);
    } catch (err) {
      setError(notSentLine(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // After Send: one line of what happened and one action, in the dock's place (the report left the draft).
  if (held || done) {
    const report = done;
    return (
      <div class="feedback-dock done" role="group" aria-label="Feedback">
        <div class="feedback-dock-main">
          <p class="feedback-done">{report ? doneText(report, tried || (sending === false ? false : undefined)) : heldText(waitsIn())}</p>
          <p class="feedback-message" role="alert" title={error ?? undefined}>{error}</p>
          {report && canSendAgain(report.status, sending)
            ? <button type="button" class="button primary feedback-send feedback-again" disabled={busy} onClick={() => void again(report.id)}>{sendAgainLabel(busy)}</button>
            : <button type="button" class="button primary feedback-send" onClick={props.onClose}>Close</button>}
        </div>
      </div>
    );
  }

  const listening = dictation.state === 'listening';
  const transcribing = dictation.state === 'transcribing' || talkState.value === 'transcribing';
  const taking = listening || transcribing || talkState.value === 'listening'; // a take runs: the + is its ×
  const message = error ?? dictation.error ?? talkError.value ?? null;
  const picked = async (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];
    input.value = ''; // the same file again is a new choice
    if (!files.length) return;
    try {
      const room = photoRoom(feedbackDraft.peek());
      addPhotos(await Promise.all(files.slice(0, room).map(pickedImage)));
      setError(files.length > room ? `A report carries at most ${FEEDBACK_IMAGES_MAX} images.` : null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const phone = isMobile.value;
  return (
    <div class="feedback-dock" role="group" aria-label="Feedback">
      <div class="feedback-dock-row">
        {props.tools}
        <CrashRow draft={draft} disabled={busy} />
        {!phone && <p class="feedback-message" role="alert" title={message ?? undefined}>{message}</p>}
        <FeedbackInboxEntry shown onOpen={props.onInbox} />
      </div>
      <div class="feedback-dock-main">
        <button type="button" class="icon-button feedback-close" aria-label="Close – your draft stays" title="Close (Esc) – your draft stays" onClick={props.onClose}>
          <Icon name="arrow-down" size={18} />
        </button>
        <div class="feedback-input">
          <PlusCancel class="feedback-plus" iconSize={18} disabled={(busy || !photoRoom(draft)) && !taking}
            cancel={taking ? { label: 'Cancel dictation – its words are not kept', run: () => { dictation.cancel(); cancelTalk(); } } : undefined}
            label={`${PHOTO_ADD} – ${PHOTO_HINT.toLowerCase()}`} onClick={() => picker.current?.click()} />
          <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(event) => void picked(event.currentTarget)} />
          <textarea
            ref={field}
            class="set-textarea"
            rows={1}
            aria-label="Your feedback"
            placeholder="What happened, or what would you like?"
            value={draft.text} disabled={busy}
            onInput={(event) => updateDraft({ text: (event.currentTarget as HTMLTextAreaElement).value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void submit(); }}
          />
          {dictation.available && (
            <button type="button" class={`icon-button mic${listening ? ' active' : ''}`}
              aria-label={listening ? 'Stop dictation' : 'Dictate'} aria-pressed={listening}
              title={listening ? 'Stop dictation' : 'Dictate – tap, or hold to talk'}
              disabled={transcribing || busy} {...dictation.handlers}>
              <Icon name={transcribing ? 'circle-notch' : listening ? 'stop' : 'microphone'} size={18} />
            </button>
          )}
        </div>
        <button type="button" class="button primary feedback-send" disabled={busy || !canSubmit(draft)} onClick={() => void submit()}>
          {sendLabel(sending, busy)}
        </button>
      </div>
      {phone && message // the phone's narrow row has no room for it: a message takes the note's line while it stands
        ? <p class="feedback-message feedback-message-foot" role="alert" title={message}>{message}</p>
        : <FeedbackPrivacyNote sending={sending === true} />}
    </div>
  );
}
