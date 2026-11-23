// The feedback image's paint canvas (B-055 Q4, reworked from the former outline annotation –
// an outline could not hide anything): opaque black pen marks (round, about PEN_PX on screen)
// drawn while the pointer moves and handed on when it lifts. Owner 21.11.2026: the pen is the one
// tool (no boxes).
// Feedback 16.11.2026 (F11, F15 – paint straight on the frozen screen): a transparent layer exactly
// over the image shown at 1:1 (FeedbackOverlay.tsx: the image stays crisp under it), sized in the
// image's export pixels (paint.ts, ≤ 1600 px) and stretched over the same box, so pointer positions
// map exactly onto image pixels and the marks flatten where they were drawn. `disabled` (the
// screenshot does not go): it takes no pointer.
// Owns: drawing one mark. Never: keeps the marks, flattens or uploads (FeedbackOverlay and
// FeedbackPanel do).

import { useLayoutEffect, useRef } from 'preact/hooks';
import { drawMarks, penWidth } from './paint.ts';
import type { PaintMark, Point } from './paint.ts';
import { exportSize } from './paint-image.ts';

export function AnnotationCanvas(props: { image: HTMLImageElement; marks: readonly PaintMark[]; disabled?: boolean; onMark: (mark: PaintMark) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<PaintMark | null>(null);
  const size = exportSize(props.image);

  const redraw = (extra?: PaintMark | null) => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    context.clearRect(0, 0, element.width, element.height);
    drawMarks(context, extra ? [...props.marks, extra] : props.marks);
  };
  useLayoutEffect(() => { redraw(); }, [props.image, props.marks]);

  const point = (event: PointerEvent): Point => {
    const element = canvas.current!;
    const rect = element.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * element.width, ((event.clientY - rect.top) / rect.height) * element.height];
  };

  return (
    <canvas
      ref={canvas}
      class={`paint-canvas${props.disabled ? ' off' : ''}`}
      width={size.width}
      height={size.height}
      aria-label="Image – paint over anything private"
      onPointerDown={(event) => {
        if (event.button !== 0 || props.disabled) return;
        const element = event.currentTarget as HTMLCanvasElement;
        try { element.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
        drawing.current = { tool: 'pen', width: penWidth(element.width, element.getBoundingClientRect().width), points: [point(event)] };
        redraw(drawing.current);
      }}
      onPointerMove={(event) => {
        const mark = drawing.current;
        if (!mark) return;
        mark.points.push(point(event));
        redraw(mark);
      }}
      onPointerUp={() => {
        const mark = drawing.current;
        drawing.current = null;
        if (mark) props.onMark(mark);
        else redraw();
      }}
      onPointerCancel={() => { drawing.current = null; redraw(); }}
    />
  );
}
