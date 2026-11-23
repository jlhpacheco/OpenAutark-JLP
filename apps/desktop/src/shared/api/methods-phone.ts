// RPC contract part (B-078, D5/D6): the owner's Android phone as a member of the company and as hands for agents.
// Pairing: the phone types this PC's Remote ID or opens the QR's link (PHONE_PAIR_LINK + the ID – the only thing it
// carries), then the normal connect request runs (runtime/devices/rendezvous/phone-pair.ts). Phone use: the app's own
// second socket (apps/android phoneuse/UseLink) calls phoneUse.attach – the answer lists my PCs, so the phone tunnels to
// the first one online when this one is off – and then hears `phoneUse.request` (only its own: the event names its
// deviceId and reaches only that device, runtime/rpc/scopes.ts) and answers each with phoneUse.reply. The app reads
// nothing until a request asks (AccessibilityService); its bubble names the agent of the step (`by`) and shows the AI's
// line or question (op 'say', feedback 16.11.2026 F16). phoneUse.reply and phoneUse.attached are bus-only. The iPhone web
// app (ui/hosted, no phone use on iOS) asks phone.pcs for the same list without claiming phone use, and phone.forget
// removes its own row when the person taps Forget there.
// Handlers: runtime/rpc/handlers/phone-use.ts. Merged into Methods/EventMap by module augmentation.
// Owns: these shapes and the pair link's spelling. Never: behaviour.

/**
 * The QR on the PC carries only this plus the Remote ID; Android App Links open the app for it, else the site's pair
 * page shows the ID. B-084: the site is openautark.com; the old Meta Jarvis address forwards there (fragment kept) and
 * the Android app still reads QR codes of older PCs.
 */
export const PHONE_PAIR_LINK = 'https://openautark.com/pair/#';

/** The pair link of a Remote ID (9 digits). */
export function phonePairLink(remoteId: string): string {
  return `${PHONE_PAIR_LINK}${remoteId.replace(/\D/g, '')}`;
}

/** The Remote ID in a typed text or a scanned pair link ("482 913 071", "…/autark/pair/#482913071", older "…/pair#…"); undefined when none. */
export function remoteIdOfPairText(text: string): string | undefined {
  const value = text.trim();
  const hash = value.lastIndexOf('#');
  const digits = (hash >= 0 && /\/pair\/?#/.test(value) ? value.slice(hash + 1) : value).replace(/[\s-]/g, '');
  return /^\d{9}$/.test(digits) ? digits : undefined;
}

/**
 * What an agent asks the phone to do (the PhoneDriver's steps; coordinates in screen pixels). 'say' (app 0.3.15+):
 * args `{text (≤ PHONE_SAY_MAX), ask?: true, buttons?: string[]}` – the line stays in the bubble until the next say or
 * the job's end and answers `{ok: true}`; with ask the bubble adds ✓ and ✕, with buttons (owner 19.11.2026) the AI's
 * own labels – small ones beside the line, bigger ones under it – and ✕; it answers `{answer: PhoneSayAnswer}`. An
 * older app answers bad_request "Unknown step say." and shows buttons as ✓. 'done' (owner 19.11.2026, args `{}`): the
 * PC's run `job` is over, the bubble goes at once; an older app answers bad_request, which nobody waits for.
 */
export type PhoneUseOp = 'ui_tree' | 'screenshot' | 'tap' | 'swipe' | 'type' | 'key' | 'open' | 'say' | 'done';

/** The longest line the bubble shows. */
export const PHONE_SAY_MAX = 120;

/** The most buttons one question carries, and the longest label (the app keeps the same). */
export const PHONE_SAY_BUTTONS_MAX = 8;
export const PHONE_BUTTON_MAX = 40;

/** The person's answer to a question: 'yes' for ✓, 'no' for ✕, 'none' without a tap within the phone's 60 s, else the
 *  label of the button they tapped. */
export type PhoneSayAnswer = string;

export interface PhoneUseRequest {
  /** The phone the request is for (only that device hears it). */
  deviceId: string;
  id: string;
  op: PhoneUseOp;
  args: Record<string, unknown>;
  /** The PC's run this step belongs to; the phone ends exactly this job on the person's ✕ (an older phone ignores it). */
  job?: string;
  /** The agent's name: the bubble reads "<by> is using this phone" (an older phone ignores it). */
  by?: string;
}

export interface PhoneUseReply {
  id: string;
  result?: unknown;
  /** 'off' (phone use is not on, or the person has not agreed to it in the app yet), 'paused' (the person tapped Pause
   *  in the bubble), 'ended' (their ✕ ended phone use for this job), 'bad_request' (a step the app does not know), … */
  error?: { code: string; message: string };
}

/** One of my PCs as the phone keeps it (it tunnels to the first one online). */
export interface PhonePc {
  deviceId: string;
  name: string;
  fingerprint: string;
  /** base64url Ed25519 – the key the phone pins at the meeting server and checks in the handshake. */
  publicKey: string;
  /**
   * F29 stage 1: that PC's peer listener addresses (http(s) base URLs – the router's mapped one, LAN, tailnet, IPv6). The
   * Android app dials `<address>/peer/phone` directly and takes the tunnel only when none answers; absent: none known.
   */
  addresses?: string[];
}

export interface PhoneUseAttach {
  /** "Pixel 8" – shown in phone.devices. */
  model?: string;
  /** Screen size in pixels. */
  screen?: { width: number; height: number };
  /** The AccessibilityService is on (phone use can act now). */
  ready?: boolean;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** The Android app's own socket: phone use is reachable on this connection until it closes; the answer lists my PCs. */
    'phoneUse.attach': { params: PhoneUseAttach; result: { pcs: PhonePc[] } };
    /** The answer to one phoneUse.request. */
    'phoneUse.reply': { params: PhoneUseReply; result: { ok: true } };
    /** The paired phone itself (the iPhone web app, which has no phone use): my PCs it pins and tunnels to. */
    'phone.pcs': { params: void; result: { pcs: PhonePc[] } };
    /** The paired phone itself ("Forget this phone"): its own row, token and push subscriptions end, on every PC of the roster. */
    'phone.forget': { params: void; result: { ok: true } };
    /** Owner: what "Connect a phone" shows – this PC's Remote ID and the QR of its pair link. */
    'phone.pairLink': { params: void; result: { remoteId: string; url: string; qrDataUrl: string } };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** A step for one phone (reaches only the device it names). */
    'phoneUse.request': PhoneUseRequest;
    /** Bus only: a phone's answer, with the device that sent it. */
    'phoneUse.reply': PhoneUseReply & { deviceId: string };
    /** Bus only: a phone's use socket came (on) or went (off). */
    'phoneUse.attached': PhoneUseAttach & { deviceId: string; on: boolean };
  }
}
