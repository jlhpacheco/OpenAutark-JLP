// Owns: feedback 16.11.2026 F10/F11 – a confirmed send closes the feedback form at once and the status line says
// "Feedback sent · No. …" for 4 s; a saved, failed or held report keeps the form's result line (src/ui/feedback/delivery.ts).
// Never: renders the form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '../../../src/ui/lib/rpc.ts';
import { toasts } from '../../../src/ui/lib/toasts.ts';
import { SENT_TOAST_MS, announceSent, closesAtOnce, heldText, notSentLine, sentText } from '../../../src/ui/feedback/delivery.ts';

test('only a confirmed send closes at once; saved, queued or failed reports keep the result line', () => {
  assert.equal(closesAtOnce({ status: 'sent' }, null), true);
  assert.equal(closesAtOnce({ status: 'sent' }, 'The mailbox did not answer.'), false, 'an error stays readable');
  for (const status of ['local', 'draft', 'queued', 'received', 'dismissed'] as const) assert.equal(closesAtOnce({ status }, null), false, status);
  assert.equal(closesAtOnce(null, null), false);
});

test('the sent toast: one short line with the report number, gone after 4 s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(sentText({ receiptId: '6f9619ff-8b86-4011-b42d-00cf4fc964ff' }), 'Feedback sent · No. 6F9619FF');
  assert.equal(sentText({}), 'Feedback sent');
  assert.equal(SENT_TOAST_MS, 4000);
  toasts.value = [];
  announceSent({ receiptId: '6f9619ff-8b86-4011-b42d-00cf4fc964ff' });
  assert.deepEqual(toasts.value.map((toast) => toast.title), ['Feedback sent · No. 6F9619FF']);
  t.mock.timers.tick(3999);
  assert.equal(toasts.value.length, 1);
  t.mock.timers.tick(1);
  assert.equal(toasts.value.length, 0);
});

test('a held report says where it waits; a send the PC will repeat by itself says so', () => {
  assert.equal(heldText('phone'), 'Saved on this phone – it goes by itself as soon as there is a connection.');
  assert.equal(heldText('browser'), 'Saved in this browser – it goes by itself as soon as there is a connection.');
  assert.equal(heldText('window'), 'Saved in this window – it goes by itself as soon as there is a connection.');
  for (const reason of ['offline', 'timeout', 'server']) {
    assert.equal(notSentLine(new RpcError({ code: 'unavailable', message: 'x', details: { reason } })), 'Not sent yet – it goes by itself when the connection is back.');
  }
  assert.equal(notSentLine(new RpcError({ code: 'unavailable', message: 'The mailbox refused the report.', details: { reason: 'refused' } })), 'The mailbox refused the report.');
});
