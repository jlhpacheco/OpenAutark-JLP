// The feedback tour's variant (ui/tour/open.ts tourVariant, F15): the layout's when an opening first shows, kept while it
// plays – a window made narrow or wide meanwhile mounts the shell's overlays afresh (shell/Shell.tsx) – and asked anew
// at the next opening.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTour, openTour, tourOpen, tourVariant } from '../../../src/ui/tour/open.ts';

test('an opening keeps the variant it first showed in; the next opening asks the layout again', () => {
  openTour();
  assert.equal(tourVariant(false), 'desktop', 'opened in the computer layout');
  assert.equal(tourVariant(true), 'desktop', 'the window went narrow while it plays: still the computer\'s tour');
  closeTour();
  assert.equal(tourOpen.value, false);
  openTour();
  assert.equal(tourVariant(true), 'phone', 'opened again in the phone layout');
  assert.equal(tourVariant(false), 'phone');
  closeTour();
});
