// Connecting devices (Settings › Devices): PCs on this network are listed directly; a PC further
// away is found by an ID (over the meeting server) or a typed address. Both screens show the
// same 4-digit code; the person on the other PC accepts. Eine-ID (owner 22.11.2026): the ID typed decides how the
// requester joins, nobody picks a role – the company's ID (one per company; every member's PC shows it and accepts)
// makes it a new member (wire role 'employee', a person of the organisation, people/*), my ID (one per person) makes it
// one of my own devices (wire role 'ceo': everything the same). Either side may name the new member; one name is enough.
// Phones scan the pwa.link QR code (CEO) or a person's invite (people.invite, employee).
// F17 (16.11.2026): a request waiting on one of my other PCs shows here too (`via`, remote/mirror.ts); Accept there goes
// to that PC. F13: Accept may name a new person (`newPerson`) – the person is made when the device links, in one step.
// F09: a PC on this network names its company (`company`), so Settings › Devices lists a PC's companies under it.
// A Remote ID's ninth digit is a Luhn check digit of the first eight (luhnDigit/validRemoteId – the PC's runtime/remote/
// id.ts and the iPhone web app's ui/hosted read the same rule), so a typo is caught before anything is sent.
// Owns: the shapes shared by runtime and UI for this flow, the Remote ID's check digit, the remote.* methods and the
// remote.updated event (augmenting Methods / EventMap).
// Never: carries keys, tickets, session secrets or tokens.

import type { PersonRole } from './people.ts';

/** Luhn check digit for a string of digits. */
export function luhnDigit(payload: string): string {
  let sum = 0;
  for (let index = 0; index < payload.length; index++) {
    let digit = Number(payload[payload.length - 1 - index]);
    if (index % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/** True for 9 digits whose last one is the Luhn check digit of the first eight. */
export function validRemoteId(digits: string): boolean {
  return /^\d{9}$/.test(digits) && luhnDigit(digits.slice(0, 8)) === digits[8];
}

/** How a device joins (decided by the PC asked, from the ID typed): one of my own devices ('ceo', everything the same) or a new member of the company ('employee', a person). */
export type JoinRole = 'ceo' | 'employee';

/** This installation as other PCs find it. */
export interface RemoteSelf {
  deviceId: string;
  name: string;
  /** 9 digits, derived from this PC's public key – the phone QR's ID and what older PCs type; Settings shows companyId and myId. */
  remoteId: string;
  /**
   * Eine-ID: the company's ID (9 digits) – the same on every member's PC; typing it makes a new member. Owner 22.11.2026
   * ("erst nachdem man mit einer Firma connected ist … erst wenn man dieses erste Startmenü fertig gemacht hat"): both IDs
   * exist only once this is a company – its first run is done (set up, or connected to a company or to my other PC);
   * absent before, and the PC is not findable then.
   */
  companyId?: string;
  /** Eine-ID: my own ID (9 digits) – the same on all my devices; typing it makes one of my devices. Absent like companyId. */
  myId?: string;
  /** Review 22.11.2026: this PC is a member's (it has an employer) – a new member's person is made by the company, so Accept here only names them. */
  member?: true;
  fingerprint: string;
  /** Other PCs can find this PC and ask to connect (settings.devices.findable). */
  findable: boolean;
}

/** A PC asking this PC to connect, waiting for this PC's person; role 'phone' (B-078) is the owner's phone app. */
export interface RemoteIncoming {
  id: string;
  role: JoinRole | 'phone';
  deviceId: string;
  name: string;
  /** Its Remote ID (derived from its key) and fingerprint – public values. */
  remoteId: string;
  fingerprint: string;
  /** The code both screens show; accept only when they are the same. */
  code: string;
  /** Where the request came from (empty when it came through this PC's own loopback). */
  address?: string;
  expiresAt: number;
  /** F17: the request waits on this other PC of mine (Accept here answers there); absent = it waits on this PC. */
  via?: { deviceId: string; name: string };
  /** Eine-ID: the name the new member gave themselves (plain text, ≤ 80); Accept may keep or change it. */
  proposedName?: string;
}

/** F13: the person Accept makes for an employee's PC or phone (people.save) – made when that device links, as them. */
export interface NewPerson {
  name: string;
  title?: string;
  /** Their manager: an agent or a person (people/manager.ts). */
  managerId?: string;
  /** F13: 'ceo' – a second CEO beside the owner (shared/model/people.ts); absent = a member. */
  role?: PersonRole;
}

/** This PC's own request to another PC (one at a time). */
export interface RemoteOutgoing {
  id: string;
  /** Eine-ID: decided by the PC asked from the ID typed; absent until it answered. */
  role?: JoinRole;
  /** Eine-ID: the company the PC asked answers for (plain text) – "Joining Dojo as a new member". */
  company?: string;
  /** Eine-ID: the name this side proposes for itself as a new member (remote.name). */
  myName?: string;
  deviceId: string;
  name: string;
  remoteId: string;
  fingerprint: string;
  code: string;
  /**
   * Review 22.11.2026 (H1): 'confirm' – the PC asked answers that this PC would become one of `person`'s devices (a full
   * mirror both ways); nothing goes on until this side says yes (remote.confirm) or cancels.
   */
  status: 'confirm' | 'waiting' | 'accepted' | 'declined' | 'expired' | 'failed' | 'cancelled';
  /** Review 22.11.2026: whose devices this PC would join (the other PC's person, plain ≤ 80) – with role 'ceo'. */
  person?: string;
  /** Why it ended (declined, expired, the other PC unreachable …). */
  reason?: string;
  expiresAt: number;
}

/** What Settings › Devices shows (remote.state; `remote.updated` carries changes). */
export interface RemoteState {
  self: RemoteSelf;
  incoming: RemoteIncoming[];
  outgoing?: RemoteOutgoing;
}

/** A PC on this network that accepts requests (LAN hello answer). */
export interface NearbyPc {
  deviceId: string;
  name: string;
  /** Its 9-digit Remote ID. */
  remoteId: string;
  fingerprint: string;
  /** Base URLs it answered on (http://<ip>:<port>). */
  addresses: string[];
  /** F09: the company this answer is (one PC holds several; each has its own key and Remote ID); absent from older PCs. */
  company?: string;
  /** Eine-ID: that company's ID – Connect on the row asks with it (a new member); absent from older PCs (then remoteId). */
  companyId?: string;
  /** 'new' not linked yet, 'linked' already linked, 'waiting' this PC's request to it is open. */
  state: 'new' | 'linked' | 'waiting';
}

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: this PC (name, Remote ID, fingerprint, findable), PCs asking here, and this PC's own request. */
    'remote.state': { params: void; result: RemoteState };
    /**
     * Owner: connect by an ID or address ("203.0.113.5", "pc.example.org:47812"). Eine-ID: the PC asked decides from the ID –
     * its company's ID (or its own device ID): a new member; its person's ID: one of my devices. `name`: the name I propose as a new member.
     */
    'remote.connect': { params: { target: string; name?: string }; result: RemoteOutgoing };
    /** Review 22.11.2026 (H1): yes to becoming one of the other person's devices (outgoing status 'confirm'); the request goes on. */
    'remote.confirm': { params: void; result: RemoteOutgoing };
    /** Eine-ID: changes the name I propose while my request waits (the other side shows it at once). */
    'remote.name': { params: { name: string }; result: { ok: true } };
    /** Owner: cancels this PC's open request, or closes its last outcome. */
    'remote.cancel': { params: void; result: { ok: true } };
    /**
     * Owner: accept or decline a request waiting on this PC or (F17) on another of my PCs (`via`); an employee's PC needs
     * the person it belongs to – `personId`, or `newPerson` to make them (F13); a phone takes either too (none = mine).
     */
    'remote.decide': { params: { id: string; accept: boolean; personId?: string; newPerson?: NewPerson }; result: { ok: true } };
    /** Owner: PCs on this network that accept requests (self excluded); `refresh` asks the network again. */
    'remote.nearby': { params: { refresh?: boolean } | void; result: NearbyPc[] };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** A PC asks this PC to connect, a request was decided, or this PC's own request changed (topic: system, owner). */
    'remote.updated': RemoteState;
  }
}
