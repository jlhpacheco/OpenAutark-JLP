// Feedback 16.11.2026 (F20, owner; Mika's UX pass): one agent's own Stop – icon and the word, so it reads without
// hover and on touch. While runs.cancel goes out and until the run's row goes it says "Stopping…"; a failure says
// why in a toast and offers Stop again. Used at the end of each line of the chat's live bar (F21, LiveBar.tsx – a run
// on another of the person's PCs too: runs.cancel forwards it) and on an agent's Work card (team/WorkNow.tsx).
// 20.11.2026 (2F66178A): in a chat's line it names that line's agent and chat too, so the runtime stops what the line
// shows even when its run id is a moment behind (rpc/handlers/org.ts stopShown). A Stop that went through while its line
// still shows after AGAIN_MS offers Stop again (the button lives only while its run is shown: a run that goes takes it along).
// Owns: that button. Never: stops another run than its own, or all agent work (shell/work-stop.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { Icon } from '../lib/ui.tsx';

/** After a Stop went through, its line still showing this long offers Stop again. */
export const AGAIN_MS = 5_000;

/** `shown`: the chat's line this Stop sits in (its agent and chat) – a run that is over by then stops that agent's run the chat shows now. */
export function StopRun(props: { runId: string; name: string; class?: string; shown?: { agentId: string; chatId: string } }) {
  const [stopping, setStopping] = useState(false);
  const again = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(again.current), []);
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await rpc.call('runs.cancel', { runId: props.runId, ...props.shown });
      again.current = setTimeout(() => setStopping(false), AGAIN_MS);
    } catch (err) { toastError(err, `Could not stop ${props.name}`); setStopping(false); }
  };
  return (
    <button type="button" class={`stop-run${props.class ? ` ${props.class}` : ''}`} aria-busy={stopping || undefined} disabled={stopping}
      title={`Stop ${props.name} now – others keep working`} aria-label={stopping ? `Stopping ${props.name}` : `Stop ${props.name}`} onClick={() => void stop()}>
      <Icon name="stop-circle" size={14} />
      <span>{stopping ? 'Stopping…' : 'Stop'}</span>
    </button>
  );
}
