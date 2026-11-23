// B-055 Q4: the feedback cell's button (megaphone, tooltip "Feedback – Ctrl+Shift+F, hold to talk") – the same in every
// view: the desktop frame's cell right before the caption controls (shell/WindowBar.tsx) and, on the phone, the last cell
// of every row (cell.tsx: the frame's row before Profile, a chat's, an agent's, a person's, the "only My day" screen's).
// Feedback 16.11.2026 (F11, F13, F15): a press is a snapshot. Pointer down freezes the window at once (popover-state.ts
// pressSnapshot – before anything opens, so nothing of ours is in it); a short click opens the snapshot overlay
// (FeedbackOverlay.tsx); a press held HOLD_MS or longer is talk (press.ts): dictation starts, a slim waveform pill shows
// under the cell (TalkPill.tsx), and the release stops it and opens the overlay with the words in the field. A click
// while the overlay is open freezes the overlay itself (a new snapshot, the words stay); a hold there only talks. Inside
// an open dialog and the overlay the same button is drawn at the cell's spot (`slot`, lib/dialog.tsx DialogSlot), so it
// can be pressed above anything. The shortcut (main forwards its key going down and up: listenFeedbackKey) is the same
// press from the keyboard, and so is the Android app's quick way in (owner 16.11.2026, F15: volume up and volume down
// together – native-port.ts {t:'feedback', down}); Enter/Space on the button is a click; Escape during talk discards it.
// All cells share one press. Without dictation here every press is a click. The look changes only colour (pressed while
// the overlay is open), never the box.
// Owns: the button, the press of every cell, of the shortcut and of the phone's keys, and the talk's dictation. Never:
// the overlay, the form or sending.

import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { FEEDBACK_COMBO } from '../../shared/api/workspace-browser-keys.ts';
import { comboLabel } from '../lib/hotkeys.ts';
import { Icon } from '../lib/icons.tsx';
import { bridge, os } from '../lib/platform.ts';
import { settings } from '../lib/store.ts';
import { feedbackKeySteps, onNative } from '../pwa/native-port.ts';
import { DictationButton, panelDictation, panelDictationAvailable } from './bridge.ts';
import type { DictationState } from './bridge.ts';
import { appendDraftText } from './draft.ts';
import { forgetPress, openFeedback, overlayShown, pressSnapshot, registerCell, snapshot, topCell } from './popover-state.ts';
import { KeyPress, PressTracker } from './press.ts';
import type { TapSource } from './press.ts';
import { TalkPill } from './TalkPill.tsx';

/** The cell's talk: its dictation state and the button its pill hangs from while it is held (null: no talk). */
export const talkState = signal<DictationState>('idle');
export const talkError = signal<string | null>(null);
const talkFrom = signal<HTMLElement | null>(null);
let pressedOn: HTMLElement | null = null; // the button the running press began on (the shortcut: the cell on top)

let talk: DictationButton | null = null;
function cellDictation(): DictationButton {
  talk ??= new DictationButton(panelDictation, {
    state: (state) => { talkState.value = state; },
    error: (message) => { talkError.value = message; },
    text: (text) => appendDraftText(text),
    language: () => settings.peek()?.profile.language,
  });
  return talk;
}

/** The form's × (the + turned): the cell's take goes – recording or being transcribed, its words never reach the field. */
export function cancelTalk(): void {
  talk?.cancel();
}

/** Escape during talk discards it (the field never gets its words) – and closes nothing else. */
const escape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  press.cancel();
};

function talkEnded(): void {
  talkFrom.value = null;
  document.removeEventListener('keydown', escape, true);
}

/** One press for every cell and the shortcut (one at a time; a second finger or key is ignored). */
const press = new PressTracker({
  press: () => { if (!overlayShown.peek()) pressSnapshot(); },
  tap: (source: TapSource) => {
    talkError.value = null; // an earlier talk's error is not this one's
    if (overlayShown.peek()) { void snapshot(undefined); return; } // the overlay itself, the words stay
    if (source === 'key') forgetPress(); // Enter/Space: no press froze the window – the opening does
    openFeedback();
  },
  holdStart: () => {
    talkFrom.value = pressedOn;
    talkError.value = null;
    document.addEventListener('keydown', escape, true);
    cellDictation().beginHold();
  },
  holdEnd: () => { talkEnded(); cellDictation().endHold(); openFeedback(); },
  holdCancel: () => { talkEnded(); forgetPress(); cellDictation().cancel(); },
}, { canHold: panelDictationAvailable });

const keyPress = new KeyPress(press);
const phoneKeys = new KeyPress(press);
let keyListening = false;

/** A key's step on the press of the cell on top (its talk pill hangs from that cell). */
function keyStep(keys: KeyPress, step: 'down' | 'up'): void {
  if (step === 'up') { keys.up(); return; }
  if (press.phase === 'idle') pressedOn = topCell();
  keys.down();
}

/**
 * The shortcut from main (desktop: Ctrl+Shift+F, Cmd+Shift+F on macOS – in the app's page and in a side browser page) and
 * the Android app's volume keys pressed together (native-port.ts {t:'feedback'}): the press of the cell on top – short
 * opens, held talks. A window that loses the keyboard while one is held releases it. Installed once by the feedback
 * host; returns the uninstall.
 */
export function listenFeedbackKey(): () => void {
  if (keyListening) return () => undefined;
  keyListening = true;
  const stop = bridge?.onFeedbackKey?.((step) => keyStep(keyPress, step)) ?? (() => undefined);
  const stopPhone = onNative('feedback', (msg) => { for (const step of feedbackKeySteps(msg)) keyStep(phoneKeys, step); });
  const blur = () => { keyPress.blur(); phoneKeys.blur(); };
  window.addEventListener('blur', blur);
  return () => { keyListening = false; stop(); stopPhone(); window.removeEventListener('blur', blur); };
}

/** The button's tooltip: what the press does here (the shortcut on the computer, talk where this page dictates). */
function tooltip(): string {
  const ways = [...(bridge?.onFeedbackKey ? [comboLabel(FEEDBACK_COMBO)] : []), ...(panelDictationAvailable() ? ['hold to talk'] : [])];
  return ways.length ? `Feedback – ${ways.join(', ')}` : 'Feedback';
}

/** `slot`: the button an open dialog or the overlay draws at the cell's spot (lib/dialog.tsx DialogSlot). */
export function FeedbackButton(props: { iconSize?: number; slot?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => (ref.current ? registerCell(ref.current, props.slot === true) : undefined), []);

  const open = overlayShown.value;
  const talking = talkFrom.value !== null && talkFrom.value === ref.current;
  return (
    <>
      <button ref={ref} type="button" class={`icon-button frame-header-button feedback-toggle${open ? ' selected' : ''}`}
        aria-label="Feedback" title={tooltip()} aria-haspopup="dialog" aria-expanded={open}
        aria-keyshortcuts={bridge?.onFeedbackKey ? (os === 'mac' ? 'Meta+Shift+F' : 'Control+Shift+F') : undefined}
        data-keeps-popovers="" // an open menu stays for the snapshot (lib/popover.tsx)
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
          if (press.phase === 'idle') pressedOn = event.currentTarget;
          press.down();
        }}
        onPointerUp={() => press.up()}
        onPointerCancel={() => { press.cancel(); forgetPress(); }}
        onContextMenu={(event) => event.preventDefault()} // a long press opens no menu on a phone
        onClick={(event) => { if (event.detail === 0) press.key(); }}>
        <Icon name="megaphone" size={props.iconSize ?? 18} />
      </button>
      {talking && <TalkPill anchor={ref.current} live={talkState.value === 'listening'} />}
    </>
  );
}
