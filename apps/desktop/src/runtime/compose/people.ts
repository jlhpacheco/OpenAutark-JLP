// Composition of the people of the organisation (F-52, called by compose/network.ts once phone
// access exists): the PeopleService on the database, settings and the runtime's services, the
// address people open (pwa/service.ts phoneUrl: https / LAN / tailnet first, this PC's loopback as
// the last resort, marked not reachable) and the QR renderer. B-078 (D5): no phone switch gates people
// any more – a person gets in while their accepted device row and token live.
// Owns: this wiring. Never: behaviour, timers or polling.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/people.ts';
import { PeopleService } from '../people/service.ts';
import { phoneUrl, type PwaService } from '../pwa/service.ts';

export function createPeople(s: RuntimeServices, pwa: Pick<PwaService, 'urls'>, qr: (text: string) => Promise<string>): PeopleService {
  const people = new PeopleService({
    db: s.db, clock: s.clock, bus: s.bus, log: s.log, settings: s.settings,
    services: () => s,
    address: () => {
      const urls = pwa.urls();
      const best = phoneUrl(urls);
      return best ? { url: best, reachable: true } : urls[0] ? { url: urls[0], reachable: false } : undefined;
    },
    qr,
  });
  people.ensureOwner();
  s.bus.on('message.created', (message) => { try { people.recordChatChange(message); } catch (error) { s.log.warn('people: chat audit failed', { error: String(error) }); } });
  s.people = people;
  return people;
}
