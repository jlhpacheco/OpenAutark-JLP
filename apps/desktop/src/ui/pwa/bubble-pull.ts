// Owner 19.11.2026 (the way back to the Android to-do bubble): the round icon left of the title in the phone's top row
// (bubble-handle.tsx) is grabbed and pulled a little away – then the bubble comes out under the finger and follows it.
// This is that gesture as plain steps: a finger that moves less than PULL_SLOP is still a press; beyond it the pull
// starts ({t:'bubble.pull', x, y}), every further move follows ({t:'bubble.move'}) and the finger's lift drops it there
// ({t:'bubble.drop'}); a cancelled gesture drops it where the last move put it. A lift before the slop sends nothing (the handle's click is the press without a drag). The app's
// {t:'bubble.state', available, out} is read here too: available – the app has phone use (the icon shows); out – the
// bubble is on the screen (no second pull).
// Owns: the gesture's steps and reading the state message. Never: the DOM, the port or the bubble itself (the app).

/** CSS px a finger moves before a press becomes the pull. */
export const PULL_SLOP = 8;

export type PullStep = { t: 'bubble.pull' | 'bubble.move' | 'bubble.drop'; x: number; y: number };

export interface BubbleState { available: boolean; out: boolean }

/** The app's state message as the icon reads it (anything unexpected: no icon). */
export function bubbleStateOf(msg: Record<string, unknown>): BubbleState {
  return { available: msg.available === true, out: msg.out === true };
}

/** One finger on the icon from (x, y): what each move and the lift send to the app. */
export function startPull(x: number, y: number): { move(x: number, y: number): PullStep | null; up(x: number, y: number): PullStep | null; cancel(): PullStep | null; readonly pulled: boolean } {
  let pulled = false;
  let last = { x, y };
  return {
    get pulled() { return pulled; },
    move(nx, ny) {
      last = { x: nx, y: ny };
      if (pulled) return { t: 'bubble.move', x: nx, y: ny };
      if (Math.hypot(nx - x, ny - y) <= PULL_SLOP) return null;
      pulled = true;
      return { t: 'bubble.pull', x: nx, y: ny };
    },
    up(nx, ny) { return pulled ? { t: 'bubble.drop', x: nx, y: ny } : null; },
    cancel() { return pulled ? { t: 'bubble.drop', ...last } : null; },
  };
}
