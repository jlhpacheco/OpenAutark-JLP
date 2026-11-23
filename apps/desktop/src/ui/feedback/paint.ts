// B-055 Q4 "Paint over": what covers private parts of a feedback image and how a report's images
// are made. Marks are opaque black – a round pen (about PEN_PX on screen, whatever the image's
// size) – so nothing under them can be read. Owner 21.11.2026: the person only paints – the box
// tool is gone (covering rectangles are the agent's, runtime side).
// Every report image is one flattened JPEG (EXPORT_QUALITY, longest side ≤ EXPORT_MAX_SIDE): a
// painted image is sent ONLY flattened (never the raw image beside it), an unpainted one as the
// original re-encoded the same way.
// Owns: the mark model, drawing marks on a 2D context and the export's size and format. Never: touches the DOM,
// decodes images or uploads (paint-image.ts, FeedbackOverlay.tsx and FeedbackPanel.tsx do).

export type Point = [number, number];
/** In the export image's pixels. A pen line keeps the width it was drawn with. */
export interface PaintMark { tool: 'pen'; width: number; points: Point[] }

/** The pen's width on screen in CSS px (converted to image px when a line starts). */
export const PEN_PX = 22;
/** Opaque black: the marks hide what lies under them. */
export const PAINT_COLOR = '#000000';
export const EXPORT_MAX_SIDE = 1600;
export const EXPORT_QUALITY = 0.85;
export const EXPORT_MIME = 'image/jpeg';
export const REPORT_IMAGE_NAME = 'screenshot.jpg';

/** The part of CanvasRenderingContext2D the marks use (a fake records the calls in tests). */
export interface PaintContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
}

/** The pen's width in image px for a canvas `imageWidth` px wide shown `shownWidth` CSS px wide. */
export function penWidth(imageWidth: number, shownWidth: number): number {
  return Math.max(2, (PEN_PX * imageWidth) / Math.max(1, shownWidth));
}

/** Draws `marks` in order (the image must already be on the context). */
export function drawMarks(context: PaintContext, marks: readonly PaintMark[]): void {
  context.fillStyle = PAINT_COLOR;
  context.strokeStyle = PAINT_COLOR;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const mark of marks) {
    const [first, ...rest] = mark.points;
    if (!first) continue;
    context.beginPath();
    if (!rest.length) { // a single tap leaves a round dot
      context.arc(first[0], first[1], mark.width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.lineWidth = mark.width;
    context.moveTo(first[0], first[1]);
    for (const [x, y] of rest) context.lineTo(x, y);
    context.stroke();
  }
}
