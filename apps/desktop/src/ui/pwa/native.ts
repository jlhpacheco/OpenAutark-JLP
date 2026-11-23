// The page inside one of Autark's phone apps: the Android app (apps/android: its WebView adds "AutarkAndroid/" to the
// user agent) or the iPhone web app (the website's shell, window.autarkHosted – pwa/hosted.ts). What the web UI does
// differently there – no "Install app" row, Back from the app's own Back (window.autarkBack, back.ts; the iPhone app
// calls it from an edge swipe), and "Forget this phone" (Settings › Devices since B-084): the Android app takes it over
// its port (native-port.ts) or, before the port is there, intercepts the autark-app: address, and asks before it clears
// this company's pairing; the iPhone app asks, then clears its own. The apps have no toolbar of their own, so the phone
// looks like the web UI. Feedback 16.11.2026 F15: Pair again opens the Android app's pairing over this company instead
// of forgetting it first; when the PC refuses this page's token (a socket that opened closes
// with 4401), the Android app hears {t:'refused'} and tries the next PC of the company that has not refused in this
// link session, then sends 'resume' (19.11.2026: also on 4404, a PC that does not know the token; the page says either in its
// status line, never on a screen of its own – shell/connection-line.ts). The feedback video
// (F15, "so ein Video …, was einem zeigt, wie man da Feedback macht") plays once on a new phone: the Android app shows it
// before its pairing screens, the iPhone web app on its first start after pairing (firstVideoHere).
// Owns: those facts. Never: talks to the Android app other than through the port or an autark-app: address the person
// taps (no JavaScript bridge object).

import { effect, type ReadonlySignal } from '@preact/signals';
import type { Refusal } from '../lib/refusal.ts';
import { hostedShell } from './hosted.ts';
import { onNative, sendNative } from './native-port.ts';

/** The address the app's WebView intercepts for "Forget this phone" (MainActivity / PhoneNavigation). */
export const FORGET_ADDRESS = 'autark-app:forget';

/** True inside the Autark Android app. */
export function isAndroidApp(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAutarkAndroid\//.test(agent);
}

/** True inside the iPhone web app (the website's shell loaded this PC's UI). */
export function inHostedApp(): boolean {
  return hostedShell() !== undefined;
}

/** True inside either phone app (Android or the iPhone web app). */
export function isPhoneApp(): boolean {
  return isAndroidApp() || inHostedApp();
}

/** Where the iPhone web app keeps that it played the feedback video (its origin's storage, shared by every company). */
export const VIDEO_SEEN_KEY = 'autark.feedbackVideoSeen';

type SeenStore = Pick<Storage, 'getItem' | 'setItem'>;
const pageStorage = (): SeenStore | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/**
 * True exactly once on an iPhone web app – its first start after pairing plays the feedback video (the Android app plays
 * it before its own pairing screens); false everywhere else, and when the phone's storage cannot keep that it was shown.
 */
export function firstVideoHere(hosted: boolean = inHostedApp(), storage: SeenStore | null = pageStorage()): boolean {
  if (!hosted || !storage) return false;
  try {
    if (storage.getItem(VIDEO_SEEN_KEY)) return false;
    storage.setItem(VIDEO_SEEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** "Forget this phone": the app asks, then clears its pairing and shows its connect screen. */
export function forgetThisPhone(): void {
  const hosted = hostedShell();
  if (hosted) { void hosted.forget(); return; }
  if (!sendNative({ t: 'forget' })) location.href = FORGET_ADDRESS;
}

/**
 * "Pair again" (feedback 16.11.2026 F15: it forced Forget first, a loop that destroyed a pairing that might still work):
 * the Android app opens its pairing screens over this company ('add'); a success replaces it in place and Back returns
 * to it unchanged. The iPhone web app, and an Android app before its port arrived, go the Forget way.
 */
export function pairAgain(): void {
  if (hostedShell() || !sendNative({ t: 'add' })) forgetThisPhone();
}

/** A close after which the Android app tries the company's next PC: refused (4401) or unknown there (4404) – not removed. */
const nextPc = (refused: Refusal | null): boolean => refused === 4401 || refused === 4404;

/** What reportRefusals reads of the connection (lib/rpc.ts's signals). */
export interface RefusalSource {
  status: ReadonlySignal<'connecting' | 'open' | 'closed'>;
  refused: ReadonlySignal<Refusal | null>;
}

/**
 * Inside the Android app: tells it {t:'refused'} each time a socket that opened closes refused (4401) or unknown (4404, a PC
 * the company's roster has not reached yet: 19.11.2026) – a refused socket
 * always opened, since the token goes in its first frame; a PC out of reach never opens one. Without the port yet, the
 * next port carries it. Elsewhere nothing. Returns the stop.
 */
export function reportRefusals(source: RefusalSource, android: boolean = isAndroidApp()): () => void {
  if (!android) return () => undefined;
  let was = source.status.peek();
  let owed = false;
  const send = () => { owed = !sendNative({ t: 'refused' }); };
  const stopEffect = effect(() => {
    const now = source.status.value;
    if (was === 'open' && now === 'closed' && nextPc(source.refused.peek())) send();
    was = now;
  });
  const stopPort = onNative('port', () => { if (owed && nextPc(source.refused.peek())) send(); });
  return () => { stopEffect(); stopPort(); };
}
