// Two small facts of the devices wiring (devices/connect.ts), pure so a test pins them (B-084): which host power events
// send this PC to the meeting server at once, and the notice of a connect request with the place a tap on it opens.
// Owns: the event list and the notice text with its route. Never: sends, dials, or decides about a request.

import type { NotificationInput } from '../contracts.ts';
import type { PowerEvent } from '../../shared/api/host-bridge.ts';
import type { RemoteIncoming } from '../../shared/model/remote.ts';

/** Back from sleep, unlocked, or back online (a PC that lost the internet is at the meeting server again at once). */
export const nudgesMeeting = (event: PowerEvent): boolean => event === 'resume' || event === 'unlock' || event === 'online';

/** Where a tap on a connect request's notice lands: the accept rows in Settings › Devices (ui/lib/router.ts). */
export const DEVICES_ROUTE = '#/settings/devices';

/** The notice for a connect request; `route` rides along on the 'notify' event and to the push channels (spread as is). */
export function connectNotice(view: RemoteIncoming): NotificationInput & { route: string } {
  const phone = view.role === 'phone';
  return {
    kind: 'important', title: phone ? `Phone ${view.name} asks to connect · code ${view.code}` : `${view.name} wants to connect · code ${view.code}`,
    body: `${view.role === 'employee' ? 'As a new member. ' : ''}Accept in Settings › Devices if ${phone ? 'the phone' : view.name} shows the same code.`,
    route: DEVICES_ROUTE,
  };
}
