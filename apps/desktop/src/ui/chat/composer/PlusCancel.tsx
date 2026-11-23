// The + that turns into × (owner, feedback FCMWNSOZ 20.11.2026: "dreht es sich 45 Grad in einer Bewegung und wird zum
// X-Symbol und damit kann man abbrechen … Es ist überall so"): one button whose plus turns 45° while a take records or
// is being transcribed – then a click cancels it (the recording is thrown away, the transcription's late words go
// nowhere) – and otherwise does its cell's own job (the composer's Add menu, the Tasks page field's focus). It stays the same
// element in both states, so the turn is one CSS transition (composer.css .plus-cancel; none with reduced motion) and
// nothing beside it moves. Any dictation can use it: `cancel` is what the × does right now (voice.ts takeCancel for
// the composers' takes; the feedback panel passes its own).
// Owns: that button. Never: dictation itself (voice.ts) or the cell's menu.

import type { Ref } from 'preact';
import { Icon } from '../../lib/ui.tsx';
import type { TakeCancel } from './voice.ts';

export interface PlusCancelProps {
  /** While set the plus is an × and a click runs it. */
  cancel?: TakeCancel;
  /** The plus's own label and click. */
  label: string;
  onClick?: () => void;
  /** Without a take the plus is only a mark beside a field (the Tasks page): no tab stop, not read out; a click still runs onClick. */
  mark?: boolean;
  /** The plus's menu state (Add menus). */
  expanded?: boolean;
  iconSize?: number;
  disabled?: boolean;
  class?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

export function PlusCancel(props: PlusCancelProps) {
  const { cancel } = props;
  const quiet = !cancel && props.mark === true;
  return (
    <button ref={props.buttonRef} type="button" disabled={props.disabled} class={`icon-button plus-cancel${cancel ? ' is-cancel' : ''}${props.class ? ` ${props.class}` : ''}`}
      aria-label={cancel ? cancel.label : props.label} title={cancel ? cancel.label : props.label}
      aria-haspopup={!cancel && props.expanded !== undefined ? 'menu' : undefined}
      aria-expanded={!cancel && props.expanded !== undefined ? props.expanded : undefined}
      aria-hidden={quiet ? true : undefined} tabIndex={quiet ? -1 : undefined}
      onMouseDown={(event) => event.preventDefault()} // a field keeps its focus and caret
      onClick={() => (cancel ? cancel.run() : props.onClick?.())}>
      <Icon name="plus" size={props.iconSize ?? 20} />
    </button>
  );
}
