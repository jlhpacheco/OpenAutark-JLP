// F25 P3 (18.11.2026): the iPhone web app's half of the direct way's signalling as plain data (rtc.ts runs the try), as
// Android's relay/RtcSignal.java: reading the PC's offer (an id, SDP of at most 16 KiB, at most 32 of its candidates, and
// from its ice list only the bundled Cloudflare STUN endpoint, if offered; no default for an empty or rejected list),
// and the address filter. The PC's candidates are taken only as IP literals outside loopback, 0/8, link-local (169.254.169.254
// too), multicast, broadcast and 240/4, ::/96, 64:ff9b::/96, fe80::/10 and ff00::/8 (an IPv4-mapped address counts as its
// IPv4), UDP, port 1024 and up – never a name the browser would resolve first. This phone's own go out as the PC takes
// them (runtime/devices/rendezvous/rtc.ts allowedCandidate): the same, or an mDNS .local name (how Safari and Chromium
// name host candidates without a camera grant).
// The browser may resolve the single permitted STUN hostname, never an offer-supplied candidate name.
// Owns: these limits and filters. Never: sends anything (rtc.ts does, only on the finished pinned channel A) or logs.

import { utf8 } from './bytes.ts';

export const RTC_VERSION = 1;
export const MAX_SDP = 16 * 1024;
export const MAX_CANDIDATES = 32;
const ALLOWED_STUN = 'stun:stun.cloudflare.com:3478';
const MAX_LINE = 512;

function ip4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part) || (part.length > 1 && part[0] === '0')) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    out.push(value);
  }
  return out;
}

function ip6(text: string): number[] | undefined {
  let lower = text.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(lower)) return undefined;
  let tail: number[] | undefined;
  const dot = lower.indexOf('.');
  if (dot >= 0) { // an IPv4 tail a.b.c.d after the last colon
    const colon = lower.lastIndexOf(':');
    if (colon > dot) return undefined;
    tail = ip4(lower.slice(colon + 1));
    if (!tail) return undefined;
    lower = `${lower.slice(0, colon + 1)}0:0`;
  }
  const gap = lower.indexOf('::');
  if (gap >= 0 && lower.indexOf('::', gap + 1) >= 0) return undefined;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = gap < 0 ? lower.split(':') : split(lower.slice(0, gap));
  const rest = gap < 0 ? [] : split(lower.slice(gap + 2));
  const groups = head.length + rest.length;
  if ((gap < 0 && groups !== 8) || (gap >= 0 && groups > 7)) return undefined;
  const words = [...head, ...Array<string>(8 - groups).fill('0'), ...rest];
  const out: number[] = [];
  for (const word of words) {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return undefined;
    const value = parseInt(word, 16);
    out.push(value >> 8, value & 0xff);
  }
  if (tail) out.splice(12, 4, ...tail);
  return out;
}

const allowedV4 = (ip: number[]): boolean => !(ip[0] === 0 || ip[0] === 127 || ip[0] >= 224 || (ip[0] === 169 && ip[1] === 254));

/** An IP literal and port this phone sends checks to or names: outside loopback, 0/8, link-local (169.254.169.254 too),
 * multicast, broadcast and 240/4, ::/96, 64:ff9b::/96, fe80::/10 and ff00::/8 (an IPv4-mapped address counts as its
 * IPv4); port 1024–65535. Never a name, never a lookup. */
export function allowedAddress(host: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !host || host.length > 45) return false;
  if (!host.includes(':')) { const v4 = ip4(host); return Boolean(v4 && allowedV4(v4)); }
  const ip = ip6(host);
  if (!ip) return false;
  const zero = (count: number) => ip.slice(0, count).every((byte) => byte === 0);
  if (zero(10) && ip[10] === 0xff && ip[11] === 0xff) return allowedV4(ip.slice(12)); // ::ffff:a.b.c.d
  if (zero(12)) return false; // ::, ::1 and the IPv4-compatible range
  if ([0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0].every((byte, i) => ip[i] === byte)) return false; // 64:ff9b::/96
  if (ip[0] === 0xfe && (ip[1] & 0xc0) === 0x80) return false; // fe80::/10
  return ip[0] !== 0xff; // ff00::/8
}

function candidateParts(line: string): { address: string; port: number; type: string } | undefined {
  if (typeof line !== 'string' || line.length > MAX_LINE) return undefined;
  const parts = line.trim().replace(/^a=/, '').split(/\s+/);
  if (parts.length < 8 || !parts[0].startsWith('candidate:') || parts[2].toLowerCase() !== 'udp' || parts[6] !== 'typ') return undefined;
  if (!/^(host|srflx|prflx|relay)$/.test(parts[7])) return undefined;
  return { address: parts[4], port: Number(parts[5]), type: parts[7] };
}

/** The type of one of the PC's candidates this phone adds: UDP, an IP literal the filter passes – never a name (the
 * browser would resolve it before anything could check the address it stands for). Else undefined. */
export function pcCandidate(line: string): string | undefined {
  const parts = candidateParts(line);
  return parts && allowedAddress(parts.address, parts.port) ? parts.type : undefined;
}

/** The type of one of this phone's candidates it sends: what the PC takes (rtc.ts allowedCandidate) – UDP, an IP the
 * filter passes, or an mDNS .local name (Safari and Chromium name their host candidates so; the PC checks the address it
 * resolves to) with a port of 1024 and up. Else undefined. */
export function ownCandidate(line: string): string | undefined {
  const parts = candidateParts(line);
  if (!parts) return undefined;
  const ok = /^[a-z0-9-]{1,64}\.local$/i.test(parts.address) ? Number.isInteger(parts.port) && parts.port >= 1024 && parts.port <= 65535 : allowedAddress(parts.address, parts.port);
  return ok ? parts.type : undefined;
}

/**
 * Accept only the exact bundled STUN endpoint, if the PC offers it. A paired PC can opt out, but cannot choose
 * an arbitrary STUN destination. Do not normalize, resolve here or substitute a default.
 */
export function stunOf(ice: unknown): string[] {
  if (!Array.isArray(ice)) return [];
  for (const server of ice) {
    const urls = (server as { urls?: unknown } | null)?.urls;
    if (urls === ALLOWED_STUN || (Array.isArray(urls) && urls.includes(ALLOWED_STUN))) return [ALLOWED_STUN];
  }
  return [];
}

/** Reapply the same opt-in boundary before giving the list to the browser. */
export function rtcConfig(stun: readonly string[]): RTCConfiguration {
  const iceServers = stun.includes(ALLOWED_STUN) ? [{ urls: [ALLOWED_STUN] }] : [];
  return { iceServers, iceCandidatePoolSize: 0, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
}

/** An SDP without its candidate lines (they travel one by one through the filter). */
export const withoutCandidates = (sdp: string): string =>
  sdp.split(/\r?\n/).filter((line) => line && !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates').map((line) => `${line}\r\n`).join('');

/** The candidate lines of an SDP (without "a="). */
export const candidatesOf = (sdp: string): string[] => sdp.split(/\r?\n/).filter((line) => line.startsWith('a=candidate:')).map((line) => line.slice(2));

export interface Offer { id: string; sdp: string; candidates: string[]; mid: string; stun: string[]; dropped: number }

export const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** The PC's offer as this phone takes it, or undefined (another version, no id, SDP missing or past 16 KiB). */
export function readOffer(message: Record<string, unknown>): Offer | undefined {
  const { id, sdp } = message;
  if (message.op !== 'offer' || message.v !== RTC_VERSION || !validId(id) || typeof sdp !== 'string' || utf8(sdp).length > MAX_SDP) return undefined;
  const candidates: string[] = [];
  let dropped = 0;
  for (const line of candidatesOf(sdp)) {
    if (candidates.length < MAX_CANDIDATES && pcCandidate(line)) candidates.push(line);
    else dropped++;
  }
  const mid = /^a=mid:(\S{1,32})$/m.exec(sdp.replace(/\r/g, ''))?.[1] ?? '0';
  return { id, sdp: withoutCandidates(sdp), candidates, mid, stun: stunOf(message.ice), dropped };
}
