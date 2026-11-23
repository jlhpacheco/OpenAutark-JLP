// Migration 95 (08.11.2026, B-083 plan credits): an API key whose organisation holds the monthly API credits a plan
// includes (Claude Max/Ultra, ChatGPT Pro/Business) – `credits` 1 makes routing and booking treat it like a plan
// (shared/model/charge.ts accountCharge). 0 for every account until the person switches it on.
// Owns: this column. Never: a credit balance (no provider offers one to read).

export const sql = /* sql */ `
ALTER TABLE accounts ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
`;
