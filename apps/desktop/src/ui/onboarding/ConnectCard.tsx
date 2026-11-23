// The first run's Connect card (opened from the choice card, ChoiceCard.tsx in FirstRun.tsx, or at once for a company started from the
// company menu's "+ › Connect with an ID"): the PCs on this network and "Connect with an ID" – the rows of Settings › Devices
// (settings/connect-rows.tsx). Owner 21.11.2026: no ID of its own here – a company that is still being set up has none yet
// (Eine-ID addendum 22.11.2026: nor does it take requests). Eine-ID: no role to pick – a company's ID makes this PC a new
// member there, a person's own ID one of that person's devices; the PC asked decides. Both screens show the same code;
// the person accepts on the PC that was asked. Once the link stands the runtime ends the first run (onboarding step
// 'done'); this card closes with it. Back returns to the choice card.
// Owns: this card. Never: copies data from the other PC or says it will, or ends the first run itself.

import { useEffect, useState } from 'preact/hooks';
import { can } from '../lib/session.ts';
import { settings } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { ConnectRow, NearbyRows, useConnectState } from '../settings/connect-rows.tsx';
import { Card } from './parts.tsx';

/** `onClose`: back to the choice card (Back), or once the first run ended (the link stands). */
export function ConnectCard(props: { onClose: () => void }) {
  const { remote } = useConnectState();
  const [error, setError] = useState<string | null>(null);
  const done = settings.value?.onboarding.step === 'done';
  useEffect(() => { if (done) props.onClose(); }, [done]);
  return (
    <Card id="first-run-connect" title="Connect with an ID" actions={<Button variant="secondary" onClick={props.onClose}>Back</Button>}>
      <div class="first-run-rows">
        {can('remote.nearby') && <NearbyRows onError={setError} />}
        {can('remote.connect') && <ConnectRow remote={remote.data} error={error} onError={setError} />}
      </div>
    </Card>
  );
}
