// Settings › Scheduled: the one dialog that writes a new scheduled message or changes one (owner 21.11.2026) – the chat (a
// message of an agent only into chats that agent is in; a reminder stays with its agent and has no chat to pick), the text
// (a message's words or a reminder's note), the level of a message and the rule in the composer's own block
// (chat/composer/ScheduleBar.tsx, schedule-form.ts: one way to say a time). New = messages.schedule, as the composer's
// "Schedule…" sends it; a change = schedules.update with only what changed (tasks/schedule-edit.ts). A stored rule the form
// cannot show (several times a day, a window, a run limit) stays as it is until "New rule".
// Owns: that dialog's fields and its two calls. Never: the list (ScheduledPage.tsx), builds specs itself.

import { useState } from 'preact/hooks';
import type { ConversationSummary, MessageLevel } from '../../shared/model/chat.ts';
import type { Schedule } from '../../shared/model/tasks.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';
import { ScheduleBar } from '../chat/composer/ScheduleBar.tsx';
import { defaultForm, formFromSpec, formKey, scheduleSpec, type ScheduleForm } from '../chat/composer/schedule-form.ts';
import { localZone } from '../chat/composer/schedule-mode.ts';
import { useNextRun } from '../chat/composer/schedule-next.ts';
import { ruleLine } from '../chat/composer/schedule-rule.ts';
import { mentionsIn } from '../chat/composer/target.ts';
import { chatTitle } from '../lib/chat-naming.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { errorText, rpc } from '../lib/rpc.ts';
import { agentName, conversations } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { editParams, levelOf, scheduleText } from '../tasks/schedule-edit.ts';
import { Segmented, Select, type Option } from './controls.tsx';

export type ScheduleTarget = Schedule | 'new';

const LEVELS: Array<Option<MessageLevel>> = [{ value: 'normal', label: 'Normal' }, { value: 'important', label: 'Important' }, { value: 'silent', label: 'Silent' }];

/** The chats a message can go to: the person's chats in the list – for an agent's message those it is in – and its own chat. */
function chatOptions(schedule: Schedule | undefined): Array<Option<string>> {
  const owner = schedule?.ownerId ?? HUMAN_ID;
  const fits = (chat: ConversationSummary) => !chat.archivedAt && chatSection(chat) === 'main'
    && (owner === HUMAN_ID || chat.members.some((member) => member.memberId === owner && !member.leftAt));
  const options = conversations.value.filter(fits).map((chat) => ({ value: chat.id, label: chatTitle(chat) }));
  const own = schedule?.conversationId;
  if (own && !options.some((option) => option.value === own)) {
    const chat = conversations.value.find((entry) => entry.id === own);
    options.unshift({ value: own, label: chat ? chatTitle(chat) : 'Its chat' });
  }
  return options;
}

function Editor(props: { target: ScheduleTarget; onClose: () => void }) {
  const schedule = props.target === 'new' ? undefined : props.target;
  const reminder = schedule?.kind === 'reminder';
  const [opened] = useState(() => {
    const form = schedule ? formFromSpec(schedule.spec, Date.now(), localZone()) : defaultForm(Date.now(), localZone());
    return { form, key: form && schedule ? formKey(form) : '' };
  });
  const options = chatOptions(schedule);
  const [chatId, setChatId] = useState(schedule?.conversationId ?? options[0]?.value ?? '');
  const [body, setBody] = useState(schedule ? scheduleText(schedule) : '');
  const [level, setLevel] = useState<MessageLevel>(schedule ? levelOf(schedule) : 'normal');
  const [form, setForm] = useState<ScheduleForm | undefined>(opened.form);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const built = form ? scheduleSpec(form, Date.now()) : null;
  const spec = built && 'spec' in built ? built.spec : undefined;
  const next = useNextRun(spec ?? null);
  const ruleChanged = !!form && formKey(form) !== opened.key;
  const ready = !!body.trim() && (reminder || !!chatId) && (form ? !!spec && !next.error : true);

  const save = async () => {
    const chat = conversations.value.find((entry) => entry.id === chatId);
    const mentions = chat ? mentionsIn(body, chat) : [];
    setBusy(true);
    try {
      if (!schedule) {
        await rpc.call('messages.schedule', { conversationId: chatId, body: body.trim(), spec: spec!, mentions, ...(level !== 'normal' ? { priority: level } : {}) });
        pushToast({ title: 'Message scheduled', tone: 'info' }, 3000);
      } else {
        const params = editParams(schedule, { body, level, conversationId: chatId || undefined, spec: ruleChanged ? spec : undefined, mentions });
        if (params) await rpc.call('schedules.update', params);
      }
      props.onClose();
    } catch (error) { setFailure(errorText(error)); } finally { setBusy(false); }
  };

  const owner = schedule && schedule.ownerId !== HUMAN_ID ? agentName(schedule.ownerId) : undefined;
  return (
    <>
      <div class="scheduled-edit">
        {reminder
          ? <p class="field-label">{`Wakes ${owner ?? 'its agent'} with this note at its time; it is not posted in a chat.`}</p>
          : <>
            <span class="field-label">Chat</span>
            <Select label="Chat" value={chatId} options={options.length ? options : [{ value: '', label: 'No chat yet' }]} onChange={setChatId} />
          </>}
        <label class="field-label" for="scheduled-text">{reminder ? 'Note' : owner ? `Text (posted as ${owner})` : 'Text'}</label>
        <textarea id="scheduled-text" class="input scheduled-text" rows={4} maxLength={100_000} value={body}
          onInput={(event) => setBody((event.currentTarget as HTMLTextAreaElement).value)} />
        {!reminder && <>
          <span class="field-label">Level</span>
          <Segmented label="Level" value={level} options={LEVELS} onChange={setLevel} />
        </>}
        <span class="field-label">When</span>
        {form
          ? <ScheduleBar form={form} editing={!!schedule} next={next} onChange={(patch) => setForm({ ...form, ...patch })} />
          : <div class="schedule-row">
            <p class="schedule-line scheduled-kept">{`${ruleLine(schedule!.spec, { tz: schedule!.spec.tz || localZone() })} – kept as it is`}</p>
            <button type="button" class="chip" onClick={() => setForm(defaultForm(Date.now(), localZone()))}>New rule</button>
          </div>}
      </div>
      <DialogActions message={failure} tone="error">
        <Button variant="secondary" class="small" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" class="small" busy={busy} disabled={!ready} onClick={() => void save()}>{schedule ? 'Save' : 'Schedule'}</Button>
      </DialogActions>
    </>
  );
}

export function ScheduleDialog(props: { target: ScheduleTarget | null; onClose: () => void }) {
  const { target } = props;
  const title = target === 'new' ? 'New scheduled message' : target?.kind === 'reminder' ? 'Edit reminder' : 'Edit scheduled message';
  return (
    <Dialog open={target !== null} onClose={props.onClose} title={title} width={560} class="anchored">
      {target && <Editor key={target === 'new' ? 'new' : target.id} target={target} onClose={props.onClose} />}
    </Dialog>
  );
}
