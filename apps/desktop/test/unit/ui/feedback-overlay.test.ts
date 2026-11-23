// Feedback 16.11.2026 (F11, F13, F15) – the snapshot overlay. Every opening freezes the window (popover-state.ts
// snapshot): the new shot replaces the draft's and its marks and is shown, the words and photos stay; a snapshot while the overlay is shown is a
// snapshot of the overlay itself – the draft does not change before the image is there, and a failed capture keeps what
// is shown. The cells register for the dialog slot's spot and the shortcut's pill. While a modal's backdrop dims the
// window, main is told once (stacked dialogs: dim with the first, undim with the last). And the wiring: the overlay is
// a modal opened after any dialog, Escape keeps the draft, every dialog draws the cell's slot, main forwards the
// shortcut from the app's page and the side browser.
// Owns: these assertions only. Never: a DOM, Electron, a real capture or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMPTY_DRAFT, clearDraft, feedbackDraft, shotTaking, updateDraft } from '../../../src/ui/feedback/draft.ts';
import type { PaintMark } from '../../../src/ui/feedback/paint.ts';
import { cellSpot, frozen, overlayShown, registerCell, snapshot, snapshotSettled, topCell } from '../../../src/ui/feedback/popover-state.ts';
import { DIMMING, dimReporter } from '../../../src/ui/lib/backdrop-dim.ts';

const source = (path: string) => readFileSync(new URL(`../../../src/${path}`, import.meta.url), 'utf8');
const box: PaintMark = { tool: 'pen', width: 10, points: [[0, 0], [10, 10]] };

/** A capture that answers when told to. */
function pendingCapture() {
  let answer!: (image: string | null) => void;
  let calls = 0;
  const capture = () => { calls++; return new Promise<string | null>((resolve) => { answer = resolve; }); };
  return { capture, answer: (image: string | null) => answer(image), calls: () => calls };
}

test('frozen: the new shot replaces the old one and its marks and is shown; the words, photos and place stay unless given', () => {
  const photos = [{ id: 'p1', src: 'data:photo', marks: [box] }];
  const draft = { ...EMPTY_DRAFT, text: 'The list jumps', shot: 'data:old', marks: [box], withShot: false, photos, onStage: 'p1', where: { view: 'chat' } };
  assert.deepEqual(frozen(draft, 'data:new'), { ...draft, shot: 'data:new', marks: [], withShot: true, onStage: null });
  assert.deepEqual(frozen(draft, null, { view: 'home' }).where, { view: 'home' });
  assert.equal(frozen(draft, null).shot, null);
});

test('a press with the overlay closed freezes the live window: shot replaced, marks gone, words kept', async () => {
  clearDraft();
  overlayShown.value = false;
  updateDraft({ text: 'The list jumps', shot: 'data:old', marks: [box], withShot: false });
  const fake = pendingCapture();
  const done = snapshot({ view: 'home' }, fake.capture, true);
  assert.equal(shotTaking.value, true, 'closed: the overlay waits for it (it is not shown yet)');
  fake.answer('data:new');
  await done;
  const draft = feedbackDraft.value;
  assert.deepEqual({ shot: draft.shot, marks: draft.marks, withShot: draft.withShot, text: draft.text, where: draft.where },
    { shot: 'data:new', marks: [], withShot: true, text: 'The list jumps', where: { view: 'home' } });
  assert.equal(shotTaking.value, false);
  // a failed capture with the overlay closed leaves no shot: never an older screen
  const failed = snapshot({ view: 'tasks' }, async () => null, true);
  await failed;
  assert.equal(feedbackDraft.value.shot, null);
  assert.equal(feedbackDraft.value.text, 'The list jumps');
  clearDraft();
});

test('a press while the overlay is open snapshots the overlay itself: nothing changes before the image, the words stay', async () => {
  clearDraft();
  updateDraft({ text: 'Paint over this', shot: 'data:first', marks: [box], where: { view: 'chat' } });
  overlayShown.value = true;
  try {
    const fake = pendingCapture();
    const done = snapshot(undefined, fake.capture, true);
    assert.equal(shotTaking.value, false, 'nothing in the overlay changes while it is captured');
    assert.equal(feedbackDraft.value.shot, 'data:first');
    assert.deepEqual(feedbackDraft.value.marks, [box], 'the marks are still drawn – the shot shows them painted');
    fake.answer('data:overlay');
    await done;
    assert.deepEqual({ shot: feedbackDraft.value.shot, marks: feedbackDraft.value.marks, text: feedbackDraft.value.text, where: feedbackDraft.value.where },
      { shot: 'data:overlay', marks: [], text: 'Paint over this', where: { view: 'chat' } });
    // a failed capture keeps what is shown
    await snapshot(undefined, async () => null, true);
    assert.equal(feedbackDraft.value.shot, 'data:overlay');
    await snapshot(undefined, () => Promise.reject(new Error('gone')), true);
    assert.equal(feedbackDraft.value.shot, 'data:overlay');
  } finally {
    overlayShown.value = false;
    clearDraft();
  }
});

test('one capture at a time; a host without capture takes none; the overlay waits a bounded time', async () => {
  clearDraft();
  const fake = pendingCapture();
  const first = snapshot({ view: 'home' }, fake.capture, true);
  const second = snapshot({ view: 'home' }, fake.capture, true);
  assert.equal(fake.calls(), 1, 'a second press meanwhile shares the capture on its way');
  const started = Date.now();
  await snapshotSettled(30);
  assert.ok(Date.now() - started < 1000, 'a slow capture never keeps the overlay away');
  fake.answer('data:x');
  await Promise.all([first, second]);
  updateDraft({ text: 'kept' });
  let called = false;
  await snapshot({ view: 'home' }, async () => { called = true; return 'data:y'; }, false);
  assert.equal(called, false, 'the iPhone web app and a browser: "Add photo" instead');
  assert.equal(feedbackDraft.value.shot, 'data:x');
  await snapshotSettled(); // nothing pending: at once
  clearDraft();
});

/** A fake cell's button: shown with `width`×32 at `left`, or hidden (0 wide). */
const cell = (left: number, width = 32) => ({
  isConnected: true,
  getBoundingClientRect: () => ({ left, top: 8, width, height: width ? 32 : 0, right: left + width, bottom: 8 + (width ? 32 : 0) }),
}) as unknown as HTMLElement;

test('the cells: a dialog\'s slot lies at the row cell\'s spot; the shortcut\'s pill hangs from the cell on top', () => {
  const frame = cell(1700);
  const offFrame = registerCell(frame, false);
  assert.equal(cellSpot()?.left, 1700);
  assert.equal(topCell(), frame);
  const hiddenRow = registerCell(cell(0, 0), false); // a row cell that is not shown (another screen's)
  assert.equal(cellSpot()?.left, 1700, 'a cell that is not shown is no spot');
  const slot = cell(1700);
  const offSlot = registerCell(slot, true);
  assert.equal(cellSpot()?.left, 1700, 'the spot is the row cell\'s, never a slot\'s');
  assert.equal(topCell(), slot, 'under a dialog the slot is the cell on top');
  offSlot();
  assert.equal(topCell(), frame);
  hiddenRow(); offFrame();
  assert.equal(cellSpot(), null);
  assert.equal(topCell(), null);
});

test('the caption controls dim with the first modal and undim when the last one closes – told on change only', () => {
  const told: boolean[] = [];
  const tell = dimReporter((dim) => { told.push(dim); });
  const open = new Set<string>();
  const check = () => tell(open.size > 0);
  check(); // nothing open at the start
  open.add('invite'); check();
  open.add('confirm'); check();
  open.delete('invite'); check();
  open.delete('confirm'); check();
  assert.deepEqual(told, [true, false]);
  const broken = dimReporter(() => { throw new Error('main is gone'); });
  assert.doesNotThrow(() => broken(true));
  assert.equal(DIMMING, 'dialog.dialog[open]', 'dialogs with the backdrop; the snapshot overlay has its own class and no backdrop');
  assert.doesNotMatch(source('ui/feedback/FeedbackOverlay.tsx'), /class="dialog /);
});

test('wiring: the overlay is a modal over any dialog, Escape keeps the draft, every dialog draws the cell\'s slot', () => {
  const overlay = source('ui/feedback/FeedbackOverlay.tsx');
  assert.match(overlay, /if \(shown && !dialog\.open\) dialog\.showModal\(\);/, 'opened last: above any open dialog');
  assert.match(overlay, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); closeFeedback\(\); \}\}/, 'Escape closes, the draft stays');
  assert.match(overlay, /<DialogSlot anywhere \/>/, 'the cell can be pressed again inside the overlay');
  assert.match(overlay, /<AnnotationCanvas image=\{image\} marks=\{shown\.marks\}/, 'painted straight on the image shown');
  assert.match(overlay, /\{canCaptureWindow\(\) && \(/, 'no window shot here (the iPhone web app, a browser): no Screenshot chip – photos alone');
  assert.match(overlay, /onClick=\{\(\) => updateDraft\(\{ onStage: photo\.id \}\)\}/, 'a click on a photo shows it to paint on');
  assert.match(overlay, /onClick=\{\(\) => removePhoto\(photo\.id\)\}/, 'its × removes it');
  assert.match(overlay, /disabled=\{draft\.shot === null \|\| going \|\| full\}/, 'a shot past the image cap cannot be ticked (its title says why)');
  const panel = source('ui/feedback/FeedbackPanel.tsx');
  assert.match(panel, /accept="image\/\*" multiple/, 'several photos at once');
  assert.match(panel, /addPhotos\(/, 'the + adds photos');
  assert.doesNotMatch(panel, /frozen\(/, 'a photo never replaces the window shot');
  assert.match(panel, /flatten\(image\.src, image\.marks, budget\)/, 'each image flattened with its marks within its share');
  const dialog = source('ui/lib/dialog.tsx');
  assert.match(dialog, /\{props\.open && modal && <DialogSlot \/>\}/);
  assert.match(dialog, /useLayoutEffect\(watchBackdropDim, \[\]\)/);
  const host = source('ui/feedback/FeedbackMenu.tsx');
  assert.match(host, /render: \(\) => <FeedbackButton slot /);
  assert.match(host, /useEffect\(\(\) => setDialogSlot\(cellSlot\), \[\]\);/);
  assert.match(host, /useEffect\(\(\) => listenFeedbackKey\(\), \[\]\);/);
  assert.doesNotMatch(source('ui/feedback/FeedbackPanel.tsx'), /reportImage|paintSettled/, 'the image is flattened from the shot and its marks at Send');
});

test('wiring: main reads the shortcut before the app\'s page and before a side browser page; the dim reaches the caption', () => {
  const window = source('main/window.ts');
  assert.match(window, /const step = feedbackKey\.step\(input, mac\);/);
  assert.match(window, /if \(step !== 'swallow'\) contents\.send\(IPC\.feedbackKey, step\);/);
  assert.match(window, /titleBarOverlay\(dark, this\.captionLayout, this\.captionDim\)/);
  assert.match(window, /contents\.on\('did-navigate', \(\) => \{ deps\.renderer\.loading\(\); this\.setTitleBarDim\(false\); \}\)/, 'a reload starts undimmed');
  const chrome = source('main/workspace-chrome.ts');
  assert.match(chrome, /const feedback = this\.feedbackKey\.step\(input, this\.mac\);/);
  assert.ok(chrome.indexOf('this.feedbackKey.step') < chrome.indexOf('pageKey(input'), 'before the browser shortcuts');
  assert.match(source('preload/index.ts'), /setTitleBarDim: dim => \{ ipcRenderer\.send\(IPC\.titleBarDim, dim === true\); \}/);
  assert.match(source('main/desktop.ts'), /titleBarDim: dim => mainWindow\.setTitleBarDim\(dim\)/);
});
