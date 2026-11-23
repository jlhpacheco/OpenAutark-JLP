// The feedback form's attachment row beside the screenshot box (the snapshot overlay shows the screenshot full size,
// its box is FeedbackOverlay.tsx's): "Crash report attached" – an Android crash report the app handed over (draft.ts
// attachCrashReport), checked by default; one fixed line, so it arriving moves nothing. Owner 20.11.2026: a report is
// its words – there is no recording row; a dictation goes into the text.
// Owns: this row. Never: uploads or sends anything.

import { CRASH_LABEL } from './delivery.ts';
import { updateDraft } from './draft.ts';
import type { FeedbackDraft } from './draft.ts';

export function CrashRow(props: { draft: FeedbackDraft; disabled: boolean }) {
  const { draft } = props;
  if (!draft.diagnostics) return null;
  return (
    <label class="feedback-check feedback-crash" title={draft.diagnostics.slice(0, 600)}>
      <input type="checkbox" checked={draft.withDiagnostics} disabled={props.disabled}
        onChange={(event) => updateDraft({ withDiagnostics: (event.currentTarget as HTMLInputElement).checked })} />
      {CRASH_LABEL}
    </label>
  );
}
