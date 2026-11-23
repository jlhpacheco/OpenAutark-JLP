// The input line's own + (review R2.8/R2.4 – the chat's Plus menu for a new to-do): Files… (they go with the new to-do,
// kept on its row), Send to… (an agent, a manager's branch, a team or – in the owner's session – a colleague: the line
// goes straight to them, tasks.quickCreate `target`; RecipientMenu.tsx), and Only me (the person does this one; the AI
// keeps it in view and never takes it over – it hides nothing; its default is the settings' "AI helps"). Whatever is set
// shows as a removable chip in the line's one chip row. While
// a take records or is transcribed the + is the × that cancels it (chat/composer/PlusCancel.tsx); in quest mode it is
// only a mark beside the field.
// Owns: the +'s menu, the file pick and the chips of what it set. Never: sends the line (TaskInput.tsx) or routes it.

import { useRef, useState } from 'preact/hooks';
import type { Attachment } from '../../shared/model/chat.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { PlusCancel } from '../chat/composer/PlusCancel.tsx';
import { toAttachment, uploadFile } from '../lib/files.ts';
import { bridge } from '../lib/platform.ts';
import { agents, settings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Icon, Menu } from '../lib/ui.tsx';
import { targetLabel } from './center-model.ts';
import type { Line } from './page-state.ts';
import { recipientPeople, recipientSections } from './RecipientMenu.tsx';
import type { FieldDictation } from './use-dictation.ts';

/** "Only me" as it stands: the person's pick for this line, else the settings' default ("AI helps" off: every line is). */
export function lineOnlyMe(line: Line): boolean {
  if (line.target.value) return false;
  return line.onlyMe.value ?? !daySettingsOf(settings.value ?? undefined).aiHelps;
}

/** Uploads the picked files one by one (`onBusy` +1 / −1 around each: the line's Add waits while any goes up). */
async function addFiles(line: Line, list: File[], onBusy: (delta: number) => void): Promise<void> {
  for (const file of list) {
    onBusy(1);
    try { line.files.value = [...line.files.peek(), await uploadFile(file)]; } catch (error) { toastError(error, 'Upload failed'); }
    onBusy(-1);
  }
}

/** The line's +: its menu in to-do mode, a mark in quest mode, the × while a take runs. */
export function LinePlus(props: { line: Line; mic: FieldDictation; field: { current: HTMLElement | null }; questMode: boolean; onBusy: (delta: number) => void }) {
  const { line } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  if (props.questMode) return <PlusCancel mark cancel={props.mic.cancel} label="New quest" class="task-input-plus" iconSize={16} onClick={() => props.field.current?.focus()} />;
  const pickFiles = async () => {
    if (!bridge) { input.current?.click(); return; }
    try {
      const refs = await bridge.files.pick('files');
      if (refs.length) line.files.value = [...line.files.peek(), ...refs.map(toAttachment)];
    } catch (error) { toastError(error, 'Upload failed'); }
  };
  const only = lineOnlyMe(line);
  const sections = () => [
    { items: [
      { label: 'Files…', icon: 'paperclip' as const, onSelect: () => void pickFiles() },
      { label: 'Only me', icon: 'user' as const, description: 'I do this one; the AI keeps it in view', checked: only, onSelect: () => { line.onlyMe.value = !only; if (!only) line.target.value = undefined; } },
    ] },
    ...recipientSections({ value: line.target.peek(), people: true, onPick: (target) => { line.target.value = target; if (target) line.onlyMe.value = false; } }),
  ];
  return (
    <>
      <PlusCancel buttonRef={ref} class="task-input-plus" label="Add files, send to…, only me" iconSize={16} expanded={open}
        cancel={props.mic.cancel} onClick={() => setOpen(!open)} />
      <Menu anchor={ref.current} open={open && !props.mic.cancel} onClose={() => setOpen(false)} placement="bottom-start" width={260} label="Add" sections={open ? sections() : []} />
      <input ref={input} type="file" multiple hidden onChange={(event) => {
        const el = event.currentTarget as HTMLInputElement;
        void addFiles(line, [...(el.files ?? [])], props.onBusy);
        el.value = '';
      }} />
    </>
  );
}

function FileChip(props: { file: Attachment; onRemove: () => void }) {
  return (
    <span class="task-chip file" title={props.file.name}>
      <Icon name="paperclip" size={12} /><span class="task-chip-text">{props.file.name ?? 'File'}</span>
      <button type="button" class="task-chip-x" aria-label={`Remove ${props.file.name ?? 'the file'}`} title="Remove" onClick={props.onRemove}>×</button>
    </span>
  );
}

/** What the + set, as chips: whom the line goes to, Only me, the files (and "Uploading…" while one goes up). */
export function ExtraChips(props: { line: Line; busy: number }) {
  const { line } = props;
  const target = line.target.value;
  const to = target ? targetLabel(target, agents.value, recipientPeople(true)) : undefined;
  return (
    <>
      {to && (
        <span class="task-chip to"><Icon name="arrow-right" size={12} />{to}
          <button type="button" class="task-chip-x" aria-label="Not to them – mine" title="Not to them – mine" onClick={() => { line.target.value = undefined; }}>×</button>
        </span>
      )}
      {lineOnlyMe(line) && (
        <span class="task-chip"><Icon name="user" size={12} />Only me
          <button type="button" class="task-chip-x" aria-label="Let the AI take it on" title="Let the AI take it on" onClick={() => { line.onlyMe.value = false; }}>×</button>
        </span>
      )}
      {line.files.value.map((file, index) => (
        <FileChip key={`${file.fileId}:${index}`} file={file} onRemove={() => { line.files.value = line.files.peek().filter((_, at) => at !== index); }} />
      ))}
      {props.busy > 0 && <span class="task-chip">Uploading…</span>}
    </>
  );
}
