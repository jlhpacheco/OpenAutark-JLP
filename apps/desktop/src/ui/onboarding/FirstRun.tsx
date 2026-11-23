// The first-run layer: while settings.onboarding.step is not 'done' it is the main zone's content in
// the Tasks page's place (shell/views.ts asks first-run.ts firstRunActive) – no route or window of its own, the
// frame, the sidebar and the header row stay where they are. B-085: a new install starts with the choice card
// (ChoiceCard.tsx, step 'tour', no "Step n of 2"): "Set up a new company" leads to the cards – AI (AiCard.tsx), then
// About you (AboutCard.tsx), one at a time in a fixed column; About you ends the layer (onboarding.start opens the
// Manager's chat with the app's start text as the person's line). On the computer "Connect to my other PC" opens the
// Connect card (ConnectCard.tsx) in the same column; its Back returns to the choice. The feedback video is no step any
// more (the choice card's "Watch how it works", Settings › Feedback, the palette). B-078: a company started from the
// company menu's "+ › Connect with an ID" (companies.list current entry's `start` 'join') opens that card at once –
// Eine-ID 22.11.2026: one card, no role; the ID typed decides. The phone stack draws its own top row (shell/views.ts
// tabTitle), so the layer draws its header row on the desktop only.
// Owns: the layer's frame and the card switch. Never: a card's choices (the cards), the step rules
// (first-run-model.ts) or the tour itself (ui/tour).

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Header } from '../lib/header.tsx';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { isMobile, settings } from '../lib/store.ts';
import { FIRST_RUN_TITLE, TOUR_STEP, stepText } from './first-run-model.ts';
import { AboutCard } from './AboutCard.tsx';
import { AiCard } from './AiCard.tsx';
import { ChoiceCard } from './ChoiceCard.tsx';
import { ConnectCard } from './ConnectCard.tsx';

/** The Connect card is open over the choice (outlives a remount across the phone layout). */
const connecting = signal(false);
/** B-078: the start this company was asked for (company menu "+", `--start=`) opens the card once. */
let presetRead = false;

function readPreset(): void {
  if (presetRead || platform !== 'desktop' || !can('companies.list')) return;
  presetRead = true;
  rpc.call('companies.list').then(({ companies }) => {
    const start = companies.find((company) => company.current)?.start;
    if (start === 'join' && (settings.value?.onboarding.step ?? TOUR_STEP) === TOUR_STEP) connecting.value = true;
  }, () => undefined);
}

export function FirstRun() {
  const step = settings.value?.onboarding.step ?? 'ai';
  useEffect(readPreset, []);
  const connect = platform === 'desktop' && can('remote.connect') ? () => { connecting.value = true; } : undefined;
  const card = step === TOUR_STEP
    ? (connect && connecting.value ? <ConnectCard key="connect" onClose={() => { connecting.value = false; }} /> : <ChoiceCard key="choice" onConnect={connect} />)
    : step === 'ai' ? <AiCard key="ai" /> : <AboutCard key="about" />;
  return (
    <div class="first-run-view">
      {!isMobile.value && <Header zone="main" class="first-run-header" title={FIRST_RUN_TITLE} />}
      <div class="first-run-scroll">
        <div class="first-run-column">
          <p class="first-run-step" aria-live="polite">{stepText(step)}</p>
          {card}
        </div>
      </div>
    </div>
  );
}
