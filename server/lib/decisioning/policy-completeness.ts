import type { TreatmentWithRules } from "@shared/schema";
import type { CatalogEntry } from "../../field-catalog";

// ─── Error type ───────────────────────────────────────────────────────────────

export class PolicyCompletenessError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Policy completeness check failed: ${issues.join("; ")}`);
    this.name = "PolicyCompletenessError";
    this.issues = issues;
  }
}

// ─── Supported operators ──────────────────────────────────────────────────────

const SUPPORTED_OPERATORS = new Set([
  "=", "!=", ">", ">=", "<", "<=",
  "in", "not_in", "contains",
  "is_true", "is_false",
]);

/**
 * All ruleType values recognised by the rule-evaluator and business-field-engine.
 * Must stay in sync with HARD_BLOCKER_TYPES, SOFT_BLOCKER_TYPES, etc. in rule-evaluator.ts.
 */
const SUPPORTED_RULE_TYPES = new Set([
  "eligibility", "eligibility_rule",
  "hard_blocker", "blocker_hard",
  "soft_blocker", "blocker_soft",
  "review_trigger", "review",
  "escalation",
  "guardrail",
  "business_field",
  "cooling_period",
  "vulnerability",
  "priority",
]);

// ─── Result type ──────────────────────────────────────────────────────────────

export interface PolicyCompletenessResult {
  passed: boolean;
  issues: string[];
}

// ─── Core check (analysis-context: returns result, does not throw) ────────────

/**
 * Validate policy completeness before a customer analysis run.
 *
 * Checks:
 *   1. At least one enabled treatment exists
 *   2. All rule field references (fieldName, leftFieldId, rightFieldId) resolve to known catalog fields
 *   3. Treatment-reference integrity: rule groups must reference an existing treatmentId
 *   4. Broken rule-group references: ruleType must be a recognised type
 *   5. No unsupported operators
 *   6. No empty rule groups
 *
 * Does NOT throw — returns a result object so callers decide how to handle.
 * For admin-context strict validation (throws on failure), use {@link checkPolicyCompletenessStrict}.
 */
export function checkPolicyCompleteness(
  treatments: TreatmentWithRules[],
  catalog: CatalogEntry[]
): PolicyCompletenessResult {
  const issues: string[] = [];

  const enabledTreatments = treatments.filter(t => t.enabled);
  if (enabledTreatments.length === 0) {
    issues.push("Policy has no enabled treatments");
  }

  // Build field-ID and label lookups
  const knownFieldIds = new Set<string>();
  const knownFieldLabels = new Set<string>();
  for (const entry of catalog) {
    if (entry.id) knownFieldIds.add(entry.id);
    knownFieldLabels.add(entry.label.trim().toLowerCase());
  }

  // Build treatment ID and code lookups for reference integrity
  const knownTreatmentIds = new Set(treatments.map(t => t.id));

  for (const treatment of enabledTreatments) {
    const tname = treatment.name;

    for (const group of treatment.ruleGroups ?? []) {
      // ── Treatment-reference integrity ─────────────────────────────────
      if (group.treatmentId !== treatment.id && !knownTreatmentIds.has(group.treatmentId)) {
        issues.push(
          `Treatment "${tname}" group ${group.id}: references unknown treatmentId ${group.treatmentId}`
        );
      }

      // ── Rule-group type integrity ─────────────────────────────────────
      if (group.ruleType && !SUPPORTED_RULE_TYPES.has(group.ruleType.toLowerCase())) {
        issues.push(
          `Treatment "${tname}" group ${group.id}: unrecognised ruleType "${group.ruleType}"`
        );
      }

      const rules = group.rules ?? [];
      if (rules.length === 0) {
        issues.push(
          `Treatment "${tname}" group ${group.id} (type="${group.ruleType}") has no rules`
        );
        continue;
      }

      for (const rule of rules) {
        // Check operator
        if (rule.operator && !SUPPORTED_OPERATORS.has(rule.operator)) {
          issues.push(
            `Treatment "${tname}" rule ${rule.id}: unsupported operator "${rule.operator}"`
          );
        }

        // Check leftFieldId (preferred) or fallback to fieldName
        if (rule.leftFieldId) {
          if (!isKnownField(rule.leftFieldId, knownFieldIds, knownFieldLabels)) {
            issues.push(
              `Treatment "${tname}" rule ${rule.id}: leftFieldId "${rule.leftFieldId}" does not resolve to a known field`
            );
          }
        } else if (rule.fieldName) {
          if (!isKnownField(rule.fieldName, knownFieldIds, knownFieldLabels)) {
            issues.push(
              `Treatment "${tname}" rule ${rule.id}: fieldName "${rule.fieldName}" does not resolve to a known field`
            );
          }
        }

        // Check rightFieldId when field-vs-field comparison
        if (rule.rightMode === "field" && rule.rightFieldId) {
          if (!isKnownField(rule.rightFieldId, knownFieldIds, knownFieldLabels)) {
            issues.push(
              `Treatment "${tname}" rule ${rule.id}: rightFieldId "${rule.rightFieldId}" does not resolve to a known field`
            );
          }
        }
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

// ─── Admin-context strict check (throws PolicyCompletenessError on failure) ───

/**
 * Strict variant for admin contexts — e.g. when activating or publishing a policy.
 * Throws {@link PolicyCompletenessError} with all issues if the policy is incomplete.
 *
 * Example usage in a route:
 *   checkPolicyCompletenessStrict(treatments, catalog);  // throws 400-worthy error on invalid policy
 *
 * Use {@link checkPolicyCompleteness} for analysis-context (returns result, does not throw).
 */
export function checkPolicyCompletenessStrict(
  treatments: TreatmentWithRules[],
  catalog: CatalogEntry[]
): void {
  const result = checkPolicyCompleteness(treatments, catalog);
  if (!result.passed) {
    throw new PolicyCompletenessError(result.issues);
  }
}

// ─── Field resolution helper ──────────────────────────────────────────────────

function isKnownField(
  fieldId: string,
  knownFieldIds: Set<string>,
  knownFieldLabels: Set<string>
): boolean {
  if (knownFieldIds.has(fieldId)) return true;
  const normalized = fieldId.trim().toLowerCase();
  if (knownFieldLabels.has(normalized)) return true;
  if (fieldId.startsWith("source:")) {
    const bare = fieldId.slice(7).trim().toLowerCase();
    if (knownFieldLabels.has(bare)) return true;
  }
  return false;
}
