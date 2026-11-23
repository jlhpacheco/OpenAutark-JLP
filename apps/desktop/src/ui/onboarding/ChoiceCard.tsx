// B-085: the first run's first card (step 'tour', FirstRun.tsx), in place of the feedback video: "Set up a new company"
// (→ the AI card) or, where this window can connect, "Connect with an ID" (→ the Connect card; Eine-ID 22.11.2026: the ID typed decides – a company's ID joins it as a new member, a person's ID adds this PC to their devices).
// A quiet "Watch how it works" opens the feedback video in its dialog (ui/tour/open.ts – the shell mounts it); B-090
// (owner 13.11.2026): "Set up a new company" plays it at once over the AI card, so everyone sees it. No
// "Step n of 2" here; the card has the cards' one frame (parts.tsx), so nothing jumps between the steps.
// Owns: this card's two choices and the video link. Never: the step rules (first-run-model.ts), the Connect card or the tour.

import { useState } from 'preact/hooks';
import { toastError } from '../lib/toasts.ts';
import { openTour } from '../tour/open.ts';
import { nextStep, TOUR_STEP } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { Card } from './parts.tsx';

function Choice(props: { title: string; text: string; primary?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class={`first-run-choice${props.primary ? ' primary' : ''}`} disabled={props.disabled} onClick={props.onClick}>
      <span class="first-run-choice-title">{props.title}</span>
      <span class="first-run-choice-text">{props.text}</span>
    </button>
  );
}

/** `onConnect`: opens the Connect card; absent where this window cannot connect (the row is not drawn). */
export function ChoiceCard(props: { onConnect?: () => void }) {
  const [busy, setBusy] = useState(false);
  const setUp = () => {
    setBusy(true);
    openTour({ autoplay: true });
    goStep(nextStep(TOUR_STEP)).catch((error) => toastError(error, 'Could not continue')).finally(() => setBusy(false));
  };
  return (
    <Card id="first-run-choice" title="Welcome" busy={busy} actions={
      <button type="button" class="first-run-link" onClick={() => openTour()}>Watch how it works</button>
    }>
      <div class="first-run-choices">
        <Choice primary title="Set up a new company" text="Connect an AI, say who you are – your Manager takes it from there." disabled={busy} onClick={setUp} />
        {props.onConnect && <Choice title="Connect with an ID" text="Join a company with its ID, or add this PC to your devices with your own ID." disabled={busy} onClick={props.onConnect} />}
      </div>
    </Card>
  );
}
