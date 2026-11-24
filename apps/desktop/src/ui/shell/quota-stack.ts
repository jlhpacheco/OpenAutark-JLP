// The rail's plan badges (QuotaRail.tsx), its plain rules (task_dm3sz5fe, 24.11.2026): the ring's number and the stack's
// hidden edges. Owns: these two. Never: touches the DOM.

/** The number in the ring: the weekly % left, "100" when full (four characters do not fit inside), "–" while unknown. */
export function ringText(weekly: number | undefined): string {
  if (weekly === undefined) return '–';
  return weekly >= 100 ? '100' : `${weekly}%`;
}

/** Which edges of a scrolled stack hide badges: a soft fade marks each (1 px slack for fractional layout). */
export function hiddenEdges(top: number, client: number, scroll: number): { above: boolean; below: boolean } {
  return { above: top > 1, below: top + client < scroll - 1 };
}
