/** Untrusted launcher input is validated by the JS boundary. */
export function testNetworkEnv(
  profile: unknown,
  overrides?: NodeJS.ProcessEnv | null,
  policy?: { inherited?: NodeJS.ProcessEnv; lan?: unknown; discovery?: unknown },
): NodeJS.ProcessEnv & { WORKFORCE_TEST_DATA: string; WORKFORCE_TEST_LAN: '0' | '1' };
