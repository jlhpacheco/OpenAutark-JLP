// The chat header's live line ("Mira: cutting intro, Ava: running a command"; in a narrow sub line one
// agent's line or the names, "Mira, Ava"; on a phone "Mira is working" – live-text.ts), in the header's
// reserved sub line beside the call line (ChatHeader.tsx).
// 21.10. 17:09: the chat had no Stop button – superseded 16.11.2026 (feedback F20/F21, owner): one agent's own
// Stop (chat/StopRun.tsx) sits at its line in the live bar above the composer (LiveBar.tsx); this header line has
// none, so one run has one Stop in view. A message (marked Important) still redirects running work.
// 20.11.2026: the line is a button for everyone who sees it – a click opens (or closes) the lines of the live bar
// (their steps, "Watch live", task); the bar is the one place for who works. "Stop all agent work" stays in the
// command palette (the search cell on a phone), the tray and its shortcut (shell/work-stop.ts).
// Owns: the line's markup. Never: stops an agent itself (its Stop is in the live bar).

export function LiveLine(props: { text: string; short?: string; names?: string; open: boolean; onToggle: () => void }) {
  // data-short / data-names: a narrow and a phone's sub line show the shorter forms (chat.css, live-text.ts);
  // the full line stays the text and the title
  const text = <span class="chat-live-text">{props.text}</span>;
  const forms = { 'data-short': props.short ?? props.text, 'data-names': props.names ?? props.short ?? props.text };
  return (
    <button type="button" class="chat-live tabular" aria-live="polite" aria-expanded={props.open}
      title={props.text} {...forms} onClick={props.onToggle}>
      {text}
    </button>
  );
}
