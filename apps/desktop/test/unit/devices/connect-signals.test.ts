// B-084 (devices/connect-signals.ts): host 'online' sends this PC to the meeting server at once like resume/unlock, and a
// connect request's notice carries the route to Settings › Devices, which the 'notify' event and the push channels keep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICES_ROUTE, connectNotice, nudgesMeeting } from '../../../src/runtime/devices/connect-signals.ts';
import { Notifications } from '../../../src/runtime/notify/service.ts';
import type { RemoteIncoming } from '../../../src/shared/model/remote.ts';
import { ManualClock, recordingBus, silentLog } from './fakes.ts';

test('online, resume and unlock nudge the meeting server; suspend and lock do not', () => {
  assert.deepEqual((['resume', 'unlock', 'online', 'suspend', 'lock'] as const).filter(nudgesMeeting), ['resume', 'unlock', 'online']);
});

test('a connect request\'s notice opens Settings › Devices, on the event and on every push channel', () => {
  const view = { name: 'Pixel', code: '123', role: 'phone' } as RemoteIncoming;
  const notice = connectNotice(view);
  assert.equal(notice.route, '#/settings/devices');
  assert.equal(DEVICES_ROUTE, '#/settings/devices');
  assert.match(notice.title, /^Phone Pixel asks to connect · code 123$/);
  assert.equal(connectNotice({ ...view, role: 'employee', name: 'Tower' } as RemoteIncoming).body, 'As a new member. Accept in Settings › Devices if Tower shows the same code.');

  const { bus, events } = recordingBus();
  const settings = { get: () => ({ notifications: { enabled: true, sound: true, pushFor: [] } }) };
  const service = new Notifications({ bus, host: { notify: async () => true }, settings: settings as never, clock: new ManualClock(), log: silentLog });
  const pushed: unknown[] = [];
  service.addChannel((message) => { pushed.push(message); });
  service.notify(notice);
  assert.equal((events.find((entry) => entry.event === 'notify')?.data as { route?: string }).route, DEVICES_ROUTE);
  assert.equal((pushed[0] as { route?: string }).route, DEVICES_ROUTE);
});
