// The floating to-do button's page (float-bar.ts holds the state): self-contained HTML, no library, served at
// wf-file://float/ in the button's own session. It draws the view main sends back after every action – the dot, the
// panel or the edge tab – and posts the person's actions as JSON to wf-file://float/act. Dragging moves the window by
// pointer screen coordinates (one move in flight at a time, the newest wins); a press that does not travel is a tap.
// Dictation: the microphone's audio at 16 kHz, kept as PCM while the mic is on and posted as one WAV when it stops. While a
// take records or is heard the panel's × cancels it (the recording is thrown away, late words go nowhere – act 'unhear';
// the owner's + → × of feedback FCMWNSOZ 20.11.2026, this panel has no +) and Send takes its words along.
// Owner 18.11.2026: holding the dot (HOLD_MS without moving) is the quick task – the screen at the hold's start, the
// words while held, sent at the release (act 'hold' then 'quick'); without a microphone the hold opens the panel.
// Owner 19.11.2026: a right-click anywhere asks main for the menu (act 'menu': Open Autark, Hide bubble); while the app's
// page holds a call the dot is the call pill – a live mark and who, Open (the app at that chat) and End (act 'hangup') –
// and a folded tab shows the call by its colour.
// Owns: the look and the input of the button. Never: talks to anything but its own /act, keeps text or audio after a
// post, or loads anything from outside.

const ICONS: Record<string, string> = {
  todo: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  shot: '<path d="M4 8a2 2 0 0 1 2-2h2l2-2h4l2 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  call: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  fold: '<path d="M15 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  end: '<path d="M3 15c5-4.5 13-4.5 18 0l-2.5 2.5-3.5-1.5v-2.5a10 10 0 0 0-6 0V16l-3.5 1.5z"/>',
};

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font: 13px/1.3 "Segoe UI", system-ui, sans-serif; color: #f2f2f2; user-select: none; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
button { all: unset; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: #e8e8e8; cursor: pointer; flex: none; }
button:hover { background: rgba(255,255,255,.12); }
button:focus-visible { outline: 2px solid #7aa7ff; }
button.on { color: #ff6b6b; }
button.go { background: #3d6df2; color: #fff; }
button.go:hover { background: #4f7bf5; }
#dot { position: fixed; inset: 0; border-radius: 50%; background: rgba(28,28,32,.88); border: 1px solid rgba(255,255,255,.18); display: grid; place-items: center; cursor: grab; touch-action: none; }
#dot svg { width: 22px; height: 22px; }
#dot.done { background: rgba(46,160,90,.92); }
#dot.rec { background: rgba(200,40,40,.92); box-shadow: 0 0 0 3px rgba(255,90,90,.45); }
#dot.busy { opacity: .6; }
#tab { position: fixed; inset: 0; border-radius: 6px; background: rgba(28,28,32,.75); border: 1px solid rgba(255,255,255,.18); cursor: pointer; touch-action: none; }
#tab.live { background: rgba(46,160,90,.92); }
#pill { position: fixed; inset: 0; border-radius: 22px; background: rgba(24,24,28,.95); border: 1px solid rgba(70,200,120,.6); display: flex; align-items: center; gap: 2px; padding: 0 6px 0 12px; }
#who { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 100%; cursor: grab; touch-action: none; }
#who span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pulse { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #3ccf78; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
button.end { background: #d93a3a; color: #fff; border-radius: 50%; }
button.end:hover { background: #e5484d; }
#panel { position: fixed; inset: 0; border-radius: 14px; background: rgba(24,24,28,.95); border: 1px solid rgba(255,255,255,.16); padding: 6px; display: flex; flex-direction: column; gap: 5px; }
.row { display: flex; align-items: center; gap: 2px; }
#grip { cursor: grab; touch-action: none; }
.grow { flex: 1; }
textarea { all: unset; flex: 1; height: 34px; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.08); white-space: pre-wrap; overflow-y: auto; user-select: text; font: inherit; }
textarea::placeholder { color: #9a9a9a; }
#shots { display: flex; gap: 4px; height: 34px; overflow: hidden; align-items: center; }
#shots img { height: 32px; width: 52px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255,255,255,.2); cursor: pointer; }
#note { font-size: 11px; color: #ffb4a8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
[hidden] { display: none !important; }
`;

const SCRIPT = `
const icon = (name) => '<svg viewBox="0 0 24 24">' + ICONS[name] + '</svg>';
const $ = (id) => document.getElementById(id);
let view = { look: 'dot', shots: [], text: '' };
let busy = false;

async function act(action) {
  try {
    const answer = await fetch('wf-file://float/act', { method: 'POST', body: JSON.stringify(action) });
    if (answer.ok) render(await answer.json());
  } catch {}
}

function render(next) {
  view = next;
  $('dot').hidden = view.look !== 'dot';
  $('tab').hidden = view.look !== 'tab';
  $('panel').hidden = view.look !== 'panel';
  $('pill').hidden = view.look !== 'call';
  $('tab').classList.toggle('live', !!view.call);
  $('name').textContent = view.call ? view.call.title : '';
  $('who').title = view.call ? 'Call with ' + view.call.title + ' · tap: open in the app · drag: move' : '';
  $('dot').classList.toggle('done', !!view.done);
  if (view.done) setTimeout(() => $('dot').classList.remove('done'), 1200);
  const field = $('text');
  if (document.activeElement !== field || field.value === '') field.value = view.text || '';
  if (view.look !== 'panel' && document.activeElement !== field) field.value = view.text || '';
  $('shots').innerHTML = '';
  view.shots.forEach((src, index) => {
    const img = document.createElement('img');
    img.src = src; img.title = 'Remove this screenshot'; img.alt = 'Screenshot ' + (index + 1);
    img.onclick = () => act({ act: 'drop', index });
    $('shots').append(img);
  });
  $('note').textContent = view.note || '';
  if (view.look === 'panel') setTimeout(() => field.focus(), 0);
}
window.render = render;

// Drag by screen coordinates: one move in flight, the newest position wins.
function draggable(el, onTap, onHold) {
  let start = null, moving = false, flight = false, next = null, holding = false, timer = 0;
  const pump = async () => {
    if (flight || !next) return;
    flight = true; const at = next; next = null;
    try { await fetch('wf-file://float/act', { method: 'POST', body: JSON.stringify({ act: 'move', x: at.x, y: at.y }) }); } catch {}
    flight = false; pump();
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    start = { sx: e.screenX, sy: e.screenY, ox: e.screenX - window.screenX, oy: e.screenY - window.screenY };
    moving = false; holding = false;
    if (onHold) timer = setTimeout(() => { if (start && !moving) { holding = true; onHold.down(); } }, HOLD_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (holding || (!moving && Math.hypot(e.screenX - start.sx, e.screenY - start.sy) < 5)) return;
    moving = true; clearTimeout(timer);
    next = { x: e.screenX - start.ox, y: e.screenY - start.oy }; pump();
  });
  el.addEventListener('pointerup', async () => {
    if (!start) return;
    clearTimeout(timer);
    const was = moving; start = null; moving = false;
    if (holding) { holding = false; onHold.up(); return; }
    if (was) { while (flight || next) await new Promise((r) => setTimeout(r, 16)); act({ act: 'moved' }); }
    else onTap();
  });
}

// Dictation: 16 kHz mono PCM while the mic is on; stop() gives one WAV (base64).
async function record() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const tap = ctx.createScriptProcessor(4096, 1, 1);
  const parts = [];
  tap.onaudioprocess = (e) => parts.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(tap); tap.connect(ctx.destination);
  return { stop: async () => {
    tap.disconnect(); source.disconnect(); stream.getTracks().forEach((t) => t.stop()); await ctx.close();
    return wav(parts, 16000);
  } };
}
let rec = null, hearing = null, takes = 0; // hearing: the stopped take's words on their way ({ n, done })
function takeState() { // while a take runs the × cancels it
  const on = !!rec || !!hearing, close = $('close');
  close.title = on ? 'Cancel dictation' : 'Close'; close.setAttribute('aria-label', close.title);
}
async function micToggle() {
  if (rec) {
    const current = rec, n = ++takes; rec = null; $('mic').classList.remove('on');
    $('note').textContent = 'Listening back…';
    let done; hearing = { n, done: new Promise((r) => { done = r; }) }; takeState();
    const audio = await current.stop();
    if (hearing && hearing.n === n) {
      await act({ act: 'text', text: $('text').value });
      if (hearing && hearing.n === n) await act({ act: 'hear', wav: audio });
      if (hearing && hearing.n === n) $('text').value = view.text || ''; // the field holds the words, focused or not
    }
    if (hearing && hearing.n === n) { hearing = null; takeState(); }
    done();
    return;
  }
  try { rec = await record(); $('mic').classList.add('on'); takeState(); } catch { $('note').textContent = 'No microphone.'; }
}
/** Throws the running take away, or drops the words still being heard; true when there was one. */
function cancelTake() {
  if (!rec && !hearing) return false;
  if (rec) { const current = rec; rec = null; $('mic').classList.remove('on'); current.stop().catch(() => {}); }
  if (hearing) { hearing = null; act({ act: 'unhear' }); }
  $('note').textContent = ''; takeState();
  return true;
}
function wav(parts, rate) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2), v = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, length * 2, true);
  let o = 44;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, p[i])) * 0x7fff, true);
  const bytes = new Uint8Array(buffer); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Hold the dot: the screen is taken at once, the words are heard while held and sent at the release.
const HOLD_MS = 350;
let taking = null, shooting = null; // promises: the release may come before the microphone is open or the shot is in
function holdDown() {
  $('dot').classList.add('rec');
  shooting = act({ act: 'hold' });
  taking = record().catch(() => null); // at once, beside the shot: the first words count
}
async function holdUp() {
  const pending = taking; taking = null;
  const take = pending ? await pending : null;
  await shooting;
  $('dot').classList.remove('rec');
  if (!take) { act({ act: 'open' }); return; }
  $('dot').classList.add('busy');
  await act({ act: 'quick', wav: await take.stop() });
  $('dot').classList.remove('busy');
}

async function post(call) {
  if (busy) return;
  if (rec) await micToggle(); else if (hearing) await hearing.done; // the take's words go along
  busy = true; $('note').textContent = call ? 'Calling…' : 'Sending…';
  await act({ act: 'send', text: $('text').value, call });
  busy = false;
}

document.addEventListener('DOMContentLoaded', () => {
  for (const b of document.querySelectorAll('[data-icon]')) b.innerHTML = icon(b.dataset.icon);
  draggable($('dot'), () => act({ act: 'open' }), { down: holdDown, up: holdUp });
  draggable($('grip'), () => { cancelTake(); act({ act: 'close' }); });
  $('tab').addEventListener('click', () => act({ act: 'unfold' }));
  draggable($('who'), () => act({ act: 'app' }));
  $('app').onclick = (e) => { e.stopPropagation(); act({ act: 'app' }); };
  $('end').onclick = (e) => { e.stopPropagation(); act({ act: 'hangup' }); };
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.target !== $('text')) act({ act: 'menu' }); });
  $('shot').onclick = () => act({ act: 'shot' });
  $('mic').onclick = micToggle;
  $('call').onclick = () => post(true);
  $('send').onclick = () => post(false);
  $('fold').onclick = () => act({ act: 'fold' });
  $('close').onclick = () => { if (!cancelTake()) act({ act: 'close' }); };
  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(false); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !cancelTake()) act({ act: 'close' }); });
  $('text').addEventListener('change', () => act({ act: 'text', text: $('text').value }));
  act({ act: 'view' });
});
`;

const BODY = `
<div id="dot" role="button" aria-label="To-do: tap to open, hold to talk and send, drag to move" title="To-do · tap: open · hold: talk and send · drag: move · right-click: hide (Ctrl+Alt+N)" data-icon="todo"></div>
<div id="tab" role="button" aria-label="Show the to-do button" title="To-do" hidden></div>
<div id="pill" hidden>
  <div id="who" role="button" aria-label="Open the call in the app"><i class="pulse"></i><span id="name"></span></div>
  <button id="app" data-icon="app" title="Open in the app" aria-label="Open in the app"></button>
  <button id="end" class="end" data-icon="end" title="End the call" aria-label="End the call"></button>
</div>
<div id="panel" hidden>
  <div class="row">
    <button id="grip" data-icon="todo" title="Drag to move · tap to close" aria-label="Close"></button>
    <button id="shot" data-icon="shot" title="One more screenshot" aria-label="One more screenshot"></button>
    <button id="mic" data-icon="mic" title="Dictate" aria-label="Dictate"></button>
    <span id="note" class="grow" role="status"></span>
    <button id="fold" data-icon="fold" title="Fold to the edge" aria-label="Fold to the edge"></button>
    <button id="close" data-icon="close" title="Close" aria-label="Close"></button>
  </div>
  <div class="row">
    <textarea id="text" placeholder="What should be done?" aria-label="What should be done?"></textarea>
    <button id="call" data-icon="call" title="Call about it" aria-label="Call about it"></button>
    <button id="send" class="go" data-icon="send" title="Send as a task (Enter)" aria-label="Send as a task"></button>
  </div>
  <div id="shots"></div>
</div>`;

/** The whole page (CSP: only its own inline style and script, fetches to its own origin, images from data: URLs). */
export function floatPage(): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src wf-file://float";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>To-do</title><style>${STYLE}</style></head><body>${BODY}<script>const ICONS = ${JSON.stringify(ICONS)};${SCRIPT}</script></body></html>`;
}
