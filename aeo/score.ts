import type { CheckResult, LevelScore, ScoreSummary } from './types.ts';

const VALUE = { pass: 1, partial: 0.5, fail: 0 } as const;
const LEVEL_WEIGHT = 0.3;
// Each of these failing costs 5 overall points. There is no cap.
const BLOCKER_COST = 5;
const BLOCKERS: Record<number, string> = { 2: 'AI search bots blocked in robots.txt', 6: 'bot protection / WAF blocks crawler', 11: 'homepage noindex' };

/**
 * Level score = weighted pass % (0-100), null when the level has no scorable checks (adds 0).
 * Overall = 0.3·(L1 + L2 + L3 + L4) − 5 per blocker, floored at 0, not clamped above (max 120).
 * The UI displays min(overall, 100).
 */
export function score(results: CheckResult[]): ScoreSummary {
  const level = (n: 1 | 2 | 3 | 4): LevelScore => {
    let got = 0;
    let max = 0;
    let checks = 0;
    for (const r of results) {
      if (r.level !== n || r.weight === 0) continue;
      got += r.weight * (r.status === 'n/a' ? 0 : VALUE[r.status]);
      max += r.weight;
      checks++;
    }
    return { score: max ? (got / max) * 100 : null, checks };
  };
  const l1 = level(1);
  const l2 = level(2);
  const l3 = level(3);
  const l4 = level(4);
  const raw = LEVEL_WEIGHT * ((l1.score ?? 0) + (l2.score ?? 0) + (l3.score ?? 0) + (l4.score ?? 0));
  const blockers = results.filter((r) => r.status === 'fail' && BLOCKERS[r.id]).map((r) => BLOCKERS[r.id]);
  return {
    levels: { 1: l1, 2: l2, 3: l3, 4: l4 },
    raw,
    overall: Math.max(0, raw - BLOCKER_COST * blockers.length),
    blockers,
  };
}
