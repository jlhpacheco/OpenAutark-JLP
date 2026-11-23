// Feedback 16.11.2026 (F11, F15 – "der ganze Bildschirm ist einfach im Freeze … nur unten … die Buttons"): the snapshot
// overlay, which replaced the menu popover, its screenshot row and "Paint over". A press on the feedback cell (or the
// shortcut) froze the window (popover-state.ts snapshot); this modal <dialog> – opened after any open dialog, so it lies
// above them, and the side browser's native view hides under it (workspace/native-surface.ts) – shows that shot over the
// whole window at 1:1, so the app stands still. The person paints straight on it (AnnotationCanvas: the pen, and Undo –
// opaque marks, flattened into the report's JPEGs at Send) and writes or talks in the slim dock at the bottom
// (FeedbackPanel.tsx FeedbackForm; the attachments' first cells from here). Pressing the cell again – the
// overlay draws its slot at the cell's spot (lib/dialog.tsx DialogSlot) – or the shortcut freezes the overlay itself:
// a new snapshot with the old one and the dock in it, the words stay. The arrow or Escape closes it and keeps the draft.
// On the phone the same, full screen, with the Android app's own shot. Owner 21.11.2026: the form's + ("Add photo")
// adds photos beside the shot (several); the attachments row shows the Screenshot chip and one thumbnail per photo (×
// removes it), a click on either shows that image on the stage to paint on, and Undo takes the last mark of the image
// shown. Everyone paints with the pen only (feedback 16.11.2026 C2CC3D50: "nur Pen und ein Zurück"). Where nothing
// captures the window (the iPhone web app, a browser) there is no Screenshot chip: the photos alone, the dock over the
// live screen until one is added.
// While a send is on its way the overlay shows the draft as sent, its tools disabled (draft.ts sentDraft).
// Owns: the overlay dialog, the frozen stage and the attachments' cells (Screenshot chip, photos, Undo). Never: the form's words, sending or
// taking the snapshot (popover-state.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { DialogSlot } from '../lib/dialog.tsx';
import { Icon } from '../lib/icons.tsx';
import { AnnotationCanvas } from './AnnotationCanvas.tsx';
import { canCaptureWindow } from './bridge.ts';
import { PHOTO_HINT, SHOT_HINT, SHOT_LABEL, SHOT_MISSING, SHOT_NO_ROOM } from './delivery.ts';
import { addMark, removePhoto, sentDraft, shotFits, shownDraft, stageImage, undoMark, updateDraft } from './draft.ts';
import type { DraftImage, FeedbackDraft } from './draft.ts';
import { FeedbackForm } from './FeedbackPanel.tsx';
import { loadImage } from './paint-image.ts';
import { closeFeedback, overlayShown } from './popover-state.ts';

export function FeedbackOverlay(props: { onInbox: () => void }) {
  const shown = overlayShown.value;
  const ref = useRef<HTMLDialogElement>(null);
  const [modal, setModal] = useState(false); // in the top layer: the cell's slot can follow it there
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shown && !dialog.open) dialog.showModal();
    if (!shown && dialog.open) dialog.close();
    setModal(dialog.open);
  }, [shown]);
  return (
    <dialog ref={ref} class="feedback-overlay" aria-label="Feedback"
      onCancel={(event) => { event.preventDefault(); closeFeedback(); }} // Escape: the draft stays
      // closed by the system; the close event of a quick close→reopen comes late and closes nothing
      onClose={() => { if (overlayShown.peek() && !ref.current?.open) closeFeedback(); }}>
      {shown && <Frozen onInbox={props.onInbox} />}
      {shown && modal && <DialogSlot anywhere />}
    </dialog>
  );
}

function Frozen(props: { onInbox: () => void }) {
  const draft = shownDraft();
  return (
    <>
      <Stage draft={draft} />
      <FeedbackForm onClose={closeFeedback} onInbox={props.onInbox} tools={<ImageTools draft={draft} />} />
    </>
  );
}

/** The window shot is shown and does not go (its box is unticked): it dims and takes no paint. */
const shotOff = (draft: FeedbackDraft, shown: DraftImage | null): boolean => !!shown && !shown.photo && !draft.withShot;

/**
 * The frozen screen: the image on the stage at 1:1 (its own pixels, never upscaled past the window) with the marks' layer
 * over it. A mark joins the image it was drawn on (a new snapshot or a removed photo meanwhile: it is dropped).
 */
function Stage(props: { draft: FeedbackDraft }) {
  const shown = stageImage(props.draft);
  const src = shown?.src ?? null;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImage(null);
    if (!src) return;
    let live = true;
    loadImage(src).then((loaded) => { if (live) setImage(loaded); }, () => undefined);
    return () => { live = false; };
  }, [src]);
  if (!shown) return null; // nothing frozen (the iPhone web app before a photo): the dock lies over the live screen
  const dim = shotOff(props.draft, shown);
  return (
    <div class={`feedback-stage${dim ? ' off' : ''}`}>
      <div class="feedback-frame">
        <img src={shown.src} alt="" draggable={false} />
        {image && <AnnotationCanvas image={image} marks={shown.marks} disabled={dim || sentDraft.value !== null} onMark={(mark) => addMark(mark, shown)} />}
      </div>
    </div>
  );
}

/** The dock's first cells: the Screenshot chip (its box: whether it goes), one thumbnail per photo (× removes it), Undo. */
function ImageTools(props: { draft: FeedbackDraft }) {
  const { draft } = props;
  const shown = stageImage(draft);
  const going = sentDraft.value !== null; // a send on its way: shown as sent, nothing to change
  const full = !draft.withShot && !shotFits(draft); // ticking it would pass the image cap
  return (
    <div class="feedback-tools">
      {canCaptureWindow() && (
        <span class={`feedback-check feedback-chip${shown && !shown.photo ? ' on-stage' : ''}`} title={!draft.shot ? SHOT_MISSING : full ? SHOT_NO_ROOM : SHOT_HINT}>
          <input type="checkbox" aria-label="Send the screenshot" checked={draft.withShot && draft.shot !== null} disabled={draft.shot === null || going || full}
            onChange={(event) => updateDraft({ withShot: (event.currentTarget as HTMLInputElement).checked })} />
          <button type="button" class="feedback-chip-show" disabled={draft.shot === null} aria-pressed={!!shown && !shown.photo}
            onClick={() => updateDraft({ onStage: null })}>{SHOT_LABEL}</button>
        </span>
      )}
      {draft.photos.map((photo, index) => (
        <span key={photo.id} class={`feedback-photo${shown?.photo === photo.id ? ' on-stage' : ''}`}>
          <button type="button" class="feedback-photo-show" aria-label={`Photo ${index + 1} – paint over it`} title={PHOTO_HINT}
            aria-pressed={shown?.photo === photo.id} onClick={() => updateDraft({ onStage: photo.id })}>
            <img src={photo.src} alt="" draggable={false} />
          </button>
          <button type="button" class="feedback-photo-remove" aria-label={`Remove photo ${index + 1}`} title="Remove" disabled={going}
            onClick={() => removePhoto(photo.id)}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <button type="button" class="icon-button small" aria-label="Undo" title="Undo"
        disabled={going || !shown?.marks.length || shotOff(draft, shown)} onClick={undoMark}>
        <Icon name="arrow-counter-clockwise" size={16} />
      </button>
    </div>
  );
}
