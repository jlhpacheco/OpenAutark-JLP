// Composer Plus menu: Files & folders, Photos & videos, Take photo (a phone: the camera app), Record audio and Record
// video (F23: composer/RecordBar.tsx above the field; a phone's video is the camera app's), Secret (the composer's
// secret mode, settings/SecretRows.tsx), Task (turns the draft into a task; an empty field gets "/task " to write it),
// and how the draft goes out – "Send as important", "Send silently" and "Schedule…" (which switches the composer into schedule mode, composer/ScheduleBar.tsx;
// the Send button's right-click menu has the same three, slash.ts sendMenuItems). In schedule mode the first two read
// "Schedule as important" / "Schedule silently" and "Schedule…" is ticked. Owner 04.11.2026: no entry is ever greyed out.
// While a take records or is transcribed the + turns into an × that cancels it (PlusCancel.tsx, feedback FCMWNSOZ
// 20.11.2026) – one click, the menu stays closed.
// Owns: the menu. Never: uploads or sends itself (callbacks do).

import { useRef, useState } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { Menu } from '../../lib/ui.tsx';
import type { MenuItem } from '../../lib/ui.tsx';
import { can } from '../../lib/session.ts';
import { sendMenuItems, type SendActions } from './slash.ts';
import { PlusCancel } from './PlusCancel.tsx';
import { takeCancel } from './voice.ts';

export interface PlusActions extends SendActions {
  secret?: () => void;
  pickFiles: () => void;
  pickImages: () => void;
  /** F23: the composer's RecordBar (a phone's video: the camera app). */
  recordAudio: () => void;
  recordVideo: () => void;
  /** Where the camera app takes the photo (a phone); the desktop's camera bar has Photo. */
  takePhoto?: () => void;
  makeTask: () => void;
}

export function PlusMenu(props: { chat: ConversationSummary; actions: PlusActions }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { actions } = props;
  const items: MenuItem[] = [
    { label: 'Files & folders', onSelect: actions.pickFiles },
    { label: 'Photos & videos', onSelect: actions.pickImages },
    ...(actions.takePhoto ? [{ label: 'Take photo', onSelect: actions.takePhoto }] : []),
    { label: 'Record audio', onSelect: actions.recordAudio },
    { label: 'Record video', onSelect: actions.recordVideo },
    ...(can('secrets.capture') && actions.secret ? [{ label: 'Secret', onSelect: actions.secret }] : []),
    ...(can('tasks.create') ? [{ label: 'Task', onSelect: actions.makeTask }] : []),
  ];
  const cancel = takeCancel(props.chat.id);
  return (
    <>
      <PlusCancel buttonRef={ref} class="composer-plus" label="Add" expanded={open} onClick={() => setOpen(!open)}
        cancel={cancel && { label: cancel.label, run: () => { setOpen(false); cancel.run(); } }} />
      <Menu anchor={ref.current} open={open && !cancel} onClose={() => setOpen(false)} placement="top-start" width={260} label="Add"
        sections={[{ items }, { items: sendMenuItems(actions) }]} />
    </>
  );
}
