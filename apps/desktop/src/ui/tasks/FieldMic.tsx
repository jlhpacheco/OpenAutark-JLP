// The mic cell of the Tasks page's input line in its one small slot, the way the chat composer's
// MicButton does it: Dictate → starting (a spinner until the microphone is open) → Stop → transcribing (a spinner). The
// cell shows the state; cancelling is the line's + turned × (LineExtras.tsx LinePlus, chat/composer/PlusCancel.tsx –
// owner's feedback FCMWNSOZ 20.11.2026). Nothing is rendered where dictation gives no text here.
// Owns: that cell. Never: dictation itself (use-dictation.ts over chat/composer/voice.ts).

import { IconButton, Spinner } from '../lib/ui.tsx';
import type { FieldDictation } from './use-dictation.ts';

export function FieldMic(props: { mic: FieldDictation; disabled?: boolean }) {
  const { mic } = props;
  const busy = mic.transcribing ? 'Transcribing dictation' : mic.starting ? 'Starting dictation' : '';
  if (busy) return <button type="button" class="icon-button small dictation-busy" aria-label={busy} title={busy} disabled><Spinner size={14} label={busy} /></button>;
  if (!mic.available && !mic.active) return null;
  return (
    <IconButton icon={mic.active ? 'stop' : 'microphone'} size="small" label={mic.active ? 'Stop dictation' : 'Dictate'} pressed={mic.active}
      disabled={props.disabled} onClick={() => void mic.toggle()} />
  );
}
