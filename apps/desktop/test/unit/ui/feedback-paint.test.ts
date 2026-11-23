// B-055 Q4 "Paint over" (ui/feedback/paint.ts) and the feedback draft (draft.ts): marks are opaque
// black (a round pen about 22 px on screen whatever the image's size – owner 21.11.2026: the pen is the person's one
// tool, no boxes); every report image is one JPEG (starting at 0.85) within 1600 px, all of them sharing the image
// budget; dictated words join the draft's text with one space. The draft's photos: added up to the image cap, shown on
// the stage by a click, painted and undone each on its own, removed by ×; at Send the shot first, then the photos.
// Owns: these assertions only. Never: a canvas, a DOM or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  drawMarks, EXPORT_MAX_SIDE, EXPORT_MIME, EXPORT_QUALITY, PAINT_COLOR, PEN_PX, penWidth, REPORT_IMAGE_NAME,
} from '../../../src/ui/feedback/paint.ts';
import type { PaintContext, PaintMark } from '../../../src/ui/feedback/paint.ts';
import { fitWithin, screenshotName } from '../../../src/ui/feedback/bridge.ts';
import {
  addMark, addPhotos, appendDraftText, clearDraft, draftImages, EMPTY_DRAFT, feedbackDraft, isEmptyDraft, joinText, photoRoom, removePhoto,
  shotFits, stageImage, undoMark, updateDraft,
} from '../../../src/ui/feedback/draft.ts';
import { frozen } from '../../../src/ui/feedback/popover-state.ts';
import { FEEDBACK_IMAGE_BUDGET, FEEDBACK_IMAGES_MAX, imageBudget } from '../../../src/shared/model/feedback-delivery.ts';

/** Records what the marks draw (the canvas context's calls). */
function fakeContext(): PaintContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    beginPath: () => calls.push('begin'),
    moveTo: (x, y) => calls.push(`move ${x},${y}`),
    lineTo: (x, y) => calls.push(`line ${x},${y}`),
    arc: (x, y, r) => calls.push(`arc ${x},${y} r${r}`),
    stroke() { calls.push(`stroke ${this.strokeStyle} w${this.lineWidth} ${this.lineCap}`); },
    fill() { calls.push(`fill ${this.fillStyle}`); },
  };
}

test('marks are opaque black: round pen lines, a tap is a dot', () => {
  const context = fakeContext();
  const marks: PaintMark[] = [
    { tool: 'pen', width: 40, points: [[10, 10], [50, 12], [90, 20]] },
    { tool: 'pen', width: 40, points: [[300, 300]] },
  ];
  drawMarks(context, marks);
  assert.equal(PAINT_COLOR, '#000000');
  assert.deepEqual(context.calls, [
    'begin', 'move 10,10', 'line 50,12', 'line 90,20', 'stroke #000000 w40 round',
    'begin', 'arc 300,300 r20', 'fill #000000',
  ]);
});

test('owner 21.11.2026: the person paints with the pen only – no box tool anywhere in the form', () => {
  const source = (file: string) => readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8');
  for (const file of ['ui/feedback/paint.ts', 'ui/feedback/AnnotationCanvas.tsx', 'ui/feedback/FeedbackOverlay.tsx', 'ui/tour/Scene.tsx']) {
    assert.doesNotMatch(source(file), /'box'|>Box<|boxOf|fillRect/, file);
  }
});

test('the pen is about 22 px on screen whatever the shot\'s size', () => {
  assert.equal(PEN_PX, 22);
  assert.equal(penWidth(1600, 800), 44, 'a 1600 px shot shown 800 px wide: 44 image px');
  assert.equal(penWidth(800, 800), 22);
  assert.ok(penWidth(100, 5000) >= 2, 'never thinner than 2 px');
});

test('every report image starts as one JPEG at quality 0.85 within 1600 px', () => {
  assert.equal(EXPORT_MIME, 'image/jpeg');
  assert.equal(EXPORT_QUALITY, 0.85);
  assert.equal(EXPORT_MAX_SIDE, 1600);
  assert.equal(REPORT_IMAGE_NAME, 'screenshot.jpg');
  assert.deepEqual(fitWithin(2880, 1800, EXPORT_MAX_SIDE), { width: 1600, height: 1000 }, 'a 1.5× window shot is scaled down');
  assert.deepEqual(fitWithin(1280, 820, EXPORT_MAX_SIDE), { width: 1280, height: 820 }, 'never up');
  assert.equal(screenshotName('data:image/jpeg;base64,x'), 'screenshot.jpg');
  assert.equal(imageBudget(1), FEEDBACK_IMAGE_BUDGET, 'one image: the whole budget');
  assert.equal(imageBudget(3), 200_000, 'several share it');
  assert.equal(imageBudget(0), FEEDBACK_IMAGE_BUDGET);
  assert.equal(imageBudget(50), FEEDBACK_IMAGE_BUDGET / FEEDBACK_IMAGES_MAX);
});

test('dictated words join with one space', () => {
  assert.equal(joinText('', ' The list jumps. '), 'The list jumps.');
  assert.equal(joinText('The list jumps.', 'Also the button.'), 'The list jumps. Also the button.');
  assert.equal(joinText('The list jumps. ', 'Also'), 'The list jumps. Also');
  assert.equal(joinText('Text', '   '), 'Text');
});

test('the draft: checked by default, text appends, cleared after sending', () => {
  clearDraft();
  assert.deepEqual(feedbackDraft.value, EMPTY_DRAFT);
  assert.equal(EMPTY_DRAFT.withShot, true, 'the Screenshot box is checked by default');
  appendDraftText('The list jumps.');
  appendDraftText('Also the button.');
  assert.equal(feedbackDraft.value.text, 'The list jumps. Also the button.');
  updateDraft({ withShot: false });
  clearDraft();
  assert.equal(feedbackDraft.value.text, '');
  assert.equal(feedbackDraft.value.withShot, true);
});

const pen = (x: number): PaintMark => ({ tool: 'pen', width: 8, points: [[x, x]] });

test('owner 21.11.2026: photos join the draft beside the shot, up to the cap; a click shows one; marks and Undo stay with their image', () => {
  clearDraft();
  updateDraft({ shot: 'data:shot', marks: [pen(1)] });
  assert.equal(photoRoom(feedbackDraft.value), FEEDBACK_IMAGES_MAX - 1, 'the window shot is one image');
  assert.equal(stageImage(feedbackDraft.value)?.src, 'data:shot');
  assert.equal(addPhotos(['data:a', 'data:b']), 2);
  let draft = feedbackDraft.value;
  assert.equal(draft.shot, 'data:shot', 'a photo never replaces the window shot');
  const [a, b] = draft.photos;
  assert.equal(stageImage(draft)?.photo, a!.id, 'the first added photo is shown');
  addMark(pen(2), stageImage(draft)!);
  updateDraft({ onStage: b!.id });
  addMark(pen(3), stageImage(feedbackDraft.value)!);
  addMark(pen(4), stageImage(feedbackDraft.value)!);
  undoMark();
  draft = feedbackDraft.value;
  assert.deepEqual(draft.photos.map((photo) => photo.marks), [[pen(2)], [pen(3)]], 'Undo acts on the image shown');
  assert.deepEqual(draft.marks, [pen(1)], 'the shot keeps its own marks');
  updateDraft({ onStage: null });
  undoMark();
  assert.deepEqual(feedbackDraft.value.marks, []);
  assert.deepEqual(draftImages(feedbackDraft.value).map((image) => [image.src, image.marks.length]), [['data:shot', 0], ['data:a', 1], ['data:b', 1]], 'the shot first, then the photos');
  updateDraft({ withShot: false });
  assert.deepEqual(draftImages(feedbackDraft.value).map((image) => image.src), ['data:a', 'data:b'], 'an unticked shot does not go');
  addMark(pen(5), { src: 'data:shot', marks: [] });
  addMark(pen(6), { src: 'data:gone', marks: [], photo: 'photo-gone' });
  assert.deepEqual(feedbackDraft.value.marks, [pen(5)]);
  assert.deepEqual(feedbackDraft.value.photos.map((photo) => photo.marks.length), [1, 1], 'a removed image takes no mark');
  updateDraft({ onStage: b!.id });
  removePhoto(b!.id);
  assert.equal(feedbackDraft.value.onStage, null);
  assert.equal(stageImage(feedbackDraft.value)?.src, 'data:shot', 'the stage goes back to the shot');
  updateDraft({ withShot: true });
  assert.equal(addPhotos(['1', '2', '3', '4', '5', '6']), FEEDBACK_IMAGES_MAX - 2, 'only as many as fit (the ticked shot is one)');
  assert.equal(photoRoom(feedbackDraft.value), 0);
  assert.equal(addPhotos(['7']), 0);
  clearDraft();
});

test('without a window shot (the iPhone web app, a browser): the photos alone, the stage shows the last', () => {
  clearDraft();
  assert.equal(stageImage(feedbackDraft.value), null, 'nothing to show: the live screen');
  assert.equal(photoRoom(feedbackDraft.value), FEEDBACK_IMAGES_MAX);
  addPhotos(['data:a']);
  assert.equal(isEmptyDraft(feedbackDraft.value), false, 'a photo is the person\'s');
  addPhotos(['data:b']);
  updateDraft({ onStage: null });
  assert.equal(stageImage(feedbackDraft.value)?.src, 'data:b');
  assert.deepEqual(draftImages(feedbackDraft.value).map((image) => image.src), ['data:a', 'data:b']);
  clearDraft();
  assert.deepEqual(feedbackDraft.value.photos, []);
});

test('review 21.11.2026: the images that go stay within the cap before Send – a new shot at a full cap comes unticked, nothing is cut', () => {
  clearDraft();
  addPhotos(Array.from({ length: FEEDBACK_IMAGES_MAX }, (_, index) => `data:p${index}`)); // no window shot yet (a failed capture)
  assert.equal(feedbackDraft.value.photos.length, FEEDBACK_IMAGES_MAX);
  feedbackDraft.value = frozen(feedbackDraft.value, 'data:shot');
  assert.equal(feedbackDraft.value.shot, 'data:shot', 'shown on the stage');
  assert.equal(feedbackDraft.value.withShot, false, 'it does not go while the photos fill the cap');
  assert.equal(shotFits(feedbackDraft.value), false);
  assert.equal(draftImages(feedbackDraft.value).length, FEEDBACK_IMAGES_MAX, 'every photo the person sees goes');
  assert.equal(photoRoom(feedbackDraft.value), 0);
  removePhoto(feedbackDraft.value.photos[0]!.id);
  assert.equal(shotFits(feedbackDraft.value), true, 'a photo went: its box may be ticked');
  updateDraft({ withShot: true });
  assert.deepEqual(draftImages(feedbackDraft.value).map((image) => image.src), ['data:shot', 'data:p1', 'data:p2', 'data:p3', 'data:p4', 'data:p5']);
  assert.equal(photoRoom(feedbackDraft.value), 0, 'the ticked shot counts as one image');
  updateDraft({ withShot: false });
  assert.equal(photoRoom(feedbackDraft.value), 1, 'an unticked shot takes no room');
  feedbackDraft.value = frozen(feedbackDraft.value, 'data:shot2');
  assert.equal(feedbackDraft.value.withShot, true, 'below the cap a new shot goes, as always');
  clearDraft();
});
