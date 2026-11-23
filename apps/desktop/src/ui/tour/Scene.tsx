// B-055 Q5, re-cut 16.11.2026 for the snapshot overlay (F11/F15): the tour's scene at one moment – the example app
// (AppMock.tsx: the computer's window or a phone's screen) with "Mira is typing" moving, and over it what the timeline
// says shows now: the cell's tooltip (the computer), the frozen screen – the same app at 1:1 standing still, a short
// flash as the snapshot is taken, the cell drawn pressed at its spot, the pen's stroke on it – and the dock at its foot
// (the Screenshot box, Undo; the close arrow, the field with the mic – listening, then the words
// – and Send; the privacy line), the status line's "Feedback sent · No. …" after Send, and the pointer: the computer's
// big cursor or a fingertip, with its press ring. The Android tour's bubble chapter: the top row's round icon and the
// to-do bubble pulled out of it, under the finger and then where it was dropped. It imitates the live overlay (ui/feedback, styles/feedback.css) but
// uses no live component, store or call – only the CSS tokens – so it follows light and dark, never disturbs live
// operation and never breaks when the live UI is rebuilt. Pure rendering of a TourState (timeline.ts): the same t
// draws the same picture, so playing and scrubbing look alike. Every animation is computed from the state's time and
// ages, never a CSS transition.
// Owns: this drawing. Never: time, input or the player's controls (TourPlayer.tsx).

import { AppMock, AutarkDot, Cell, place, type CellLook } from './AppMock.tsx';
import { TourIcon } from './icons.tsx';
import { PEN, type Layout, type Rect } from './scene-layout.ts';
import { CELL_TIP, RIPPLE_MS, SENT_LINE, WORDS, type Toggle, type Tour, type TourState } from './timeline.ts';
import type { Point } from '../../shared/model/pointer-motion.ts';

const fade = (toggle: Toggle, ms = 140) => Math.min(1, toggle.age / ms);
/** An entry: fades in and comes `rise` units from below (negative: from above), from the toggle's age. */
const enter = (toggle: Toggle, rise: number) => {
  const k = fade(toggle);
  return { opacity: String(k), transform: `translateY(${((1 - k) * rise).toFixed(2)}px)` };
};

/** "Mira is typing": three dots moving with the time – `at` the live time, or the moment the screen froze. */
function Typing(props: { rect: Rect; at: number }) {
  return (
    <span class="tour-typing" style={place(props.rect)}>
      {[0, 1, 2].map((i) => <span key={i} style={{ opacity: (0.3 + 0.7 * Math.max(0, Math.sin(props.at / 170 - i * 0.9))).toFixed(2) }} />)}
    </span>
  );
}

/** The pen's stroke on the frozen screen (scene units, 1:1): its first `count` points and the pen's tip. */
function Ink(props: { layout: Layout; path: readonly Point[]; count: number; tip: Point | null }) {
  const { layout } = props;
  if (props.count === 0 && !props.tip) return null;
  const points = props.path.slice(0, props.count).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  if (props.tip) points.push(`${props.tip.x.toFixed(1)},${props.tip.y.toFixed(1)}`);
  return (
    <svg class="tour-ink" viewBox={`0 0 ${layout.w} ${layout.h}`} width={layout.w} height={layout.h} aria-hidden="true">
      <polyline points={points.join(' ')} fill="none" stroke-width={PEN} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** The dock at the foot of the frozen screen, as the live one (FeedbackPanel.tsx FeedbackForm): it grows upward with
 *  the field's text, its main row keeps its place. */
function Dock(props: { tour: Tour; state: TourState }) {
  const { layout } = props.tour;
  const { state } = props;
  const shown = Math.ceil(state.words);
  const partial = shown - state.words; // 0 when the newest word is whole
  const typing = state.words > 0 && state.words < WORDS.length;
  const look = (id: string) => (state.hot === id ? (state.pressed ? ' look-down' : ' look-hot') : '');
  const { dock } = layout;
  return (
    <div class="tour-dock" style={{ left: `${dock.x}px`, width: `${dock.w}px`, bottom: `${dock.bottom}px`, ...enter(state.frozen, 8) }}>
      <div class="tour-dock-row">
        <span class="tour-chip"><span class="tour-checkbox"><TourIcon name="check" size={12} /></span>Screenshot</span>
        <span class="tour-undo"><TourIcon name="back" size={16} /></span>
      </div>
      <div class="tour-dock-main">
        <span class={`tour-dock-close${look('close')}`}><TourIcon name="arrow-down" size={18} /></span>
        <span class={`tour-field${state.words > 0 ? ' filled' : ''}`}>
          {shown === 0
            ? <span class="tour-placeholder">What happened, or what would you like?</span>
            : (
              <span>
                {WORDS.slice(0, shown - 1).join(' ')}{shown > 1 ? ' ' : ''}
                <span style={{ opacity: String(1 - partial) }}>{WORDS[shown - 1]}</span>
                {typing && <span class="tour-caret" />}
              </span>
            )}
          <span class={`tour-mic${state.listen.on ? ' active' : look('mic')}`}>
            {state.busy.on
              ? <span class="tour-spin" style={{ transform: `rotate(${Math.round(state.busy.age * 0.6)}deg)` }}><TourIcon name="circle-notch" size={18} /></span>
              : <TourIcon name={state.listen.on ? 'stop' : 'microphone'} size={18} />}
          </span>
        </span>
        <span class={`tour-send${look('send')}`}>Send</span>
      </div>
      <p class="tour-note">
        Text, the screenshot you keep, and app/device details are sent encrypted to Teydra Lab. <span class="tour-note-link">Feedback privacy</span>
      </p>
    </div>
  );
}

/** The frozen screen: the app as it was at the press (its typing dots stand still), the pen's stroke on it, the cell
 *  at its spot (the overlay draws it there, pressable again), a short flash as the shot is taken, the dock. */
function Frozen(props: { tour: Tour; state: TourState; cell: CellLook }) {
  const { tour, state } = props;
  const { layout } = tour;
  return (
    <div class="tour-frozen">
      <AppMock layout={layout} cell="idle" />
      <Typing rect={layout.typing} at={state.t - state.frozen.age} />
      <Ink layout={layout} path={tour.paintPath} count={state.paint} tip={state.paintTip} />
      <Cell rect={layout.cell} icon="megaphone" look={props.cell} class="tour-feedback-cell" />
      <span class="tour-flash" style={{ opacity: String(Math.max(0, 0.6 * (1 - state.frozen.age / 320)).toFixed(3)) }} />
      <Dock tour={tour} state={state} />
    </div>
  );
}

/** The computer's cursor (a classic big arrow, tip at the point, a soft shadow; pressed it dips a little) or a phone's
 *  fingertip (a soft disc, its centre at the point; pressed it is darker and smaller), with the press's ring. */
function Pointer(props: { layout: Layout; state: TourState }) {
  const { pointer, pressed, ripple } = props.state;
  const size = props.layout.pointer;
  const k = size / 54;
  return (
    <>
      {ripple && (
        <span class="tour-ripple" style={{
          left: `${ripple.x}px`, top: `${ripple.y}px`, opacity: String(0.55 * (1 - ripple.age / RIPPLE_MS)),
          transform: `translate(-50%, -50%) scale(${(0.3 + 0.7 * (ripple.age / RIPPLE_MS)).toFixed(3)})`,
        }} />
      )}
      {props.layout.variant === 'phone' ? (
        <span class={`tour-finger${pressed ? ' pressed' : ''}`} style={{
          width: `${size}px`, height: `${size}px`,
          transform: `translate(${(pointer.x - size / 2).toFixed(2)}px, ${(pointer.y - size / 2).toFixed(2)}px) scale(${pressed ? 0.86 : 1})`,
        }} />
      ) : (
        <span class="tour-cursor" style={{ transform: `translate(${(pointer.x - 2 * k).toFixed(2)}px, ${(pointer.y - 2 * k).toFixed(2)}px) scale(${pressed ? 0.9 : 1})` }}>
          <svg width={38 * k} height={54 * k} viewBox="0 0 38 54" aria-hidden="true">
            <path d="M2 2 L2 42 L11.5 33 L18.5 49.5 L25 46.7 L18.2 30.6 L31.5 30.6 Z" stroke-width="2.4" stroke-linejoin="round" />
          </svg>
        </span>
      )}
    </>
  );
}

export function Scene(props: { tour: Tour; state: TourState }) {
  const { tour, state } = props;
  const { layout } = tour;
  const frozen = state.frozen.on;
  const cell: CellLook = state.hot === 'feedback' ? (state.pressed ? 'down' : frozen ? 'open' : 'hot') : frozen ? 'open' : 'idle';
  return (
    <div class={`tour-scene ${layout.variant}`} style={{ width: `${layout.w}px`, height: `${layout.h}px` }} aria-hidden="true">
      <AppMock layout={layout} cell={frozen ? 'idle' : cell} handle={state.handle.on ? (state.out.on ? 'out' : 'idle') : undefined} />
      <Typing rect={layout.typing} at={state.t} />
      {layout.tip && state.tip.on && !frozen && (
        <div class="tour-tooltip" style={{ ...place(layout.tip), opacity: String(fade(state.tip, 160)) }}>{CELL_TIP}</div>
      )}
      {frozen && <Frozen tour={tour} state={state} cell={cell} />}
      {state.sent.on && <div class="tour-status-note" style={{ ...place(layout.status), ...enter(state.sent, -4) }}>{SENT_LINE}</div>}
      {state.bubble && <AutarkDot rect={{ x: state.bubble.x - 20, y: state.bubble.y - 20, w: 40, h: 40 }} />}
      <Pointer layout={layout} state={state} />
    </div>
  );
}
