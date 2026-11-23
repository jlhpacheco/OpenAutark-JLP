// The Tasks page's fields (no chips, tasks/use-dictation.ts): per field key, the words on their way – a Stop's take or a toast's
// "Transcribe again" (voice.ts offerRetry). They go to the field when they come, unless an Add took them first (review
// of feedback FCMWNZ0H, 20.11.2026: Add while the words are heard waits for them, and the field does not get them twice).
// Owns: that hand-over. Never: hears anything itself (voice.ts).

const fieldWords = new Map<string, { words: Promise<string>; taken: boolean }>();

/** The field `key` waits for `words`: they go to `onText` when they come, unless an Add took them first (takeFieldWords). */
export async function fieldTake(key: string, words: Promise<string>, onText: (text: string) => void): Promise<void> {
  const take = { words, taken: false };
  fieldWords.set(key, take);
  const said = await words;
  if (fieldWords.get(key) === take) fieldWords.delete(key);
  if (said && !take.taken) onText(said);
}

/** An Add in field `key`: the words still on their way ('' when none) – from now on the Add's, not the field's. */
export function takeFieldWords(key: string): Promise<string> {
  const take = fieldWords.get(key);
  if (!take) return Promise.resolve('');
  take.taken = true;
  return take.words;
}
