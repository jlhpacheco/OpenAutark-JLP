// Stable JSON (B-078): sorted keys, JSON.stringify for every leaf – the form the connect request's MACs and transcripts
// sign. The PC (runtime/devices/pair-proof.ts, runtime/remote/sas.ts), the iPhone web app (ui/hosted/sas.ts) and
// Android's RemotePair.java must agree on it byte for byte (test/unit/hosted/crypto.test.ts holds the shared vector).
// Owns: that form. Never: hashing, keys or I/O.

/** A stable JSON form (sorted keys) for MACs and transcripts. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
