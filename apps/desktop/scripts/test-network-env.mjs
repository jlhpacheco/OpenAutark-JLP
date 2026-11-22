import { isIPv4 } from 'node:net';

const controlled = new Set([
  'WORKFORCE_TEST_DATA','WORKFORCE_TEST_LAN','WORKFORCE_DISCOVERY_TARGETS','WORKFORCE_INSTALLER_LOOPBACK_POLICY',
]);

function clean(source) {
  return Object.entries(source ?? {}).filter(([key]) => !controlled.has(key.toUpperCase()));
}

/** Network opt-ins must belong to the invocation, never to the parent shell or an env spread. */
export function testNetworkEnv(profile, overrides, { inherited = process.env, lan = false, discovery } = {}) {
  if (typeof profile !== 'string' || !profile.trim() || profile.includes('\0')) throw TypeError('Explicit test profile required.');
  let targets;
  if (discovery !== undefined) {
    if (typeof discovery !== 'string') throw TypeError('Discovery requires IPv4 loopback literals.');
    const parts=discovery.split(',').map(a=>a.trim());
    if (parts.some(a=>!isIPv4(a)||!a.startsWith('127.'))) throw TypeError('Discovery requires IPv4 loopback literals.');
    targets=parts.join(',');
  }
  return Object.fromEntries([
    ...clean(inherited), ...clean(overrides),
    ['WORKFORCE_TEST_DATA',profile], ['WORKFORCE_TEST_LAN',lan===true?'1':'0'],
    ...(targets===undefined?[]:[['WORKFORCE_DISCOVERY_TARGETS',targets]]),
  ]);
}
