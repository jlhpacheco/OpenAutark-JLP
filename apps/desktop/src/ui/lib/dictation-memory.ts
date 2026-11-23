// What a page remembers about how its dictation pieces are heard (lib/dictation.ts, moved out of it for size 21.11.2026):
// whether the PC's ChatGPT plan heard its last piece ('1') or not ('0') – the next pieces then go as Ogg Opus –, and
// until when pieces go as WAV because the plan missed a compact one. localStorage across reloads; where storage is
// blocked, this page's memory.
// Owns: these two values and their keys. Never: audio, or deciding the format (dictation.ts does).

const PLAN_HEARD_KEY = 'wf.dictationPlanHeard';
const COMPACT_REFUSED_KEY = 'wf.dictationCompactRefused';

/** Whether the plan heard this page's last piece. */
export const planHeardMemory = {
  get: (): boolean => { try { return localStorage.getItem(PLAN_HEARD_KEY) === '1'; } catch { return false; } },
  set: (heard: boolean): void => { try { localStorage.setItem(PLAN_HEARD_KEY, heard ? '1' : '0'); } catch { /* storage blocked: this page's memory */ } },
};

let refusedUntil = 0; // storage blocked: this page's memory

/** Until when (ms) this page's pieces go as WAV. */
export const compactRefusedMemory = {
  get: (): number => { try { return Number(localStorage.getItem(COMPACT_REFUSED_KEY)) || refusedUntil; } catch { return refusedUntil; } },
  set: (at: number): void => { refusedUntil = at; try { localStorage.setItem(COMPACT_REFUSED_KEY, String(at)); } catch { /* memory only */ } },
};
