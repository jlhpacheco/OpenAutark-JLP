// Dictation into the Tasks page's input line through the app's one microphone path (chat/composer/voice.ts over
// lib/dictation.ts – the same path the chat composer uses). Offered only where it gives text (lib/dictation.ts dictationNote is empty); the words are
// appended to the field. B-082: a take (or a piece of it) that was not heard is kept – the field cannot hold a
// chip, so a lasting toast offers "Transcribe again", whose words are appended, too – an Add while they are heard waits for them (chat/composer/field-words.ts).
// A field that goes away mid-dictation or mid-transcription cancels it (the field's text goes with it). While a take
// starts, records or is transcribed, `cancel` is the line's + turned × (LineExtras.tsx LinePlus). Adding while a take
// records or is transcribed takes its words with it (settle – feedback FCMWNZ0H 20.11.2026, the composer's Send alike).
// Owns: the hook. Never: picks the dictation path or touches the microphone itself.

import { useEffect } from 'preact/hooks';
import { dictationNote } from '../lib/dictation.ts';
import { cancelDictation, cancelTranscribing, dictating, dictationStarting, offerRetry, startDictation, stopDictation, takeCancel, transcribing } from '../chat/composer/voice.ts';
import { fieldTake, takeFieldWords } from '../chat/composer/field-words.ts';
import type { TakeCancel } from '../chat/composer/voice.ts';

export interface FieldDictation {
  /** Dictation can give text here. */
  available: boolean;
  /** This field is dictating. */
  active: boolean;
  /** The microphone is opening for this field. */
  starting: boolean;
  /** Its take is being transcribed. */
  transcribing: boolean;
  /** Starts, or stops and appends what was said. */
  toggle: () => Promise<void>;
  /** Stops a running take or waits for the one being transcribed: its words ('' when none) – then they are the caller's. */
  settle: () => Promise<string>;
  /** While a take starts, records or is transcribed: the field's × (discards it, or drops its late words – the field keeps what it has). */
  cancel: TakeCancel | undefined;
}

export function useFieldDictation(key: string, append: (said: string) => void): FieldDictation {
  const active = dictating.value === key;
  useEffect(() => () => {
    if (dictating.peek() === key) void cancelDictation();
    if (transcribing.peek().has(key)) cancelTranscribing(key); // its words would have no field to go to
  }, [key]);
  const stop = async (): Promise<string> => {
    if (dictating.peek() !== key) return '';
    const outcome = await stopDictation({ attach: false }); // a field cannot hold a recording
    for (const kept of outcome.kept ?? []) offerRetry(kept, append, outcome.error, key);
    return outcome.text ?? '';
  };
  return {
    available: !dictationNote(),
    active,
    starting: dictationStarting.value === key,
    transcribing: transcribing.value.has(key),
    toggle: async () => {
      if (dictating.peek() !== key) { await startDictation(key, undefined, { attach: false }); return; }
      await fieldTake(key, stop(), append);
    },
    settle: () => (dictating.peek() === key ? stop() : takeFieldWords(key)), // a Stop's take or a toast's retry still on its way
    cancel: takeCancel(key),
  };
}
