// Settings › Security's editable parts with the double confirm (owner 19.11.2026: "muss doppelt auf den
// Bestätigungsbutton klicken … jedes Mal"): useDoubleConfirm, the lock button in its fixed slot (Edit → Yes, change it →
// Done; one width for all three words), the mode row and a topic text field. A field that needs it (security-model.ts
// needsDoubleConfirm) is read-only until the person clicks Edit and then "Yes, change it" – every time it is opened;
// focus leaving the field locks it again (a text is saved then). Other topic fields are plain fields saved on leaving
// them. A topic text is one file (security.saveTopic; `null` = back to the default, "Reset to default" while it has a
// file of its own).
// Owns: these fields and their lock state. Never: decides which field is critical (security-model.ts) or holds a
// value beyond the field being edited.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TopicText } from '../../shared/api/methods-security-mode.ts';
import { MAX_TOPIC_TEXT, type SecurityMode, type SecurityTopic } from '../../shared/model/security-settings.ts';
import { rpc } from '../lib/rpc.ts';
import { Button } from '../lib/ui.tsx';
import { setSecurityMode } from '../onboarding/security-mode.ts';
import { act, Note, Row } from './controls.tsx';
import {
  confirmText, lockedState, LOCK_WORD, MODE_ROWS, MODE_TEXT, modeTitle, needsDoubleConfirm, nextLock, topicWrite, type LockState,
} from './security-model.ts';

/** The lock of one field: open at once when it needs no double confirm, else Edit → confirm → open; lock() closes it. */
export function useDoubleConfirm(needed: boolean) {
  const [state, setState] = useState<LockState>(lockedState(needed));
  useEffect(() => setState(lockedState(needed)), [needed]);
  return { state, step: () => setState(nextLock), lock: () => setState(lockedState(needed)) };
}

export function LockButton(props: { state: LockState; onStep: () => void; onDone: () => void; busy?: boolean }) {
  return (
    <Button variant={props.state === 'confirm' ? 'danger' : 'secondary'} class="small sec-lock" busy={props.busy}
      onMouseDown={(event) => { if (props.state === 'open') event.preventDefault(); }} // Done keeps the field's focus until it saves
      onClick={() => (props.state === 'open' ? props.onDone() : props.onStep())}>
      {LOCK_WORD[props.state]}
    </Button>
  );
}

/** Focus left `box` (not just moved inside it). */
export const leftBox = (event: FocusEvent, box: HTMLElement | null): boolean => !box?.contains(event.relatedTarget as Node | null);

/** The mode row: Trust AI | Secure, read-only until Edit and "Yes, change it"; the reserved two lines say what the mode means. */
export function ModeRow(props: { mode: SecurityMode; editable: boolean; lockNote: string }) {
  const lock = useDoubleConfirm(true);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const choose = (to: SecurityMode) => {
    if (lock.state !== 'open' || busy || to === props.mode) return;
    setBusy(true);
    void act(() => setSecurityMode(to), 'Could not change the mode').finally(() => { setBusy(false); lock.lock(); });
  };
  const hint = !props.editable ? props.lockNote : lock.state === 'confirm' ? confirmText(props.mode, 'mode') : MODE_TEXT[props.mode];
  return (
    <div ref={box} class="sec-mode" onFocusOut={(event) => { if (!busy && leftBox(event, box.current)) lock.lock(); }}>
      <Row label="Mode" hint={hint} reserve={2} class={lock.state === 'confirm' ? 'sec-confirming' : undefined}>
        {props.editable
          ? <>
            <div class="segmented" role="radiogroup" aria-label="Mode" aria-disabled={lock.state !== 'open'}>
              {MODE_ROWS.map((row) => (
                <button key={row.id} type="button" role="radio" aria-checked={row.id === props.mode} disabled={lock.state !== 'open' || busy}
                  class={row.id === props.mode ? 'selected' : ''} onClick={() => choose(row.id)}>
                  <span class="sec-mode-mark" aria-hidden="true">{row.id === props.mode && '✓'}</span>
                  {row.title}
                </button>
              ))}
            </div>
            <LockButton state={lock.state} busy={busy} onStep={lock.step} onDone={lock.lock} />
          </>
          : <Note>{modeTitle(props.mode)}</Note>}
      </Row>
    </div>
  );
}

/**
 * One topic text. `label`: the head line's name (`sub`: the quieter name of a text under a switch). `plain`: a note whose
 * default is "" (security-model.ts plainNote) – no head line, emptying it goes back to the default. `editable`: this
 * session may change the settings.
 */
export function TopicField(props: {
  mode: SecurityMode; topic: SecurityTopic; text: TopicText | undefined; label?: string; sub?: boolean; rows: number; placeholder?: string;
  plain?: boolean; editable: boolean; onSaved: (text: TopicText) => void;
}) {
  const { mode, topic, text } = props;
  const critical = needsDoubleConfirm(mode, topic);
  const lock = useDoubleConfirm(critical);
  const [draft, setDraft] = useState(text?.text ?? '');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dropped = useRef(false); // Escape: leave without saving
  const writable = props.editable && Boolean(text) && lock.state === 'open';
  useEffect(() => { if (!box.current?.contains(document.activeElement)) setDraft(text?.text ?? ''); }, [text?.text]);
  useEffect(() => { if (critical && lock.state === 'open') area.current?.focus(); }, [lock.state]);

  const write = (value: string | null) => {
    setBusy(true);
    void act(() => rpc.call('security.saveTopic', { mode, topic, text: value }), 'Could not save the text')
      .then((saved) => { if (saved) { props.onSaved(saved); setDraft(saved.text); } else setDraft(text?.text ?? ''); })
      .finally(() => setBusy(false));
  };
  const leave = () => {
    if (text && props.editable && lock.state === 'open' && !dropped.current) {
      const value = topicWrite(text, draft, props.plain ?? false);
      if (value !== undefined) write(value);
    }
    dropped.current = false;
    lock.lock();
  };
  const reset = () => {
    if (document.activeElement === area.current) { dropped.current = true; area.current?.blur(); } // the edit goes with the reset
    write(null);
    lock.lock();
  };
  const resettable = props.editable && text && !text.isDefault;
  const confirming = lock.state === 'confirm';
  return (
    <div ref={box} class={`sec-topic${confirming ? ' sec-confirming' : ''}`} onFocusOut={(event) => { if (leftBox(event, box.current)) leave(); }}>
      {!props.plain && (
        <div class="sec-topic-head">
          <span class={props.sub ? 'sec-topic-sub' : 'sec-topic-label'}>{props.label}</span>
          {props.editable && (
            <span class="sec-topic-actions">
              {resettable
                ? <Button variant="ghost" class="small sec-reset" disabled={busy || (critical && lock.state !== 'open')} onMouseDown={(event) => event.preventDefault()} onClick={reset}>Reset to default</Button>
                : <span class="button ghost small sec-reset inert" aria-hidden="true">Reset to default</span>}
              {critical && <LockButton state={lock.state} onStep={lock.step} onDone={() => area.current?.blur()} />}
            </span>
          )}
        </div>
      )}
      <div class="sec-topic-field">
        <textarea ref={area} class="set-textarea sec-topic-text" rows={props.rows} maxLength={MAX_TOPIC_TEXT} value={draft} readOnly={!writable}
          aria-label={props.label || props.placeholder || topic} placeholder={props.placeholder} spellcheck
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && writable) { dropped.current = true; setDraft(text?.text ?? ''); event.currentTarget.blur(); } }} />
        {confirming && <div class="sec-confirm" role="alert">{confirmText(mode, topic)}</div>}
      </div>
    </div>
  );
}
