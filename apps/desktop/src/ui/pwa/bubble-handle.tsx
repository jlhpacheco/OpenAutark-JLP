// Owner 19.11.2026: "the way back" to the Android app's to-do bubble – a round icon that looks like the bubble itself (the
// dark round dot with the white Autark mark, phoneuse/TodoButton.java) in the lead cell of the phone's top row, left of
// the section title (lib/header.tsx places it where a phone row has no Back). Grabbed and pulled a little away
// (bubble-pull.ts) the bubble comes out under the finger and follows it until the finger lifts; a press without a drag
// (a keyboard, a screen reader) brings it out at its last place. While the bubble is out the icon is faint and pulls
// nothing (one bubble). It shows only where the app said it has phone use ({t:'bubble.state'}, native-port.ts) – never
// in a browser, the iPhone web app or a build without phone use.
// Owns: the icon, its gesture's wiring to the port and the state signal. Never: the bubble (the app) or the header's grid.

import { signal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import type { HeaderCell } from '../lib/header-model.ts';
import { onNative, sendNative } from './native-port.ts';
import { bubbleStateOf, startPull, type BubbleState } from './bubble-pull.ts';

/** What the app said last: whether it has phone use and whether the bubble is out. */
export const bubbleState = signal<BubbleState>({ available: false, out: false });

if (typeof window !== 'undefined') onNative('bubble.state', (msg) => { bubbleState.value = bubbleStateOf(msg); });

/** The phone row's lead while the app has phone use and the row has no Back; else undefined (reads the signal). */
export function bubbleLead(): HeaderCell | undefined {
  return bubbleState.value.available ? LEAD : undefined;
}

const LEAD: HeaderCell = { id: 'bubble', slot: <BubbleHandle /> };
/** The bubble's own look (TodoButton: its background at its see-through alpha). */
const DOT = 'rgba(32, 36, 34, 0.68)';

function BubbleHandle() {
  const { out } = bubbleState.value;
  const pull = useRef<ReturnType<typeof startPull> | null>(null);
  const dragged = useRef(false);
  const step = (event: PointerEvent, kind: 'move' | 'up' | 'cancel') => {
    const gesture = pull.current;
    if (!gesture) return;
    const next = kind === 'move' ? gesture.move(event.clientX, event.clientY) : kind === 'up' ? gesture.up(event.clientX, event.clientY) : gesture.cancel(); // a cancel's own place may not be the finger's
    if (next) sendNative(next);
    if (kind !== 'move') { dragged.current = gesture.pulled; pull.current = null; }
  };
  return (
    <button
      type="button" class="bubble-handle" aria-label={out ? 'Your bubble is out' : 'Pull your bubble out'} aria-disabled={out || undefined}
      title={out ? 'Your bubble is out' : 'Pull out your bubble'}
      style={{
        width: '30px', height: '30px', margin: '3px', padding: 0, border: 0, borderRadius: '50%', background: DOT,
        display: 'grid', placeItems: 'center', touchAction: 'none', opacity: out ? 0.35 : 1, cursor: out ? 'default' : 'grab',
      }}
      onPointerDown={(event) => {
        if (out) return;
        dragged.current = false;
        pull.current = startPull(event.clientX, event.clientY);
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => step(event, 'move')}
      onPointerUp={(event) => step(event, 'up')}
      onPointerCancel={(event) => step(event, 'cancel')}
      onClick={() => { if (!out && !dragged.current) sendNative({ t: 'bubble.pull' }); dragged.current = false; }}
    >
      <svg width="15" height="15" viewBox="0 0 512 512" aria-hidden="true">
        <path fill="#fff" d="M216,43 L296,43 L480,468 L396,468 L256,138 L116,468 L32,468 Z" />
        <path fill="#fff" d="M208,351 a48,48 0 1,0 96,0 a48,48 0 1,0 -96,0 Z" />
      </svg>
    </button>
  );
}
