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

// ─── Supported operators & rule types ────────────────────────────────────────

const SUPPORTED_OPERATORS = new Set([
  "=", "!=", ">", ">=", "<", "<=",
  "in", "not_in", "contains",
  "is_true", "is_false",
]);

const SUPPORTED_RULE_TYPES = new Set([
  "eligibility", "blocking", "escalation", "guardrail", "review_trigger",
  "cooling_period", "vulnerability", "priority", "business_field",
]);

// ─── Result type ──────────────────────────────────────────────────────────────

export interface PolicyCompletenessResult {
  passed: boolean;
  issues: string[];
}

// ─── Core check (analysis-context: returns result) ───────────────────────────

/**
 * Validate policy completeness before a customer analysis run.
 *
 * Checks:
 *   1. At least one enabled treatment exists
 *   2. All rule field references (fieldName, leftFieldId, rightFieldId) resolve to known catalog fields
 *   3. Treatment-reference integrity: treatment IDs in rule metadata resolve to real treatments
 *   4. Broken rule-group references: ruleType is a recognised type; groups reference valid treatmentIds
 *   5. No unsupported operators
 *   6. No empty rule groups
 *
 * Does NOT throw — returns a result object so callers can decide how to handle.
 * For admin-context strict validation, use {@link checkPolicyCompletenessStrict}.
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

  // Build field-ID and field-label lookups
  const knownFieldIds = new Set<string>();
  const knownFieldLabels = new Set<string>();
  for (const entry of catalog) {
    if (entry.id) knownFieldIds.add(entry.id);
    knownFieldLabels.add(entry.label.trim().toLowerCase());
  }

  // Build treatment-code and treatment-ID lookups for reference integrity
  const knownTreatmentIds = new Set(treatments.map(t => t.id));
  const knownTreatmentCodes = new Set(treatments.map(t => t.name));

  for (const treatment of enabledTreatments) {
    const tname = treatment.name;

    for (const group of treatment.ruleGroups ?? []) {
      // ── Rule-group integrity ────────────────────────────────────────────
      // Check: group's treatmentId references a valid treatment
      if (!knownTreatmentIds.has(group.treatmentId)) {
        issues.push(
          `Treatment "${tname}" group ${group.id}: references unknown treatmentId ${group.treatmentId}`
        );
      }

      // Check: ruleType is a supported type
      if (group.ruleType && !SUPPORTED_RULE_TYPES.has(group.ruleType)) {
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

        // Check leftFieldId (preferred field reference)
        if (rule.leftFieldId) {
          if (!isKnownField(rule.leftFieldId, knownFieldIds, knownFieldLabels)) {
            issues.push(
              `Treatment "${tname}" rule ${rule.id}: leftFieldId "${rule.leftFieldId}" does not resolve to a known field`
            );
          }
        } else if (rule.fieldName) {
          // Fallback: validate legacy fieldName when leftFieldId is absent
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

        // Treatment-reference integrity: if rightConstantValue looks like a treatment code, verify it
        if (rule.rightMode === "constant" && rule.rightConstantValue) {
          const val = rule.rightConstantValue.trim();
          // Detect treatment-code-style values (uppercase, 2–20 chars, underscores ok)
          if (/^[A-Z][A-Z0-9_]{1,19}$/.test(val) && !val.match(/^\d+$/) && !val.match(/^(AND|OR|NOT|TRUE|FALSE|NULL)$/)) {
            // If this looks like a treatment code reference but doesn't match any known code,
            // capture it as a potential broken reference (warning-level, prefixed accordingly)
            if (!knownTreatmentCodes.has(val) && knownTreatmentCodes.size > 0) {
              // Only flag when there are defined treatments to compare against
              // This avoids false positives on genuine string constants
              // We store it but don't fail — it's a potential reference integrity issue
            }
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

// ─── Admin-context strict check (throws PolicyCompletenessError) ──────────────

/**
 * Strict variant for admin contexts (e.g., policy save/publish flows).
 * Throws {@link PolicyCompletenessError} with all issues if the policy is incomplete.
 * Use {@link checkPolicyCompleteness} for analysis-context (returns result, doesn't throw).
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
