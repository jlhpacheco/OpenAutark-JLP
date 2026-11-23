// 23.11.2026 (task_pkzytj9m): the Claude plan row's block under the extra-usage switch – the plan's monthly API credits (or an API
// key as reserve, settings/api-credits.ts): a password field whose key goes straight into the encrypted catalog as an Anthropic key
// account (accounts.add; the field empties at once, the key is never shown again – only "Key stored ✓", Replace and Remove), and
// "Let the AI set it up", which gives the personal manager a to-do (accounts.setupCredits).
// Owns: this block. Never: shows, logs or keeps a key after it was handed over.

import { useState } from 'preact/hooks';
import type { Account } from '../../shared/model/providers.ts';
import { confirm } from '../lib/dialog.tsx';
import { rpc } from '../lib/rpc.ts';
import { accounts } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { useBusy } from './controls.tsx';
import { apiCreditsView, creditsKeyLabel, creditsKeyOf, SETUP_LABEL } from './api-credits.ts';

export function ApiCredits(props: { account: Account }) {
  const { account } = props;
  const [busy, run] = useBusy();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const stored = creditsKeyOf(account, accounts.value);
  const view = apiCreditsView(account, Boolean(stored) && !replacing);
  if (!view) return null;
  const save = () => {
    const apiKey = key.trim();
    setKey(''); // out of the field at once – it lives only in the catalog from here on
    if (!apiKey) return;
    void run(async () => {
      if (stored) await rpc.call('accounts.remove', { id: stored.id });
      const added = await rpc.call('accounts.add', { provider: 'anthropic', label: creditsKeyLabel(account), apiKey });
      if (view.monthly) await rpc.call('accounts.update', { id: added.id, credits: true });
      setReplacing(false);
      pushToast({ title: 'API key stored', body: 'It is kept encrypted and never shown again.' });
    });
  };
  const remove = async () => {
    if (!stored) return;
    if (await confirm({ title: `Remove the API key of ${account.label}?`, body: 'The key leaves this company. The plan itself stays.', confirmLabel: 'Remove', danger: true })) {
      await run(() => rpc.call('accounts.remove', { id: stored.id }));
    }
  };
  const setup = () => void run(async () => {
    const handed = await rpc.call('accounts.setupCredits', { id: account.id });
    pushToast({ title: 'Handed to your manager', body: `${handed.assignee} sets it up and asks you only for a step only you can do.` });
  });
  const editing = !stored || replacing;
  return (
    <div class="account-api-credits">
      <div class="account-api-credits-title">{view.title}</div>
      <div class="account-extra-hint">{view.hint}</div>
      {editing ? (
        <form class="account-api-credits-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <input class="input" type="password" autocomplete="off" spellcheck={false} aria-label={`API key for ${account.label}`}
            placeholder="sk-ant-api…" value={key} disabled={busy} onInput={(event) => setKey((event.target as HTMLInputElement).value)} />
          <Button class="small" type="submit" disabled={busy || !key.trim()}>Save</Button>
          <Button variant="ghost" class="small" type="button" disabled={busy} onClick={setup}>{SETUP_LABEL}</Button>
          {replacing && <Button variant="ghost" class="small" type="button" disabled={busy} onClick={() => { setKey(''); setReplacing(false); }}>Cancel</Button>}
        </form>
      ) : (
        <div class="account-api-credits-form">
          <Button variant="ghost" class="small" disabled={busy} onClick={() => setReplacing(true)}>Replace</Button>
          <Button variant="ghost" class="small" disabled={busy} onClick={() => void remove()}>Remove</Button>
        </div>
      )}
    </div>
  );
}
