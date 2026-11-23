// Settings › Security › Waiting requests (owner 19.11.2026: "Er kann entweder akzeptieren für dieses Mal oder halt
// standardmäßig diese Einstellung akzeptieren oder diesen Ort standardmäßig akzeptieren"): the approval requests still
// waiting for the person (security.requests) – who, what, which switch holds it – with the to-do's answers (Allow once,
// Always: <switch>, Always: <place>, Decline) sent to security.answer. Each request is also a to-do on the Tasks page; the list
// loads again on the to-do and settings events and after a reconnect (never on a timer), so an answer given there
// leaves here too.
// Owns: this group. Never: decides a request (the runtime does), or posts a chat line.

import { useEffect, useState } from 'preact/hooks';
import type { ApprovalRequest } from '../../shared/api/methods-security-mode.ts';
import type { ApprovalAnswer } from '../../shared/model/security-settings.ts';
import { SECURITY_LABELS } from '../../shared/model/security-settings.ts';
import { fullDate, logTime } from '../lib/format.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { Button } from '../lib/ui.tsx';
import { act, Group, Note, Row } from './controls.tsx';
import { answerOptions } from './security-model.ts';

/** The waiting requests, or null where this session may not read them; reloads on the events that can change them. */
function useRequests(): [ApprovalRequest[] | null | undefined, () => void] {
  const [list, setList] = useState<ApprovalRequest[] | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    rpc.call('security.requests').then((next) => { if (live) setList(next); }, () => { if (live) setList(null); });
    return () => { live = false; };
  }, [tick]);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const offs = [rpc.on('task.upserted', again), rpc.on('task.removed', again), rpc.on('settings.updated', again), rpc.onOpen(again)];
    return () => { for (const off of offs) off(); };
  }, []);
  return [list, () => setTick((n) => n + 1)];
}

function RequestRow(props: { request: ApprovalRequest; answerable: boolean; onAnswered: () => void }) {
  const { request } = props;
  const [busy, setBusy] = useState<ApprovalAnswer | null>(null);
  const answer = (choice: ApprovalAnswer) => {
    if (busy) return;
    setBusy(choice);
    void act(() => rpc.call('security.answer', { id: request.id, answer: choice }), 'Could not answer the request')
      .finally(() => { setBusy(null); props.onAnswered(); });
  };
  const hint = <>{SECURITY_LABELS[request.capability]} · <span title={fullDate(request.at)}>{logTime(request.at)}</span></>;
  return (
    <Row label={<span class="sec-request-what" title={request.summary}><b>{request.agentName}</b> {request.summary}</span>} hint={hint} reserve stack class="sec-request">
      {props.answerable
        ? (
          <span class="sec-request-answers">
            {answerOptions(request).map((option) => (
              <Button key={option.answer} variant={option.answer === 'once' ? 'primary' : option.answer === 'decline' ? 'ghost' : 'secondary'}
                class="small sec-answer" title={option.title ?? option.label} busy={busy === option.answer} disabled={busy !== null}
                onClick={() => answer(option.answer)}>
                {option.label}
              </Button>
            ))}
          </span>
        )
        : <Note>Waiting for an answer on the PC</Note>}
    </Row>
  );
}

export function RequestsGroup() {
  const [list, reload] = useRequests();
  if (list === null) return null; // this session may not read them
  const answerable = can('security.answer');
  return (
    <Group title="Waiting requests" hint="What an agent needs that is closed now. Each also waits on the Tasks page; an answer there or here counts once.">
      {!list?.length
        ? <Row label="" stack><Note>{list ? 'Nothing is waiting.' : ''}</Note></Row>
        : list.map((request) => <RequestRow key={request.id} request={request} answerable={answerable} onAnswered={reload} />)}
    </Group>
  );
}
