// Owns: loopback policy for isolated runtime profiles; does not change stored settings.
export function loopbackOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WORKFORCE_TEST_DATA) && env.WORKFORCE_TEST_LAN !== '1';
}
