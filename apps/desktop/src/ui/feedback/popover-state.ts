// B-055: opening and closing feedback from anywhere (the cell itself, the command palette, /feedback, Settings ›
// Feedback, the Android app's crash report). lib/shell-state.ts `feedbackOpen` stays the request ("open, from this
// place"); `overlayShown` is whether the snapshot overlay (FeedbackOverlay.tsx) is drawn.
// Feedback 16.11.2026 (F11, F15 – "der ist generell dafür da, einen Snapshot davon zu machen"): every opening freezes the
// window. `snapshot` takes the window's screenshot now and puts it into the draft in place of the one before (its marks
// went with it; the words, the photos and a crash report stay; the stage shows the new shot); the overlay shows once it is there (bounded). The
// cell's press takes it on pointer down, before anything opens (`pressSnapshot` – the opening that follows uses it); any
// other opening takes it after two frames (a closing palette, the side browser's view coming back). A snapshot while
// the overlay is shown is a snapshot of the overlay itself: nothing in the draft changes before the new image is there,
// so the shot shows exactly what was on screen (the marks included). The feedback cells register here (`registerCell`):
// the spot of the row's cell (`cellSpot` – an open dialog draws the cell's slot there, lib/dialog.tsx) and the cell on
// top (`topCell` – the shortcut's talk pill hangs from it).
// Owns: the open/close helpers, the overlay's visibility, the snapshot and the cell registry. Never: the overlay, the
// form or sending.

import { effect, signal } from '@preact/signals';
import { feedbackOpen } from '../lib/shell-state.ts';
import { formatRoute, route } from '../lib/router.ts';
import { activeConversationId } from '../lib/store.ts';
import { canCaptureWindow, captureWindow } from './bridge.ts';
import { feedbackDraft, shotFits, shotTaking } from './draft.ts';
import type { DraftPlace, FeedbackDraft } from './draft.ts';

/** The snapshot overlay is drawn. */
export const overlayShown = signal(false);

/** The overlay waits this long at most for its snapshot (the Android app's own shot takes up to 2 s, native-port.ts). */
export const SNAPSHOT_WAIT_MS = 2000;

/** Where the person is now (the report's context, feedbackOpen's value). */
export function here(): DraftPlace {
  const current = route.peek();
  return { view: formatRoute(current), conversationId: activeConversationId.peek() ?? undefined };
}

export function openFeedback(): void { if (!feedbackOpen.value) feedbackOpen.value = here(); }
export function closeFeedback(): void { feedbackOpen.value = null; overlayShown.value = false; }

// ---------------------------------------------------------------- the snapshot

/**
 * The draft frozen anew: `shot` replaces its screenshot (the marks belonged to that one) and is shown; the words, photos
 * and the rest stay. With the photos at the image cap it comes unticked (shown, it goes once a photo is removed and its
 * box ticked) – nothing the person sees is cut at Send.
 */
export function frozen(draft: FeedbackDraft, shot: string | null, where?: DraftPlace): FeedbackDraft {
  return { ...draft, shot, marks: [], withShot: shotFits(draft), onStage: null, ...(where ? { where } : {}) };
}

let snapping: Promise<void> | null = null;
let pressed = false; // the cell's press took the snapshot of the opening that follows

/**
 * Freezes the window now. With the overlay closed the shot replaces the draft's (a failed capture leaves none – never an
 * older screen); with it shown the overlay itself is the shot, the draft changes once the image is there and a failed
 * capture keeps the one shown. A host that cannot capture (the iPhone web app, a browser) takes none (`capture`/`can`:
 * the host's, a fake in tests).
 */
export function snapshot(where: DraftPlace | undefined, capture: () => Promise<string | null> = captureWindow, can: boolean = canCaptureWindow()): Promise<void> {
  if (snapping) return snapping;
  if (!can) return Promise.resolve();
  const over = overlayShown.peek();
  if (!over) shotTaking.value = true;
  snapping = capture()
    .catch(() => null)
    .then((image) => { if (image || !over) feedbackDraft.value = frozen(feedbackDraft.peek(), image, where); })
    .finally(() => { snapping = null; shotTaking.value = false; });
  return snapping;
}

/** Resolves when the snapshot on its way is there – or after `limitMs`, whichever is first. */
export function snapshotSettled(limitMs = SNAPSHOT_WAIT_MS): Promise<void> {
  const pending = snapping;
  if (!pending) return Promise.resolve();
  return Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, limitMs))]);
}

/** The cell's press (pointer down or the shortcut, before anything opens): the snapshot of the opening that follows. */
export function pressSnapshot(): void {
  pressed = true;
  void snapshot(here());
}

/** A press that opens nothing (its pointer was taken away, its talk discarded): the next opening takes its own. */
export function forgetPress(): void {
  pressed = false;
}

const frame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve());
  setTimeout(resolve, 100); // a window that does not paint (hidden) still opens
});

async function prepare(): Promise<void> {
  if (pressed) { pressed = false; await snapshotSettled(); return; }
  await frame();
  await frame();
  void snapshot(here());
  await snapshotSettled(); // bounded: a slow capture never keeps the overlay away
}

/**
 * Installed once by the feedback host: a request shows the overlay after its snapshot (the press's, else one taken
 * now); a cleared request hides it. Returns the uninstall.
 */
export function watchFeedbackOpen(): () => void {
  let preparing = false;
  return effect(() => {
    if (feedbackOpen.value === null) { pressed = false; if (overlayShown.peek()) overlayShown.value = false; return; }
    if (overlayShown.peek() || preparing) return;
    preparing = true;
    void prepare().catch(() => undefined).then(() => {
      preparing = false;
      if (feedbackOpen.peek()) overlayShown.value = true;
    });
  });
}

// ---------------------------------------------------------------- the cells

interface Cell { element: HTMLElement; slot: boolean }
const cells: Cell[] = [];

/** A feedback cell's button mounted (`slot`: the one an open dialog draws at the cell's spot); returns its removal. */
export function registerCell(element: HTMLElement, slot: boolean): () => void {
  const cell = { element, slot };
  cells.push(cell);
  return () => { const at = cells.indexOf(cell); if (at >= 0) cells.splice(at, 1); };
}

const shownRect = (element: HTMLElement): DOMRect | null => {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
};

/** Where the row's feedback cell is on screen (the newest shown one: a pushed phone screen's row over the frame's). */
export function cellSpot(): DOMRect | null {
  for (let at = cells.length - 1; at >= 0; at--) {
    const cell = cells[at]!;
    const rect = cell.slot ? null : shownRect(cell.element);
    if (rect) return rect;
  }
  return null;
}

/** The cell on top: the slot of the dialog opened last, else the row's. */
export function topCell(): HTMLElement | null {
  for (let at = cells.length - 1; at >= 0; at--) if (shownRect(cells[at]!.element)) return cells[at]!.element;
  return null;
}
