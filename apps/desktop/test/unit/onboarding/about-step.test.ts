// The first run's team card became "About you" (OnboardingStep 'about'). An install that stopped on the old
// team card has 'team' stored: it reads as 'about' – the rest of the onboarding section stays (a refused value
// would have reset the whole section to its defaults), and the first run goes on there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_STEPS } from '../../../src/shared/model/system.ts';
import { storedSettings } from '../settings/stored.ts';

const env = { locale: 'en-US', timezone: 'UTC' };

test("a stored 'team' step reads as 'about'; completed and the other sections stay", (t) => {
  const { settings, done } = storedSettings({ onboarding: { completed: true, step: 'team' } }, env);
  t.after(done);
  assert.deepEqual(settings.get().onboarding, { completed: true, step: 'about' });
  for (const step of ['tour', 'ai', 'about', 'done'] as const) assert.ok(ONBOARDING_STEPS.includes(step), step);
  assert.throws(() => settings.update({ onboarding: { step: 'start' as never } }), /onboarding\.step/);
});
