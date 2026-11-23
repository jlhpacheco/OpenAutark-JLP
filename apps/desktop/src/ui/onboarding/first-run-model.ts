// The first-run layer's pure rules (FirstRun.tsx and its cards, tested in test/unit/ui/first-run.test.ts):
// when the layer shows (settings.onboarding.step not 'done', on the owner's window, never in a hidden
// preview), the step order – B-085: the choice card first on a new install (ChoiceCard.tsx: set up a new company or
// connect to my other PC; stored step id 'tour' kept, no "Step n of 2"), then two cards: AI (AiCard.tsx, Back to the
// choice) and About you (AboutCard.tsx) –, whether any model can answer (the AI card's Continue, Home's "No AI" notice),
// the About card's profile write (name, company; its security mode is settings/security-model.ts firstRunSecurity) and
// that "Connect with an ID" (ConnectCard.tsx) ends the layer once the link sets the step 'done' (the runtime does).
// Owns: these pure checks. Never: reads signals, calls the runtime or renders.

import type { Account, AccountState, ModelInfo } from '../../shared/model/providers.ts';
import type { OnboardingStep, Settings } from '../../shared/model/system.ts';
import { isChatModel } from '../lib/model-fit.ts';

/** The cards in order ('done' ends the layer; the choice before them is no numbered card). */
export const CARDS = ['ai', 'about'] as const satisfies readonly OnboardingStep[];
/** The choice card's step (B-085; the id is the former feedback-tour step's, so stored settings need no migration). */
export const TOUR_STEP: OnboardingStep = 'tour';
/** The layer's title: the computer's header row and the phone's top row. */
export const FIRST_RUN_TITLE = 'Set up';


/** The layer shows on this window: settings loaded, step not 'done', the owner's window, not a preview page. */
export function firstRunShown(settings: Pick<Settings, 'onboarding'> | null, owner: boolean, preview: boolean): boolean {
  return Boolean(settings) && owner && !preview && settings!.onboarding.step !== 'done';
}

const indexOf = (step: OnboardingStep) => (CARDS as readonly OnboardingStep[]).indexOf(step);

/** The card after `step` ('done' after the last). */
export function nextStep(step: OnboardingStep): OnboardingStep {
  if (step === TOUR_STEP) return CARDS[0];
  const index = indexOf(step);
  return index < 0 || index >= CARDS.length - 1 ? 'done' : CARDS[index + 1];
}

/** The step before `step`: the first card goes back to the choice, the choice stays. */
export function previousStep(step: OnboardingStep): OnboardingStep {
  const index = indexOf(step);
  return index <= 0 ? TOUR_STEP : CARDS[index - 1];
}

/** "Step 2 of 2" ('' for the choice, which is no numbered card). */
export function stepText(step: OnboardingStep): string {
  if (step === TOUR_STEP) return '';
  return `Step ${Math.max(0, indexOf(step)) + 1} of ${CARDS.length}`;
}

/** Account states that may still serve a model (cooling ends, unknown is not checked yet). */
const SERVING: ReadonlySet<AccountState> = new Set(['ok', 'cooling', 'unknown']);

/**
 * True when no model can answer: the model list has no available chat model – or, while the list
 * is empty (not loaded yet, or nothing connected), no enabled model account can serve one.
 */
export function noUsableModel(models: readonly ModelInfo[], accounts: readonly Account[]): boolean {
  if (models.length) return !models.some((model) => model.available && isChatModel(model));
  return !accounts.some((account) => account.enabled && SERVING.has(account.state));
}

/** The About card's profile write: trimmed name and company, only what changed. */
export function profilePatch(current: Pick<Settings['profile'], 'name' | 'company'> | undefined, name: string, company: string): Partial<Settings['profile']> | undefined {
  const next = { name: name.trim().slice(0, 120), company: company.trim().slice(0, 200) };
  const patch: Partial<Settings['profile']> = {};
  if (next.name !== (current?.name ?? '')) patch.name = next.name;
  if (next.company !== (current?.company ?? '')) patch.company = next.company;
  return Object.keys(patch).length ? patch : undefined;
}

/**
 * 17.11.2026: the About card's "share in the public library" tick (settings.library.publish; absent = on). Only what
 * changed is written: left ticked on a new PC nothing is, unticked it is `publish: false`.
 */
export function libraryPatch(current: Settings['library'] | undefined, share: boolean): { publish: boolean } | undefined {
  return share === (current?.publish !== false) ? undefined : { publish: share };
}
