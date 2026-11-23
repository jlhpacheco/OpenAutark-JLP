// Where the floating to-do button (float-bar.ts) sits in each look: the sizes of the dot, the panel, the call pill and the
// edge tab, and the pure placement rules – everything stays inside the display's work area, the panel and the pill open
// from the dot towards the middle of the screen, the tab glues to the nearest side edge.
// Owns: the looks' sizes and the placement math. Never: state, windows or electron.

export const DOT = 44;
export const TAB_W = 12;
export const TAB_H = 40;
export const PANEL_W = 336;
export const PANEL_H = 128;
export const CALL_W = 200;

export type FloatLook = 'dot' | 'panel' | 'tab' | 'call';
export interface Rect { x: number; y: number; width: number; height: number }

/** The window's size in each look (DIP). */
export function sizeOf(look: FloatLook): { width: number; height: number } {
  if (look === 'panel') return { width: PANEL_W, height: PANEL_H };
  if (look === 'call') return { width: CALL_W, height: DOT };
  return look === 'tab' ? { width: TAB_W, height: TAB_H } : { width: DOT, height: DOT };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** `rect` moved fully into `area`. */
export function inside(rect: Rect, area: Rect): Rect {
  return { ...rect, x: clamp(rect.x, area.x, area.x + area.width - rect.width), y: clamp(rect.y, area.y, area.y + area.height - rect.height) };
}

/** The tab glued to the edge nearest the dot, at the dot's height (or width on top/bottom it stays a side tab). */
export function tabAt(dot: Rect, area: Rect): Rect {
  const left = dot.x + dot.width / 2 - area.x < area.x + area.width - (dot.x + dot.width / 2);
  const x = left ? area.x : area.x + area.width - TAB_W;
  return inside({ x, y: dot.y + (dot.height - TAB_H) / 2, width: TAB_W, height: TAB_H }, area);
}

/** The dot coming back from the tab: beside it, inside the work area. */
export function dotFromTab(tab: Rect, area: Rect): Rect {
  const left = tab.x <= area.x + area.width / 2;
  return inside({ x: left ? area.x + 8 : area.x + area.width - DOT - 8, y: tab.y + (TAB_H - DOT) / 2, width: DOT, height: DOT }, area);
}

/** The panel (or the call pill: `look`) opens from the dot towards the middle of the screen, fully inside the work area. */
export function panelAt(dot: Rect, area: Rect, look: 'panel' | 'call' = 'panel'): Rect {
  const { width, height } = sizeOf(look);
  const right = dot.x + dot.width / 2 > area.x + area.width / 2;
  const below = dot.y + dot.height / 2 > area.y + area.height / 2;
  return inside({ x: right ? dot.x + dot.width - width : dot.x, y: below ? dot.y + dot.height - height : dot.y, width, height }, area);
}

/** The dot of a panel that was dragged: the panel's corner the dot opened it from. */
export function dotOfPanel(panel: Rect, area: Rect): Rect {
  const right = panel.x + panel.width / 2 > area.x + area.width / 2;
  const below = panel.y + panel.height / 2 > area.y + area.height / 2;
  return { x: right ? panel.x + panel.width - DOT : panel.x, y: below ? panel.y + panel.height - DOT : panel.y, width: DOT, height: DOT };
}
