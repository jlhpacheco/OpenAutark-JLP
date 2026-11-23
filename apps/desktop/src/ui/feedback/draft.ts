// B-055 Q4: the one feedback draft of this window – the text, the window screenshot taken when the
// header cell was pressed, its marks ("Paint over") and the "Screenshot" checkbox (on by default) –
// shared by the header menu and Settings › Feedback's "New report". Owner 21.11.2026: photos the
// person added (Add photo, several), each with its own marks, and which image the stage shows
// (`onStage`: a photo's id, null = the window shot); at Send every image goes flattened with its marks
// (`draftImages`: the shot first). What goes stays within FEEDBACK_IMAGES_MAX before Send, never cut at it: the ticked shot
// counts as one image (photoRoom), a shot finding the cap full comes unticked (shotFits). It survives closing the menu
// until it is sent; the screenshot is frozen by the cell's press (popover-state.ts snapshot). Talk from the cell and the mic in the field both append to the text (joinText).
// Feedback 16.11.2026: an Android crash report the app handed over ("Crash report attached", on by default) belongs to
// the draft too and alone makes a report worth sending (canSubmit). Owner 20.11.2026: a report is its words – dictated
// words join the text (the draft then says it was `dictated`), no recording is kept. The outbox (outbox.ts) keeps the
// draft in this page's storage across a reload.
// Owns: the draft state and its changes (photos, marks on the image shown). Never: takes the screenshot, uploads,
// sends or draws anything.

import { signal } from '@preact/signals';
import { FEEDBACK_CLIENT_DIAGNOSTICS_MAX, FEEDBACK_IMAGES_MAX } from '../../shared/model/feedback-delivery.ts';
import type { PaintMark } from './paint.ts';

/** Where the person was when the screenshot was taken (the report's context). */
export interface DraftPlace { view?: string; conversationId?: string }

/** A photo the person added: the picked image (data URL) and the marks painted over it. */
export interface DraftPhoto { id: string; src: string; marks: readonly PaintMark[] }

export interface FeedbackDraft {
  text: string;
  /** The captured window (data URL), null while none. */
  shot: string | null;
  /** Marks painted over `shot`. */
  marks: readonly PaintMark[];
  /** The "Screenshot" checkbox. */
  withShot: boolean;
  photos: readonly DraftPhoto[];
  /** The image on the stage: a photo's id; null – the window shot (or, without one, the last photo). */
  onStage: string | null;
  where: DraftPlace;
  /** Words were dictated into the text (the report says so: read it for what was meant). */
  dictated: boolean;
  /** An Android crash report the app handed over (≤ FEEDBACK_CLIENT_DIAGNOSTICS_MAX characters). */
  diagnostics?: string;
  /** "Crash report attached": it goes with the report. */
  withDiagnostics: boolean;
}

export const EMPTY_DRAFT: FeedbackDraft = { text: '', shot: null, marks: [], withShot: true, photos: [], onStage: null, where: {}, dictated: false, withDiagnostics: true };

/** The report's words when only the crash report says what happened. */
export const CRASH_ONLY_TEXT = '(crash report)';

/** Nothing in the draft that a report would carry from the person (the screenshot alone is retaken on the next press). */
export function isEmptyDraft(draft: Pick<FeedbackDraft, 'text' | 'marks' | 'diagnostics' | 'photos'>): boolean {
  return !draft.text.trim() && !draft.marks.length && !draft.diagnostics && !draft.photos.length;
}

/** Send is possible: words, or an attached crash report. */
export function canSubmit(draft: Pick<FeedbackDraft, 'text' | 'diagnostics' | 'withDiagnostics'>): boolean {
  return draft.text.trim() !== '' || (draft.withDiagnostics && !!draft.diagnostics);
}

/** The report's text: the person's words, else that the crash report says what happened. */
export function reportText(draft: Pick<FeedbackDraft, 'text'>): string {
  return draft.text.trim() || CRASH_ONLY_TEXT;
}

/** The Android app handed over a crash report ("Report" on its crash screen): it rides with the next report. */
export function attachCrashReport(text: string): void {
  const trimmed = text.trim().slice(0, FEEDBACK_CLIENT_DIAGNOSTICS_MAX);
  if (trimmed) updateDraft({ diagnostics: trimmed, withDiagnostics: true });
}

export const feedbackDraft = signal<FeedbackDraft>(EMPTY_DRAFT);
/**
 * The draft as it was sent, while its send is on its way (feedback 17.11.2026, Mika: during "Sending…" the form showed
 * the fresh draft – a box ticked again – as if it sent what the person had unticked). The outbox holds the report
 * and the draft is fresh at once (a second press never sends it twice); the form and the overlay show this one,
 * disabled, until the outcome.
 */
export const sentDraft = signal<FeedbackDraft | null>(null);

/** What the form and the overlay show: the draft on its way while it goes, else the draft. */
export function shownDraft(): FeedbackDraft {
  return sentDraft.value ?? feedbackDraft.value;
}
/** A screenshot is being taken for the draft (its thumbnail shows a placeholder meanwhile). */
export const shotTaking = signal(false);

/** Dictated words after what is already there, one space between. */
export function joinText(current: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return current;
  if (!current.trim()) return words;
  return /\s$/.test(current) ? `${current}${words}` : `${current} ${words}`;
}

export function updateDraft(change: Partial<FeedbackDraft>): void {
  feedbackDraft.value = { ...feedbackDraft.peek(), ...change };
}

/** A dictation's words join the text (feedback mic, the cell's talk). */
export function appendDraftText(spoken: string): void {
  updateDraft({ text: joinText(feedbackDraft.peek().text, spoken), dictated: true });
}

// ---------------------------------------------------------------- images

/** One image of the draft: the window shot (`photo` absent) or a photo, with its marks. */
export interface DraftImage { src: string; marks: readonly PaintMark[]; photo?: string }

/** The image the stage shows: the chosen photo, else the window shot, else the last photo; null when there is none. */
export function stageImage(draft: Pick<FeedbackDraft, 'shot' | 'marks' | 'photos' | 'onStage'>): DraftImage | null {
  const chosen = draft.photos.find((photo) => photo.id === draft.onStage);
  const photo = chosen ?? (draft.shot ? undefined : draft.photos.at(-1));
  if (photo) return { src: photo.src, marks: photo.marks, photo: photo.id };
  return draft.shot ? { src: draft.shot, marks: draft.marks } : null;
}

/** What goes at Send, in order: the window shot (when it goes), then the photos – all of them (the cap holds before Send). */
export function draftImages(draft: Pick<FeedbackDraft, 'shot' | 'marks' | 'withShot' | 'photos'>): DraftImage[] {
  const shot: DraftImage[] = draft.withShot && draft.shot ? [{ src: draft.shot, marks: draft.marks }] : [];
  return [...shot, ...draft.photos.map((photo) => ({ src: photo.src, marks: photo.marks, photo: photo.id }))];
}

/** How many photos the draft takes still (the window shot, while it goes, counts as one image). */
export function photoRoom(draft: Pick<FeedbackDraft, 'shot' | 'withShot' | 'photos'>): number {
  return Math.max(0, FEEDBACK_IMAGES_MAX - (draft.withShot && draft.shot ? 1 : 0) - draft.photos.length);
}

/** The window shot fits beside the photos (else it stays unticked: its box waits until a photo goes). */
export function shotFits(draft: Pick<FeedbackDraft, 'photos'>): boolean {
  return draft.photos.length < FEEDBACK_IMAGES_MAX;
}

let photoCount = 0;

/** Adds picked photos (as far as there is room) and shows the first of them; answers how many were added. */
export function addPhotos(sources: readonly string[]): number {
  const draft = feedbackDraft.peek();
  const added = sources.slice(0, photoRoom(draft)).map((src) => ({ id: `photo-${Date.now().toString(36)}-${++photoCount}`, src, marks: [] }));
  if (added.length) updateDraft({ photos: [...draft.photos, ...added], onStage: added[0]!.id });
  return added.length;
}

/** Removes a photo; the stage then shows the window shot (or the last photo). */
export function removePhoto(id: string): void {
  const draft = feedbackDraft.peek();
  updateDraft({ photos: draft.photos.filter((photo) => photo.id !== id), ...(draft.onStage === id ? { onStage: null } : {}) });
}

/** A finished mark joins the image it was drawn on (`on`: stageImage's at the stroke's start) – gone meanwhile: dropped. */
export function addMark(mark: PaintMark, on: DraftImage): void {
  const draft = feedbackDraft.peek();
  if (on.photo) {
    if (!draft.photos.some((photo) => photo.id === on.photo)) return;
    updateDraft({ photos: draft.photos.map((photo) => (photo.id === on.photo ? { ...photo, marks: [...photo.marks, mark] } : photo)) });
  } else if (draft.shot === on.src) {
    updateDraft({ marks: [...draft.marks, mark] });
  }
}

/** Undo: the last mark of the image on the stage goes. */
export function undoMark(): void {
  const draft = feedbackDraft.peek();
  const shown = stageImage(draft);
  if (!shown?.marks.length) return;
  if (!shown.photo) { updateDraft({ marks: draft.marks.slice(0, -1) }); return; }
  updateDraft({ photos: draft.photos.map((photo) => (photo.id === shown.photo ? { ...photo, marks: photo.marks.slice(0, -1) } : photo)) });
}

/** After sending: a fresh draft (the next press takes a new screenshot). */
export function clearDraft(): void {
  feedbackDraft.value = EMPTY_DRAFT;
}
