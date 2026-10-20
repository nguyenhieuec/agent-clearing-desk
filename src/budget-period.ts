import type { AgentKey, BudgetPeriod } from './types.ts';

export const BUDGET_PERIODS: BudgetPeriod[] = ['none', 'daily', 'monthly'];

/** The UTC day (2026-10-21) or month (2026-10) a period-limited budget counts toward; '' for no reset. */
export function periodKey(period: BudgetPeriod, now: number): string {
  if (period === 'none') return '';
  const iso = new Date(now).toISOString();
  return period === 'daily' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** When the current period ends (epoch ms), or null when the budget never resets. */
export function periodResetsAt(period: BudgetPeriod, now: number): number | null {
  if (period === 'none') return null;
  const d = new Date(now);
  return period === 'daily'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Spend in the current period: a stored spend from an earlier day or month no longer counts. */
export function currentSpend(key: Pick<AgentKey, 'spent_mc' | 'budget_period' | 'period_key'>, now: number): number {
  return key.period_key === periodKey(key.budget_period, now) ? key.spent_mc : 0;
}
