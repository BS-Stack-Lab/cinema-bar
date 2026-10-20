import type { RuleInput } from './types.js';
import { koreanToday } from './validation.js';
export function isRuleEligible(rule: RuleInput, now = Date.now()) {
  if (!rule.isEnabled) return false;
  const today = koreanToday(now);
  if (rule.date >= today) return true;
  if (rule.provider !== 'cgv') return false;
  const koreanTime = new Date(now + 9 * 3600000);
  return koreanTime.getUTCHours() < 6 && rule.date === koreanToday(now - 86400000);
}
