// B-085 T2: the spotlight tour's steps and its pure rules (Spotlight.tsx draws them). Six short steps over the
// Manager's chat right after the first run's Start – only what people would not find themselves; each names an
// existing selector of OUR markup (no data-tour attribute anywhere) and, where a class is shared, the text the
// target carries. A step whose target is not on screen is left out, so "Security settings" shows only while the
// status line offers it (the Secure-mode notice, ui/onboarding/ai-notice.ts). The bubble sits below the
// target, else above it, else (no room, or a window under 560 px) as a sheet – at the top when the hole lies in the
// bottom part (the composer's steps on a phone). A target gone by its turn is passed over in the direction the person
// was going (passOver).
// Owns: the step list, the hole and bubble geometry, passing over, the keys. Never: reads the DOM, stores or settings.

export interface SpotlightStep {
  /** CSS selector of the target; the first visible match that is no inert placeholder counts. */
  selector: string;
  /** Text the target must contain (a class several notices share). */
  text?: string;
  title: string;
  body: string;
}

export const SPOTLIGHT_STEPS: readonly SpotlightStep[] = [
  { selector: '.frame-header [data-cell="call"]', title: 'Talk', body: 'Talk with your agent by voice. It can also ring you when something needs you.' },
  { selector: '[data-cell="workspace"]', title: 'Side pane', body: 'A real browser, notes and files in tabs. Your agents work in the same tabs.' },
  { selector: '.composer .composer-plus', title: 'Add', body: 'Add files, hand over a secret, or make your message a task.' },
  { selector: '.composer .send-button', title: 'Send options', body: 'Right-click Send (or press and hold) to send it as important, silently or at a set time.' },
  { selector: '.status-note .status-action', text: 'Security settings', title: 'Secure mode', body: 'Your team works freely in its own folders, and the app asks you before anything else. Choose what is open in Settings › Security.' },
];

export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Placement = { kind: 'below' | 'above'; left: number; top: number } | { kind: 'sheet'; top: boolean };

/** Below this window width the bubble is a sheet. */
export const SHEET_BELOW = 560;
const GAP = 12;
const EDGE = 16;
const PAD = 6;

/** Whether a candidate counts as the step's target: visible, not an inert placeholder, carrying the step's text. */
export function isTarget(step: Pick<SpotlightStep, 'text'>, candidate: { width: number; height: number; placeholder: boolean; text: string }): boolean {
  return candidate.width > 0 && candidate.height > 0 && !candidate.placeholder && (!step.text || candidate.text.includes(step.text));
}

/** Where the tour goes from a step whose target is gone: on in the direction of the last move (1 forwards, -1 back);
 * back from the first step turns forwards. null = past the last step, the tour ends. */
export function passOver(index: number, count: number, direction: 1 | -1): number | null {
  const to = direction === -1 && index > 0 ? index - 1 : index + 1;
  return to < count ? to : null;
}

export function sameBox(a: Box | null, b: Box): boolean {
  return !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** The hole around the target: a few pixels of room, kept inside the window. */
export function holeOf(target: Box, viewport: Size): Box {
  const left = Math.max(0, target.left - PAD);
  const top = Math.max(0, target.top - PAD);
  const right = Math.min(viewport.width, target.left + target.width + PAD);
  const bottom = Math.min(viewport.height, target.top + target.height + PAD);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Where the bubble goes: below the hole, else above it, else a sheet (also in a narrow window) – at the top when a
 * bottom sheet would cover the hole. */
export function placeBubble(hole: Box, bubble: Size, viewport: Size): Placement {
  const sheet = { kind: 'sheet', top: hole.top + hole.height > viewport.height - bubble.height - GAP } as const;
  if (viewport.width < SHEET_BELOW || bubble.width + 2 * EDGE > viewport.width) return sheet;
  const left = Math.min(Math.max(EDGE, hole.left + hole.width / 2 - bubble.width / 2), viewport.width - bubble.width - EDGE);
  const below = hole.top + hole.height + GAP;
  if (below + bubble.height + EDGE <= viewport.height) return { kind: 'below', left, top: below };
  const above = hole.top - GAP - bubble.height;
  if (above >= EDGE) return { kind: 'above', left, top: above };
  return sheet;
}

/** What a key does: Enter and → go on (Enter on a focused button presses that button), ← goes back. Esc is the dialog's cancel. */
export function keyStep(key: string, onButton: boolean): 'next' | 'back' | null {
  if (key === 'ArrowRight' || (key === 'Enter' && !onButton)) return 'next';
  if (key === 'ArrowLeft') return 'back';
  return null;
}
