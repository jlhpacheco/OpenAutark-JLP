// Voice conversation and dictation – one path on the desktop window and the phone.
//   voice:     the page conversation (pwa-conversation.ts, shared/voice/conversation.ts VoiceSessions): up to three
//              chats talk over one microphone, the chat started or focused last listens; opening a talking chat
//              makes it the listening one, End ends that chat's conversation. The status line lists them
//              (shell/StatusLine.tsx); the chat header's call cell starts and ends it (call/CallHeader.tsx).
//   dictation: lib/dictation.ts (recorded, uploaded, voice.transcribe – the runtime picks who hears it), editable
//              text into the draft (the profile language as the hint; a chat's next take waits for its text).
//              Where nothing can hear right now (dictationNote) the take is attached as audio with the note as
//              the hint. B-082: the pieces' text goes in once with its marks hidden beside it (draft-marks.ts); a piece
//              whose hearing failed becomes an audio chip (play, "Transcribe again" = retryTake, delete), one held
//              while the link is down too (take-store.ts; uploaded when it is back); a take without words adds
//              nothing. A field that cannot take an attachment (the Tasks page: stopDictation({ attach: false })) gets a
//              lasting toast with "Transcribe again" instead (offerRetry). Send while recording or transcribing (feedback
//              FCMWNZ0H, 20.11.2026, an empty field too) stops the take, waits for its text and sends it (settleTake); it does
//              not send a take that came back as a recording, failed or was cancelled (the composer's + turned × cancels). D13: the text goes where the caret or
//              selection was when the mic was pressed (startDictation's target; a field that was not focused
//              appends), edits while recording move that place along (dictation-insert.ts) and the composer gets the
//              caret after the words (dictationCaret). A dictated draft is sent marked as spoken (draft-speech.ts).
//              Dictation and conversation share the one microphone: a dictation ends every conversation first.
// Owns: which conversation and take run and their state signals. Never: audio processing (lib/dictation.ts,
// conversation-audio.ts) or the conversation loop (shared/voice/conversation.ts).

import { effect, signal } from '@preact/signals';
import type { Attachment } from '../../../shared/model/chat.ts';
import type { VoiceSessionEntry, VoiceSessionView } from '../../../shared/voice/conversation.ts';
import { voiceChats, voiceSession, voiceSessions, type VoiceChat } from '../../lib/shell-state.ts';
import { activeConversationId, conversationMap, loaded, settings } from '../../lib/store.ts';
import { chatTitle } from '../../lib/chat-naming.ts';
import { can } from '../../lib/session.ts';
import { pushToast, toastError } from '../../lib/toasts.ts';
import { toAttachment, uploadRef } from '../../lib/files.ts';
import { rpc } from '../../lib/rpc.ts';
import { DictationCancelled, TakeNotTranscribed, dictation, dictationNote, recordingProblem, type KeptPiece } from '../../lib/dictation.ts';
import { heldAttachment, heldKey, HELD_PREFIX, takeStore, type HeldTake } from '../../lib/take-store.ts';
import type { MarkedText, TextMarks } from '../../../shared/voice/marks.ts';
import { draftFor, updateDraft } from './draft.ts';
import { markDictated } from './draft-speech.ts';
import { insertMarked } from './draft-marks.ts';
import { shiftTarget, type DictationTarget } from './dictation-insert.ts';
import { primeSpeech } from './conversation-audio.ts';
import { fieldTake } from './field-words.ts';
import { setCallMuted } from '../call/mute.ts';
import { ConversationCancelled, createBrowserConversation } from './pwa-conversation.ts';
import type { PageConversation } from './pwa-conversation.ts';

export { clearDraftSpeech } from './draft-speech.ts';

/** "Start conversation" is offered: this connection may transcribe and send, and this page can record (reactive). */
export function conversationAvailable(): boolean {
  return can('voice.transcribe') && can('messages.send') && can('files.upload') && can('chats.get') && !recordingProblem();
}

/** The loop's state (the microphone and every chat; error: why one ended) as the shell shows it. */
function showVoiceState(mic: VoiceSessionView | null, error: string | undefined, sessions: readonly VoiceSessionEntry[]): void {
  const before = voiceSessions.peek();
  voiceSessions.value = voiceChats(mic, sessions);
  if (error) toastError(new Error(error), endedTitle(before, voiceSessions.peek()));
}

/** "Conversation in Research ended" when one of several ended, else "Conversation ended". */
function endedTitle(before: readonly VoiceChat[], after: readonly VoiceChat[]): string {
  const gone = before.filter((chat) => !after.some((left) => left.conversationId === chat.conversationId));
  const chat = gone.length === 1 && after.length ? conversationMap.peek().get(gone[0].conversationId) : undefined;
  return chat ? `Conversation in ${chatTitle(chat)} ended` : 'Conversation ended'; // B-050 K2: a default 1:1 by its partner
}

let page: PageConversation | null = null;

/** The page conversation, made on first use; from then on opening a talking chat makes it the listening one. */
function conversation(): PageConversation {
  if (page) return page;
  const made = createBrowserConversation(showVoiceState);
  page = made;
  effect(() => {
    const open = activeConversationId.value;
    if (open) focusVoice(open);
  });
  return made;
}

/**
 * Starts (or focuses) the conversation in `conversationId`; false when it could not start (shown as a toast). Call from
 * the tap. B-081: `callId` takes that call (an agent's ring, or a call on another device).
 */
export async function startVoice(conversationId: string, callId?: string): Promise<boolean> {
  primeSpeech();
  if (dictating.peek() || dictationStarting.peek()) await cancelDictation(); // one microphone at a time
  if (!voiceSessions.peek().length) setCallMuted(false); // B-085: a new call starts unmuted, however the last one ended
  try {
    await conversation().start(conversationId, callId);
    return true;
  } catch (error) {
    if (!(error instanceof ConversationCancelled)) toastError(error, 'Conversation could not start');
    return false;
  }
}

/** Makes the conversation running in `conversationId` the listening one (the status line's Talk; opening the chat does it too). */
export function focusVoice(conversationId: string): void {
  const chat = voiceSessions.peek().find((entry) => entry.conversationId === conversationId);
  if (page && chat && !chat.listening) void page.start(conversationId).catch((error: unknown) => toastError(error));
}

/** B-081: a pin from the browser as a line of the voice conversation in `conversationId`; false when that chat does not talk here. */
export function addToCall(conversationId: string, text: string): boolean {
  return page?.add(conversationId, text) ?? false;
}

/** Ends the conversation in `conversationId` – by default the open chat's, else the listening one. */
export async function stopVoice(conversationId = voiceSession.peek()?.conversationId): Promise<void> {
  page?.stop(conversationId);
}

// ------------------------------------------------------------------ dictation

/** Conversation id whose composer is currently dictating (one microphone at a time). */
export const dictating = signal<string | null>(null);
/** D13: the chat whose dictation is starting (tap → microphone open): its mic button shows it at once; a second tap starts nothing. */
export const dictationStarting = signal<string | null>(null);
/** D13: where the caret goes after a take was inserted (the composer applies it, `seq` makes each one new). */
export const dictationCaret = signal<{ conversationId: string; caret: number; seq: number } | null>(null);
/** How the running take ends: transcribed, or kept as a recording (nothing can hear it right now). */
let take: 'take' | 'recording' | null = null;
/**
 * D13: per chat, the draft and the field's caret/selection when its take started (no target:
 * append) – per chat, so a take started elsewhere while one is still transcribing never takes its place.
 */
const targets = new Map<string, { before: string; at: DictationTarget | null }>();
let carets = 0;

/**
 * Starts dictation into `conversationId`'s draft. `at`: the field's caret/selection now (read in
 * the mic's pointer-down, before focus could move); without it the text is appended at Stop. B-082: `attach: false`
 * (a field without chips): a piece held while the link is down is offered as a toast once uploaded, not as a chip.
 */
export async function startDictation(conversationId: string, at?: DictationTarget, options: StopDictationOptions = {}): Promise<void> {
  // A take of this chat still being transcribed comes first: its text lands in the draft before a new one.
  if (dictating.value || dictationStarting.value || transcribing.value.has(conversationId)) return;
  dictationStarting.value = conversationId;
  try {
    page?.stopAll(); // one microphone at a time
    // Ended by another dictation (the feedback panel's hold-to-talk) – also one that ends while it still starts.
    let started = false;
    let endedEarly = false;
    const ended = () => {
      if (!started) { endedEarly = true; return; }
      if (dictating.peek() !== conversationId) return;
      dictating.value = null;
      take = null;
      targets.delete(conversationId);
    };
    const kind = dictationNote() ? 'recording' : 'take';
    targets.set(conversationId, { before: draftFor(conversationId).peek().text, at: at ?? null });
    // B-082: pieces are heard while recording (the language and chat as hints), held ones belong to this draft.
    await dictation.start(ended, { language: settings.peek()?.profile.language, chatId: conversationId, hear: kind === 'take', ...(options.attach === false ? {} : { owner: conversationId }) });
    started = true;
    if (endedEarly) { targets.delete(conversationId); return; }
    take = kind;
    dictating.value = conversationId;
  } catch (error) {
    if (dictating.peek() !== conversationId) targets.delete(conversationId);
    if (!(error instanceof DictationCancelled)) toastError(error, 'Microphone unavailable');
  } finally {
    if (dictationStarting.peek() === conversationId) dictationStarting.value = null;
  }
}

/** Puts a take's text (its marks beside it, hidden) into the draft at the take's target. */
function insertTake(conversationId: string, piece: MarkedText): void {
  const draft = draftFor(conversationId).peek();
  const taken = targets.get(conversationId) ?? null;
  targets.delete(conversationId);
  const at = taken?.at ? shiftTarget(taken.before, draft.text, taken.at) : null;
  // A part spoken into a draft that already holds text gets a dictated span, so the agent knows what was said and what typed.
  const inserted = insertMarked(draft.text, draft.marks, at, piece, draft.text.trim() !== '');
  updateDraft(conversationId, { text: inserted.text, marks: inserted.marks });
  markDictated(conversationId);
  if (taken?.at?.focused) dictationCaret.value = { conversationId, caret: inserted.caret, seq: ++carets };
}

/** Chats whose stopped dictation is still being uploaded or transcribed (seconds on a phone). */
export const transcribing = signal<ReadonlySet<string>>(new Set());

/** Feedback 08604667 (18.11.2026, "kein abbrechen button beim transkribiren"): the stopped take each chat waits for. */
const awaited = new Map<string, symbol>();

/**
 * Stops waiting for a chat's take that is still being transcribed: the spinner goes at once, the draft stays as it is,
 * and the text that comes later is dropped (the next take of the chat may start right away).
 */
export function cancelTranscribing(conversationId: string): void {
  if (!awaited.delete(conversationId)) return;
  targets.delete(conversationId);
  setTranscribing(conversationId, false);
}

function setTranscribing(conversationId: string, on: boolean): void {
  const next = new Set(transcribing.value);
  if (on) next.add(conversationId); else next.delete(conversationId);
  transcribing.value = next;
}

/**
 * What a stopped take gave: its text (marks beside it), its unheard pieces as audio chips (`kept`, `error`: why), or
 * `failed` (a toast said why).
 */
export interface DictationOutcome { text?: string; marks?: TextMarks; kept?: Attachment[]; error?: string; failed?: boolean }

export interface StopDictationOptions {
  /** false: the field cannot take an attachment – unheard pieces come back in `kept` for a toast, not as chips. */
  attach?: boolean;
}

/** Stops dictation: the transcript text, unheard pieces as audio chips, or a failure; {} when nothing was heard. */
export async function stopDictation(options: StopDictationOptions = {}): Promise<DictationOutcome> {
  const attach = options.attach !== false;
  const conversationId = dictating.value;
  if (!conversationId) return {};
  // Something that can hear now (a model download finished meanwhile) still turns this take into text.
  const kind = take === 'recording' && !dictationNote() ? 'take' : take;
  dictating.value = null;
  take = null;
  const ticket = Symbol(conversationId);
  awaited.set(conversationId, ticket);
  setTranscribing(conversationId, true);
  const cancelled = () => awaited.get(conversationId) !== ticket; // cancelTranscribing: failed, so Send leaves the draft alone
  try {
    if (kind === 'recording') return attach ? await recordingOnly() : dropRecording();
    const heard = await dictation.finish(settings.value?.profile.language, { chatId: conversationId }); // the language: a hint
    if (cancelled()) return { failed: true };
    return keptOutcome(heard.text ? { text: heard.text, ...(heard.marks ? { marks: heard.marks } : {}) } : {}, heard.kept ?? [], attach);
  } catch (error) {
    if (cancelled()) return { failed: true };
    // Pieces worth keeping come back as recordings when their transcription failed.
    if (error instanceof TakeNotTranscribed && error.kept.length) return keptOutcome({}, error.kept, attach);
    toastError(error, 'Dictation failed');
    return { failed: true };
  } finally {
    if (!cancelled()) { awaited.delete(conversationId); setTranscribing(conversationId, false); }
  }
}

const keptAttachment = (piece: KeptPiece): Attachment => (piece.ref ? toAttachment(piece.ref) : heldAttachment(piece.held as HeldTake));

/** The unheard pieces as chips (a toast says why); a field without chips gets them back to offer "Transcribe again". */
function keptOutcome(outcome: DictationOutcome, pieces: KeptPiece[], attach: boolean): DictationOutcome {
  if (!pieces.length) return outcome;
  const error = pieces.find((piece) => piece.error)?.error;
  const title = outcome.text ? 'Part of the dictation was not transcribed' : 'Dictation not transcribed';
  if (attach) pushToast({ title, body: `${error ? `${error} ` : ''}The recording was attached instead.`, tone: 'error' }, 10_000);
  return { ...outcome, kept: pieces.map(keptAttachment), ...(error ? { error } : {}) };
}

/** Nothing can transcribe here: the take becomes audio attachments, with the reason as a hint. */
async function recordingOnly(): Promise<DictationOutcome> {
  const hint = dictationNote();
  const kept = (await dictation.keep()).map(keptAttachment);
  if (!kept.length) return {};
  pushToast({ title: 'Dictation attached as a recording', ...(hint ? { body: hint } : {}) }, 10_000);
  return { kept };
}

/** Nothing can transcribe here and the field cannot attach: the take is dropped, with the reason as a hint. */
function dropRecording(): DictationOutcome {
  const hint = dictationNote();
  dictation.cancel();
  pushToast({ title: 'Dictation not transcribed', ...(hint ? { body: hint } : {}), tone: 'error' }, 10_000);
  return { failed: true };
}

/**
 * Stops the composer's dictation into its chat's draft: the text at the take's target (D13: the
 * caret or selection when the mic was pressed, moved along edits; appended without one), a
 * recording attached. True when the draft now holds what was said (its text, or nothing was
 * heard); false when the take came back as a recording or failed – Send then leaves the draft for
 * the person to check.
 */
export function dictateIntoDraft(): Promise<boolean> {
  const conversationId = dictating.value;
  if (!conversationId) return Promise.resolve(true);
  return track(conversationId, takeIntoDraft(conversationId));
}

async function takeIntoDraft(conversationId: string): Promise<boolean> {
  const result = await stopDictation();
  if (result.text) insertTake(conversationId, { text: result.text, ...(result.marks ? { marks: result.marks } : {}) });
  else targets.delete(conversationId);
  const list = draftFor(conversationId).peek().attachments;
  const chips = (result.kept ?? []).map(uploadedChip).filter((chip) => !list.some((entry) => entry.fileId === chip.fileId));
  if (chips.length) updateDraft(conversationId, { attachments: [...list, ...chips] });
  return !result.kept?.length && !result.failed;
}

/** Feedback FCMWNZ0H/FCMWNSOZ (20.11.2026): per chat, the take on its way into the draft (true: its words are in). */
const takes = new Map<string, Promise<boolean>>();

function track(conversationId: string, take: Promise<boolean>): Promise<boolean> {
  takes.set(conversationId, take);
  const forget = () => { if (takes.get(conversationId) === take) takes.delete(conversationId); };
  take.then(forget, forget);
  return take;
}

/**
 * Before a send (feedback FCMWNZ0H, 20.11.2026: "direkt aus der Aufnahme abschicken"): the chat's running take stops
 * and its words go into the draft; a stopped one still being heard is waited for. True when the draft now holds what
 * was said (or nothing was being said); false when the take came back as a recording, failed or was cancelled – the
 * draft then stays for the person to see.
 */
export function settleTake(conversationId: string): Promise<boolean> {
  if (dictating.peek() === conversationId) return dictateIntoDraft();
  return takes.get(conversationId) ?? Promise.resolve(!transcribing.peek().has(conversationId));
}

/** What the + turned × does now (composer/PlusCancel.tsx): its label and the cancel. */
export interface TakeCancel { label: string; run: () => void }

/** The × of `key`'s take (a chat, a draft key, a Tasks page field) while it starts, records or is transcribed (reactive). */
export function takeCancel(key: string): TakeCancel | undefined {
  if (transcribing.value.has(key)) return { label: 'Cancel transcription', run: () => cancelTranscribing(key) };
  if (dictating.value === key || dictationStarting.value === key) return { label: 'Cancel dictation', run: () => void cancelDictation() };
  return undefined;
}

/** Discards the running (or starting) take. */
export async function cancelDictation(): Promise<void> {
  const conversationId = dictating.value;
  if (!conversationId && !dictationStarting.value) return;
  if (conversationId) targets.delete(conversationId);
  dictating.value = null;
  take = null;
  dictation.cancel(); // a start still opening the microphone gives up, too
}

// ------------------------------------------------------------------ kept takes (B-082: nothing is lost)

/**
 * "Transcribe again" on a draft's audio chip: hears the file again, puts its text at `at` (the field's caret when the
 * chip was clicked; appended without it) and the chip goes. A held chip (not uploaded yet) tries its upload first.
 */
export async function retryTake(conversationId: string, attachment: Attachment, at?: DictationTarget): Promise<void> {
  if (heldKey(attachment.fileId)) { flushHeld(); pushToast({ title: 'Not uploaded yet', body: 'The recording uploads once the connection is back.' }); return; }
  if (dictating.peek() === conversationId || transcribing.peek().has(conversationId)) return;
  await track(conversationId, hearAgain(conversationId, attachment, at));
}

/** retryTake's hearing; true when the words replaced the chip (a Send waiting for it sends them). */
async function hearAgain(conversationId: string, attachment: Attachment, at?: DictationTarget): Promise<boolean> {
  const ticket = Symbol(conversationId);
  awaited.set(conversationId, ticket);
  setTranscribing(conversationId, true);
  targets.set(conversationId, { before: draftFor(conversationId).peek().text, at: at ?? null });
  const cancelled = () => awaited.get(conversationId) !== ticket; // the × (cancelTranscribing): the late words go nowhere
  try {
    const heard = await dictation.hear(attachment.fileId, { language: settings.peek()?.profile.language, chatId: conversationId });
    if (cancelled()) return false;
    if (!heard.text.trim()) { targets.delete(conversationId); pushToast({ title: 'Nothing heard in the recording' }); return false; }
    insertTake(conversationId, heard);
    updateDraft(conversationId, { attachments: draftFor(conversationId).peek().attachments.filter((entry) => entry.fileId !== attachment.fileId) });
    return true;
  } catch (error) {
    if (cancelled()) return false;
    targets.delete(conversationId);
    toastError(error, 'Dictation not transcribed');
    return false;
  } finally {
    if (!cancelled()) { awaited.delete(conversationId); setTranscribing(conversationId, false); }
  }
}

/** A field without chips (the Tasks page): a kept recording as a lasting toast whose "Transcribe again" gives `onText` its words;
 *  `key`: the field's – while they are heard it shows so (its + an ×) and an Add waits for them (field-words.ts). */
export function offerRetry(attachment: Attachment, onText: (text: string) => void, error?: string, key?: string): void {
  const held = heldKey(attachment.fileId) !== undefined;
  if (held) heldFields.set(heldKey(attachment.fileId) as string, { onText, ...(key ? { key } : {}) }); // its words still go to this field once uploaded
  const run = () => {
    const free = key !== undefined && dictating.peek() !== key && !transcribing.peek().has(key); // a take of its own runs: the retry stays apart
    const words = hearKept(attachment, onText, free ? key : undefined);
    if (free) void fieldTake(key, words, onText); else void words.then((said) => { if (said) onText(said); });
  };
  // `action`: the toast's button (lib/toasts.ts) – a held recording has none until it is uploaded.
  const toast = { title: 'Dictation not transcribed', tone: 'error' as const, body: `${error ? `${error} ` : ''}${held ? 'The recording waits in this page.' : 'The recording is kept.'}`, ...(held ? {} : { action: { label: 'Transcribe again', run } }) };
  pushToast(toast, 0);
}

/** Held pieces uploaded before their chip reached the draft (the take was still running or finishing): their uploads. */
const uploadedHeld = new Map<string, Attachment>();
/** A held piece of a field without chips (offerRetry): where its words go (and that field's key). */
const heldFields = new Map<string, { onText: (text: string) => void; key?: string }>();

/** The toast's "Transcribe again": the words ('' when none); `key` marks the field as transcribing, so its × can drop them. */
async function hearKept(attachment: Attachment, onText: (text: string) => void, key?: string): Promise<string> {
  const ticket = Symbol(key);
  if (key) { awaited.set(key, ticket); setTranscribing(key, true); }
  const cancelled = () => key !== undefined && awaited.get(key) !== ticket;
  try {
    const heard = await dictation.hear(attachment.fileId, { language: settings.peek()?.profile.language });
    if (cancelled()) return '';
    if (!heard.text.trim()) pushToast({ title: 'Nothing heard in the recording' }); return heard.text.trim();
  } catch (failed) {
    if (!cancelled()) offerRetry(attachment, onText, failed instanceof Error ? failed.message : undefined, key);
    return '';
  } finally {
    if (key && !cancelled()) { awaited.delete(key); setTranscribing(key, false); }
  }
}

/** A kept piece's chip as it goes into the draft: the uploaded file when its held piece was uploaded meanwhile. */
function uploadedChip(attachment: Attachment): Attachment {
  const key = heldKey(attachment.fileId);
  const uploaded = key ? uploadedHeld.get(key) : undefined;
  if (key && uploaded) uploadedHeld.delete(key);
  return uploaded ?? attachment;
}

/** Uploads the pieces held while the link was down; each one's chip becomes the uploaded file (a field's: a toast). */
function flushHeld(): void {
  void takeStore.flush((blob, name) => uploadRef(blob, name), (held, ref) => {
    const attachment = toAttachment(ref);
    if (!held.owner) {
      const field = heldFields.get(held.key);
      heldFields.delete(held.key);
      offerRetry(attachment, field?.onText ?? ((text) => pushToast({ title: 'Dictation', body: text }, 0)), undefined, field?.key);
      return;
    }
    const id = HELD_PREFIX + held.key;
    const list = draftFor(held.owner).peek().attachments;
    const chip = list.some((entry) => entry.fileId === id);
    // No chip yet: its take may still be finishing – dictateIntoDraft then puts the uploaded file in (uploadedChip, once).
    if (!chip) uploadedHeld.set(held.key, attachment);
    if (!chip && (dictating.peek() === held.owner || transcribing.peek().has(held.owner))) return;
    updateDraft(held.owner, { attachments: chip ? list.map((entry) => (entry.fileId === id ? attachment : entry)) : [...list, attachment] });
  });
}

/** After a reload the held pieces are chips of their drafts again (once the drafts are loaded), then they upload. */
async function restoreHeld(): Promise<void> {
  for (const held of await takeStore.list()) {
    const draft = held.owner ? draftFor(held.owner).peek() : null;
    if (held.owner && draft && !draft.attachments.some((entry) => entry.fileId === HELD_PREFIX + held.key)) updateDraft(held.owner, { attachments: [...draft.attachments, heldAttachment(held)] });
  }
  if (rpc.status.peek() === 'open') flushHeld();
}

if (typeof window !== 'undefined') {
  effect(() => { if (loaded.value) void restoreHeld(); });
  rpc.onOpen(() => { if (loaded.peek()) flushHeld(); });
}
