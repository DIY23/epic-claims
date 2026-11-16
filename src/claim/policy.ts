import type { Offer, StoredOffer } from '../shared/types.js';
import type { ClaimingConfig, PolicyRule } from '../config/schema.js';

export type PolicyDecision = 'claim' | 'approval' | 'skip';

export interface PolicyContext {
  mode: ClaimingConfig['mode'];
  rules: PolicyRule[];
}

export interface PolicyResult {
  decision: PolicyDecision;
  /** Which rule (if any) decided it, for the audit trail. */
  ruleId: string | null;
  reason: string;
}

function fieldValue(offer: Offer, field: PolicyRule['field']): string | number | null {
  switch (field) {
    case 'kind':
      return offer.kind;
    case 'publisher':
      return offer.publisher ?? '';
    case 'title':
      return offer.title ?? '';
    case 'price':
      return offer.discountPrice ?? 0;
    case 'discount_percent': {
      const orig = offer.originalPrice;
      const disc = offer.discountPrice;
      if (!orig || orig <= 0 || disc === null || disc === undefined) return 0;
      return Math.round(((orig - disc) / orig) * 100);
    }
    default:
      return null;
  }
}

export function matchesRule(offer: Offer, rule: PolicyRule): boolean {
  if (!rule.enabled) return false;
  const actual = fieldValue(offer, rule.field);
  if (actual === null) return false;
  const expected = rule.value;
  switch (rule.op) {
    case 'is':
      return String(actual).toLowerCase() === expected.toLowerCase();
    case 'is_not':
      return String(actual).toLowerCase() !== expected.toLowerCase();
    case 'contains':
      return String(actual).toLowerCase().includes(expected.toLowerCase());
    case 'not_contains':
      return !String(actual).toLowerCase().includes(expected.toLowerCase());
    case 'matches': {
      try {
        return new RegExp(expected, 'i').test(String(actual));
      } catch {
        return false; // an invalid regex never matches, never throws
      }
    }
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    default:
      return false;
  }
}

/**
 * The complete claim policy. Deterministic: same offer + same config = same
 * decision, always. No randomness, no network, no LLM.
 *
 *  auto      -> claim everything
 *  approval  -> ask about everything
 *  hybrid    -> first matching rule wins; unmatched offers fall back to approval
 *               (never silently to automatic claiming).
 */
export function decide(offer: Offer | StoredOffer, policy: PolicyContext): PolicyResult {
  if (policy.mode === 'auto') {
    return { decision: 'claim', ruleId: null, reason: 'mode=auto' };
  }
  if (policy.mode === 'approval') {
    return { decision: 'approval', ruleId: null, reason: 'mode=approval' };
  }
  for (const rule of policy.rules) {
    if (matchesRule(offer, rule)) {
      return { decision: rule.action, ruleId: rule.id, reason: `rule ${rule.id} (${rule.field} ${rule.op} "${rule.value}")` };
    }
  }
  return { decision: 'approval', ruleId: null, reason: 'hybrid: no rule matched, defaulting to approval' };
}

export interface RuleValidationIssue {
  ruleId: string;
  message: string;
}

export function validateRule(rule: PolicyRule): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  if (rule.op === 'matches') {
    try {
      new RegExp(rule.value);
    } catch (e) {
      issues.push({ ruleId: rule.id, message: `invalid regular expression: ${(e as Error).message}` });
    }
  }
  if ((rule.op === 'gte' || rule.op === 'lte') && !Number.isFinite(Number(rule.value))) {
    issues.push({ ruleId: rule.id, message: `"${rule.op}" needs a numeric value` });
  }
  if ((rule.op === 'gte' || rule.op === 'lte') && rule.field !== 'price' && rule.field !== 'discount_percent') {
    issues.push({ ruleId: rule.id, message: `${rule.op} only applies to price or discount_percent` });
  }
  if ((rule.field === 'price' || rule.field === 'discount_percent') && rule.op === 'contains') {
    issues.push({ ruleId: rule.id, message: 'contains does not apply to numeric fields' });
  }
  if (rule.field === 'kind' && !['game', 'dlc', 'other'].includes(rule.value.toLowerCase()) && rule.op !== 'is_not') {
    issues.push({ ruleId: rule.id, message: 'kind must be game, dlc or other' });
  }
  return issues;
}
