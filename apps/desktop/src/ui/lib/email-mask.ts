// 24.11.2026 (demo run of Autark 0.3.18 in a fresh company): the model setup – the first run's AI card and Settings ›
// Models (settings/ModelSetup.tsx) – listed every plan login's e-mail address in full ("Found: Claude Code (…) – use in
// this company?", the account row's hint line), awkward on a shared screen, in a demo or a screenshot. Shown masked
// instead: the local part's first letter, "…", the domain ("s…@gmail.com"); where two addresses on one screen would read
// alike, each keeps as many leading letters as tells them apart. The whole address stays one hover away (the row's title).
// Owns: the masking rule. Never: the stored address, what agents or logs see, or the rail's plan names (shared/model/plan-names.ts).

const ELLIPSIS = '…';

function parts(email: string): { local: string; domain: string } | undefined {
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return undefined;
  return { local: value.slice(0, at), domain: value.slice(at + 1) };
}

/** "s…@gmail.com": the first `keep` letters of the local part (never all of a longer one), "…", the domain; no address: as given. */
export function maskEmail(email: string, keep = 1): string {
  const split = parts(email);
  if (!split) return email.trim();
  const shown = Math.max(1, Math.min(keep, split.local.length - 1));
  return `${split.local.slice(0, shown)}${ELLIPSIS}@${split.domain}`;
}

/**
 * The mask for addresses shown together: each keeps the fewest leading letters (at least one) whose mask no other address
 * on the list shares – two that still read alike then show in full. An address not on the list gets the one-letter mask.
 */
export function emailMasker(emails: ReadonlyArray<string | undefined>): (email: string) => string {
  const key = (email: string) => email.trim().toLowerCase();
  const unique = new Map<string, string>(); // the first spelling of each address
  for (const email of emails) if (email && parts(email) && !unique.has(key(email))) unique.set(key(email), email.trim());
  const all = [...unique.values()];
  const masks = new Map<string, string>();
  for (const email of all) {
    const others = all.filter((other) => key(other) !== key(email));
    const length = parts(email)!.local.length;
    const clash = (keep: number) => others.some((other) => key(maskEmail(other, keep)) === key(maskEmail(email, keep)));
    let keep = 1;
    while (clash(keep) && keep < length) keep += 1;
    masks.set(key(email), clash(keep) ? email : maskEmail(email, keep));
  }
  return (email: string) => masks.get(key(email)) ?? maskEmail(email);
}
