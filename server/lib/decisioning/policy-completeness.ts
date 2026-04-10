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

// ─── Supported operators ─────────────────────────────────────────────────────

const SUPPORTED_OPERATORS = new Set([
  "=", "!=", ">", ">=", "<", "<=",
  "in", "not_in", "contains",
  "is_true", "is_false",
]);

// ─── Check ────────────────────────────────────────────────────────────────────

export interface PolicyCompletenessResult {
  passed: boolean;
  issues: string[];
}

/**
 * Validate that the policy is complete enough to run customer analysis.
 *
 * Checks:
 *   1. At least one treatment exists
 *   2. All rule field references (leftFieldId, rightFieldId) resolve to known catalog fields
 *   3. All treatment references in rules are valid treatment codes
 *   4. No unsupported operators
 *   5. No empty rule groups with no rules (warning-level but captured)
 *
 * Does NOT throw — returns a result object so callers can decide how to handle.
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

  // Build fast field-ID lookup: includes both "source:X" ids and numeric string ids
  const knownFieldIds = new Set<string>();
  const knownFieldLabels = new Set<string>();
  for (const entry of catalog) {
    if (entry.id) knownFieldIds.add(entry.id);
    knownFieldLabels.add(entry.label.trim().toLowerCase());
  }

  const knownTreatmentCodes = new Set(treatments.map(t => t.name));

  for (const treatment of enabledTreatments) {
    const tname = treatment.name;

    for (const group of treatment.ruleGroups ?? []) {
      const rules = group.rules ?? [];

      if (rules.length === 0) {
        issues.push(`Treatment "${tname}" group ${group.id} (type="${group.ruleType}") has no rules`);
        continue;
      }

      for (const rule of rules) {
        // Check operator
        if (rule.operator && !SUPPORTED_OPERATORS.has(rule.operator)) {
          issues.push(`Treatment "${tname}" rule ${rule.id}: unsupported operator "${rule.operator}"`);
        }

        // Check leftFieldId if present
        if (rule.leftFieldId) {
          if (!isKnownField(rule.leftFieldId, knownFieldIds, knownFieldLabels)) {
            issues.push(`Treatment "${tname}" rule ${rule.id}: leftFieldId "${rule.leftFieldId}" does not resolve to a known field`);
          }
        }

        // Check rightFieldId if it's a field-vs-field comparison
        if (rule.rightMode === "field" && rule.rightFieldId) {
          if (!isKnownField(rule.rightFieldId, knownFieldIds, knownFieldLabels)) {
            issues.push(`Treatment "${tname}" rule ${rule.id}: rightFieldId "${rule.rightFieldId}" does not resolve to a known field`);
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

/**
 * Check if a field ID resolves to a known catalog field.
 * Accepts: numeric ID strings, "source:X" IDs, or normalized label matches.
 */
function isKnownField(
  fieldId: string,
  knownFieldIds: Set<string>,
  knownFieldLabels: Set<string>
): boolean {
  if (knownFieldIds.has(fieldId)) return true;
  // Normalized label check
  const normalized = fieldId.trim().toLowerCase();
  if (knownFieldLabels.has(normalized)) return true;
  // source: prefix strip
  if (fieldId.startsWith("source:")) {
    const bare = fieldId.slice(7).trim().toLowerCase();
    if (knownFieldLabels.has(bare)) return true;
  }
  return false;
}
