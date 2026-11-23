// The composer always sends. Calls are started and controlled above the chat.
// Feedback FCMWNZ0H (20.11.2026, three times: "mit leerem Feld direkt aus der Aufnahme abschicken"): a take that records or
// is being transcribed is content – Send stops it, waits for its words and sends them (voice.ts settleTake).
// Owns: Send availability. Never: starts voice sessions or interrupts agent work.

export function composerControls(input: { hasContent: boolean; dictating: boolean; transcribing: boolean }): { primary: 'send' | 'send-disabled' } {
  return { primary: input.hasContent || input.dictating || input.transcribing ? 'send' : 'send-disabled' };
}
