// The work plan agent turns prefer (shared/model/model-guide.ts effectiveWorkPlan over the Work use and the accounts – the
// router and the models.list tool read it here; helper calls never do).
// Owns: that rule. Never: routes, or writes settings.

import type { RuntimeServices } from '../contracts.ts';
import { effectiveWorkPlan } from '../../shared/model/model-guide.ts';
import { useValue } from '../../shared/model/models-uses.ts';

/** The plan provider agent turns prefer now ('claude' by default while a Claude Code plan login is enabled); undefined = none. */
export function workPlanOf(s: Pick<RuntimeServices, 'settings' | 'accounts'>): string | undefined {
  let work: string | undefined;
  try { work = useValue(s.settings.get().routing, 'work'); } catch { work = undefined; }
  let accounts: ReturnType<RuntimeServices['accounts']['list']> = [];
  try { accounts = s.accounts.list(); } catch { accounts = []; }
  return effectiveWorkPlan(work, accounts).plan;
}
