import type {
  RuleEvaluationResult,
  RankedTreatment,
  BlockedTreatment,
  TreatmentRuleTrace,
  TreatmentRuleGroupTrace,
  TreatmentSelectionTraceEntry,
  RuleEvaluatedRow,
  ReviewTrigger,
  EscalationFlag,
  GuardrailFlag,
  MissingCriticalField,
  StageMetrics,
  PrioritySource,
  BlockerType,
} from "./types";
import type { TreatmentWithRules, TreatmentRule, TreatmentRuleGroup } from "@shared/schema";

// ─── Rule Type Constants ─────────────────────────────────────────────────────

/**
 * Rule group types and their semantics:
 *   eligibility     → treatment eligible only if ALL eligibility groups pass (group logic operator applies within each group)
 *   hard_blocker    → if ANY hard_blocker group passes, treatment is hard-blocked (cannot be overridden by AI)
 *   soft_blocker    → if ANY soft_blocker group passes, treatment is soft-blocked (AI may still override with justification)
 *   review_trigger  → if ANY review_trigger group passes, add a review trigger (NOT a blocker; decision may still proceed)
 *   escalation      → if ANY escalation group passes, add an escalation flag
 *   guardrail       → if ANY guardrail group passes, add a guardrail flag
 */
const HARD_BLOCKER_TYPES = new Set(["hard_blocker", "blocker_hard"]);
const SOFT_BLOCKER_TYPES = new Set(["soft_blocker", "blocker_soft"]);
const REVIEW_TRIGGER_TYPES = new Set(["review_trigger", "review"]);
const ESCALATION_TYPES = new Set(["escalation"]);
const GUARDRAIL_TYPES = new Set(["guardrail"]);
const ELIGIBILITY_TYPES = new Set(["eligibility", "eligibility_rule"]);

// ─── Field Lookup ─────────────────────────────────────────────────────────────

/**
 * Look up the value for a treatment rule field from the combined resolved values map.
 * Resolution order:
 *   1. leftFieldId present → look up by leftFieldId directly (handles "source:X" and numeric IDs)
 *   2. Fall back to fieldName → try as direct key
 *
 * Returns [fieldKey, value | undefined]
 * where fieldKey is the canonical key used (for trace logging).
 */
function lookupFieldValue(
  rule: TreatmentRule,
  resolvedValues: Record<string, unknown>
): [string, unknown] {
  if (rule.leftFieldId) {
    const id = rule.leftFieldId;
    if (id in resolvedValues) return [id, resolvedValues[id]];
    // source: prefix — also try stripping it for fallback
    if (id.startsWith("source:")) {
      const shortKey = id.slice(7);
      if (shortKey in resolvedValues) return [shortKey, resolvedValues[shortKey]];
    }
    // Not found by ID
    return [id, undefined];
  }

  // Fall back to fieldName
  if (rule.fieldName) {
    if (rule.fieldName in resolvedValues) return [rule.fieldName, resolvedValues[rule.fieldName]];
    // Also try normalized
    const normalized = rule.fieldName.trim().toLowerCase().replace(/\s+/g, "_");
    if (normalized in resolvedValues) return [normalized, resolvedValues[normalized]];
    return [rule.fieldName, undefined];
  }

  return ["_unknown_field_", undefined];
}

/**
 * Get the comparison value from a rule row.
 * Prefers rightConstantValue (newer schema), falls back to value (legacy).
 */
function getRuleExpectedValue(rule: TreatmentRule): unknown {
  if (rule.rightMode === "constant" || rule.rightMode == null) {
    return rule.rightConstantValue ?? rule.value ?? null;
  }
  return rule.value ?? rule.rightConstantValue ?? null;
}

// ─── Single Rule Evaluation ───────────────────────────────────────────────────

const VALID_OPERATORS = new Set([
  "=", "!=", ">", ">=", "<", "<=",
  "in", "not_in", "contains",
  "is_true", "is_false",
]);

function evaluateSingleRule(
  rule: TreatmentRule,
  resolvedValues: Record<string, unknown>
): RuleEvaluatedRow {
  const [fieldKey, actual] = lookupFieldValue(rule, resolvedValues);
  const expected = getRuleExpectedValue(rule);
  const op = rule.operator;

  const base: Omit<RuleEvaluatedRow, "result" | "reason"> = {
    ruleId: rule.id,
    field: fieldKey,
    operator: op,
    expected,
    actual,
  };

  // Validate operator
  if (!op || !VALID_OPERATORS.has(op)) {
    return { ...base, result: "not_evaluable", reason: `Unknown operator "${op}"` };
  }

  // Field not found in resolved values
  if (actual === undefined) {
    return { ...base, result: "not_evaluable", reason: `Field "${fieldKey}" not found in resolved values` };
  }

  // is_true / is_false
  if (op === "is_true") {
    const boolVal = coerceBool(actual);
    if (boolVal === null) return { ...base, result: "not_evaluable", reason: `Cannot coerce "${fieldKey}" to boolean` };
    return { ...base, result: boolVal ? "pass" : "fail", reason: boolVal ? `${fieldKey} is true` : `${fieldKey} is false` };
  }
  if (op === "is_false") {
    const boolVal = coerceBool(actual);
    if (boolVal === null) return { ...base, result: "not_evaluable", reason: `Cannot coerce "${fieldKey}" to boolean` };
    return { ...base, result: !boolVal ? "pass" : "fail", reason: !boolVal ? `${fieldKey} is false` : `${fieldKey} is true` };
  }

  // Comparison operators
  const actualStr = actual === null ? null : String(actual);
  const expectedStr = expected === null ? null : String(expected);

  switch (op) {
    case "=": {
      const pass = actualStr === expectedStr;
      return { ...base, result: pass ? "pass" : "fail", reason: pass ? `${fieldKey} = ${expectedStr}` : `${fieldKey} is ${actualStr}, expected ${expectedStr}` };
    }
    case "!=": {
      const pass = actualStr !== expectedStr;
      return { ...base, result: pass ? "pass" : "fail", reason: pass ? `${fieldKey} != ${expectedStr}` : `${fieldKey} is ${actualStr}, should not be ${expectedStr}` };
    }
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const n = coerceNum(actual);
      const e = coerceNum(expected);
      if (n === null || e === null) {
        return { ...base, result: "not_evaluable", reason: `Cannot coerce values to number for numeric comparison on "${fieldKey}"` };
      }
      const pass = op === ">" ? n > e : op === ">=" ? n >= e : op === "<" ? n < e : n <= e;
      return { ...base, result: pass ? "pass" : "fail", reason: `${fieldKey} (${n}) ${op} ${e} → ${pass}` };
    }
    case "in": {
      const list = parseList(expected);
      if (!list) return { ...base, result: "not_evaluable", reason: `Operator "in" requires an array value` };
      const pass = list.map(String).includes(String(actual));
      return { ...base, result: pass ? "pass" : "fail", reason: pass ? `${fieldKey} in ${JSON.stringify(list)}` : `${fieldKey} (${actualStr}) not in ${JSON.stringify(list)}` };
    }
    case "not_in": {
      const list = parseList(expected);
      if (!list) return { ...base, result: "not_evaluable", reason: `Operator "not_in" requires an array value` };
      const pass = !list.map(String).includes(String(actual));
      return { ...base, result: pass ? "pass" : "fail", reason: pass ? `${fieldKey} not in ${JSON.stringify(list)}` : `${fieldKey} (${actualStr}) is in ${JSON.stringify(list)}` };
    }
    case "contains": {
      const haystack = actualStr ?? "";
      const needle = expectedStr ?? "";
      const pass = haystack.includes(needle);
      return { ...base, result: pass ? "pass" : "fail", reason: `${fieldKey} ${pass ? "contains" : "does not contain"} "${needle}"` };
    }
    default:
      return { ...base, result: "not_evaluable", reason: `Unhandled operator "${op}"` };
  }
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 ? true : false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(s)) return true;
    if (["false", "no", "0", "off"].includes(s)) return false;
  }
  return null;
}

function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return isFinite(n) ? n : null;
  }
  return null;
}

function parseList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    // Try JSON array or comma-separated
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // try comma-separated
      return v.split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return null;
}

// ─── Rule Group Evaluation ────────────────────────────────────────────────────

interface GroupEvalResult {
  passed: boolean;
  hasNotEvaluable: boolean;
  evaluatedRows: RuleEvaluatedRow[];
  missingFields: Array<{ fieldKey: string; ruleId: number }>;
}

function evaluateRuleGroup(
  group: TreatmentRuleGroup & { rules: TreatmentRule[] },
  resolvedValues: Record<string, unknown>
): GroupEvalResult {
  const logic = (group.logicOperator || "AND").toUpperCase();
  const rows: RuleEvaluatedRow[] = [];
  const missingFields: Array<{ fieldKey: string; ruleId: number }> = [];

  for (const rule of group.rules) {
    const row = evaluateSingleRule(rule, resolvedValues);
    rows.push(row);
    if (row.result === "not_evaluable" && row.reason.includes("not found")) {
      const fieldKey = rule.leftFieldId || rule.fieldName || "_unknown_";
      missingFields.push({ fieldKey, ruleId: rule.id });
    }
  }

  const hasNotEvaluable = rows.some(r => r.result === "not_evaluable");
  let passed: boolean;

  if (logic === "OR") {
    // Any pass → passed; all not_evaluable or fail → not passed
    passed = rows.some(r => r.result === "pass");
  } else {
    // AND: all must pass; any fail → not passed; any not_evaluable with no fail → not passed (conservative)
    passed = rows.length > 0 && rows.every(r => r.result === "pass");
  }

  return { passed, hasNotEvaluable, evaluatedRows: rows, missingFields };
}

// ─── Treatment Priority ────────────────────────────────────────────────────────

function parseTreatmentPriority(priority: string | null | undefined): {
  value: number | null;
  source: PrioritySource;
} {
  if (priority === null || priority === undefined || priority.trim() === "") {
    return { value: null, source: "missing" };
  }
  const n = parseInt(priority.trim(), 10);
  if (!isNaN(n) && n > 0) return { value: n, source: "configured" };
  return { value: null, source: "missing" };
}

// ─── Main Rule Evaluator ──────────────────────────────────────────────────────

/**
 * Evaluate all enabled treatments against the combined resolved field values
 * (source + derived). Produces a complete RuleEvaluationResult including
 * ranked eligible treatments, blocked treatments, review triggers,
 * escalation/guardrail flags, and missing critical information.
 *
 * @param treatments   Treatments from the policy pack, with their rule groups and rules
 * @param resolvedValues  Combined map of canonicalFieldId → value (source + derived)
 */
export function evaluateTreatmentRules(
  treatments: TreatmentWithRules[],
  resolvedValues: Record<string, unknown>
): RuleEvaluationResult {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const eligibleTreatments: Array<{ code: string; name: string }> = [];
  const blockedTreatments: BlockedTreatment[] = [];
  const reviewTriggers: ReviewTrigger[] = [];
  const escalationFlags: EscalationFlag[] = [];
  const guardrailFlags: GuardrailFlag[] = [];
  const treatmentRuleTrace: TreatmentRuleTrace[] = [];
  const missingFieldsMap = new Map<string, MissingCriticalField>();

  const warnedMissingPriority: string[] = [];

  for (const treatment of treatments) {
    if (!treatment.enabled) continue;

    const treatmentCode = treatment.name;
    const evaluatedGroups: TreatmentRuleGroupTrace[] = [];

    let isHardBlocked = false;
    let isSoftBlocked = false;
    const blockerReasons: string[] = [];

    let hasEligibilityGroups = false;
    let passesAllEligibility = true;
    const eligibilityFailReasons: string[] = [];

    // No rule groups at all → log and allow eligible
    if (!treatment.ruleGroups || treatment.ruleGroups.length === 0) {
      console.warn(`[rule-evaluator] Treatment "${treatmentCode}" has no rule groups defined`);
    }

    for (const group of treatment.ruleGroups || []) {
      // Empty group: log and skip (don't crash)
      if (!group.rules || group.rules.length === 0) {
        console.warn(
          `[rule-evaluator] Rule group ${group.id} (type="${group.ruleType}") for treatment "${treatmentCode}" has no rules — skipped`
        );
        continue;
      }

      const ruleType = (group.ruleType || "eligibility").toLowerCase();
      const result = evaluateRuleGroup(group, resolvedValues);

      // Determine blockerType for this group
      let groupBlockerType: BlockerType | undefined;
      if (HARD_BLOCKER_TYPES.has(ruleType)) groupBlockerType = "hard";
      else if (SOFT_BLOCKER_TYPES.has(ruleType)) groupBlockerType = "soft";

      // Build group-level trace entry (carries ruleType + groupId context)
      const groupTrace: TreatmentRuleGroupTrace = {
        groupId: group.id,
        ruleType,
        logicOperator: (group.logicOperator || "AND").toUpperCase(),
        groupPassed: result.passed,
        ...(groupBlockerType !== undefined ? { blockerType: groupBlockerType } : {}),
        evaluatedRules: result.evaluatedRows,
      };
      evaluatedGroups.push(groupTrace);

      // Track missing critical fields (only for hard_blocker, eligibility, review_trigger)
      const isCriticalGroupType =
        HARD_BLOCKER_TYPES.has(ruleType) ||
        ELIGIBILITY_TYPES.has(ruleType) ||
        REVIEW_TRIGGER_TYPES.has(ruleType);

      if (isCriticalGroupType && result.missingFields.length > 0) {
        for (const mf of result.missingFields) {
          if (!missingFieldsMap.has(mf.fieldKey)) {
            missingFieldsMap.set(mf.fieldKey, {
              fieldId: mf.fieldKey,
              label: mf.fieldKey,
              requiredBy: `treatment "${treatmentCode}" group ${group.id} type "${ruleType}" (ruleId ${mf.ruleId})`,
            });
          }
        }
      }

      if (HARD_BLOCKER_TYPES.has(ruleType)) {
        if (result.passed) {
          isHardBlocked = true;
          blockerReasons.push(
            ...result.evaluatedRows
              .filter(r => r.result === "pass")
              .map(r => r.reason)
          );
        }
      } else if (SOFT_BLOCKER_TYPES.has(ruleType)) {
        if (result.passed) {
          isSoftBlocked = true;
          blockerReasons.push(
            ...result.evaluatedRows
              .filter(r => r.result === "pass")
              .map(r => r.reason)
          );
        }
      } else if (REVIEW_TRIGGER_TYPES.has(ruleType)) {
        if (result.passed) {
          reviewTriggers.push({
            type: "treatment_review_trigger",
            description: `Treatment "${treatmentCode}" triggered review: ${result.evaluatedRows.filter(r => r.result === "pass").map(r => r.reason).join("; ")}`,
            fieldId: treatmentCode,
          });
        }
      } else if (ESCALATION_TYPES.has(ruleType)) {
        if (result.passed) {
          escalationFlags.push({
            type: "treatment_escalation",
            description: `Escalation triggered by treatment "${treatmentCode}": ${result.evaluatedRows.filter(r => r.result === "pass").map(r => r.reason).join("; ")}`,
          });
        }
      } else if (GUARDRAIL_TYPES.has(ruleType)) {
        if (result.passed) {
          guardrailFlags.push({
            type: "treatment_guardrail",
            description: `Guardrail triggered by treatment "${treatmentCode}": ${result.evaluatedRows.filter(r => r.result === "pass").map(r => r.reason).join("; ")}`,
          });
        }
      } else if (ELIGIBILITY_TYPES.has(ruleType)) {
        hasEligibilityGroups = true;
        if (!result.passed) {
          passesAllEligibility = false;
          eligibilityFailReasons.push(
            ...result.evaluatedRows
              .filter(r => r.result === "fail" || r.result === "not_evaluable")
              .map(r => r.reason)
          );
        }
      } else {
        // Unknown rule type: log but don't crash
        console.warn(`[rule-evaluator] Unknown rule type "${group.ruleType}" on treatment "${treatmentCode}" group ${group.id} — skipped`);
      }
    }

    treatmentRuleTrace.push({ treatmentCode, evaluatedGroups });

    // Determine outcome
    if (isHardBlocked) {
      blockedTreatments.push({
        code: treatmentCode,
        name: treatment.name,
        blockerType: "hard",
        reasons: blockerReasons.length > 0 ? blockerReasons : ["Hard blocker condition met"],
      });
    } else if (isSoftBlocked) {
      blockedTreatments.push({
        code: treatmentCode,
        name: treatment.name,
        blockerType: "soft",
        reasons: blockerReasons.length > 0 ? blockerReasons : ["Soft blocker condition met"],
      });
    } else if (hasEligibilityGroups && !passesAllEligibility) {
      // Failed eligibility: not eligible, not explicitly blocked
    } else {
      // Eligible: passes all eligibility groups, or has no eligibility groups
      eligibleTreatments.push({ code: treatmentCode, name: treatment.name });
    }
  }

  // ─── Rank eligible treatments ─────────────────────────────────────────────

  const rankedList: RankedTreatment[] = [];

  for (const eligible of eligibleTreatments) {
    const treatment = treatments.find(t => t.name === eligible.code);
    const { value: priorityValue, source: prioritySource } = parseTreatmentPriority(
      treatment?.priority ?? null
    );

    const rankReasons: string[] = [];
    if (prioritySource === "missing") {
      warnedMissingPriority.push(eligible.code);
      rankReasons.push("No priority configured; treatment ranked last by default");
      console.warn(
        `[rule-evaluator] Treatment "${eligible.code}" has no configured priority — ranked last`
      );
    } else {
      rankReasons.push(`Priority ${priorityValue} (configured)`);
    }

    rankedList.push({
      code: eligible.code,
      name: eligible.name,
      priority: priorityValue,
      prioritySource,
      rank: 0, // assigned below
      reasons: rankReasons,
      isPreferred: false, // assigned below
    });
  }

  // Sort: configured priorities ascending (1 = highest), then missing-priority treatments last
  rankedList.sort((a, b) => {
    const aVal = a.priority !== null ? a.priority : Infinity;
    const bVal = b.priority !== null ? b.priority : Infinity;
    if (aVal !== bVal) return aVal - bVal;
    // Stable sort: preserve insertion order for ties
    return 0;
  });

  // Assign ranks (tied priorities → same rank)
  let currentRank = 1;
  for (let i = 0; i < rankedList.length; i++) {
    if (i === 0) {
      rankedList[i].rank = 1;
    } else {
      const prev = rankedList[i - 1];
      const curr = rankedList[i];
      if (curr.priority === prev.priority) {
        // Same rank as previous (tied)
        curr.rank = prev.rank;
      } else {
        curr.rank = i + 1;
        currentRank = i + 1;
      }
    }
  }

  // Mark isPreferred: all treatments tied for rank 1
  const topRank = rankedList.length > 0 ? rankedList[0].rank : null;
  for (const t of rankedList) {
    t.isPreferred = t.rank === 1;
  }

  // preferredTreatments: subset at rank 1
  const preferredTreatments = rankedList.filter(t => t.isPreferred);

  // treatmentSelectionTrace: one entry per eligible treatment (rule-evaluator fields only)
  const treatmentSelectionTrace: TreatmentSelectionTraceEntry[] = rankedList.map(t => ({
    treatmentCode: t.code,
    priority: t.priority,
    prioritySource: t.prioritySource,
    rank: t.rank,
    isPreferred: t.isPreferred,
    // selectionMode and selectionReason populated later by validator
  }));

  const completedAt = new Date().toISOString();

  const stageMetrics: StageMetrics = {
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    counts: {
      eligible: eligibleTreatments.length,
      blocked: blockedTreatments.length,
      preferred: preferredTreatments.length,
      reviewTriggers: reviewTriggers.length,
      escalationFlags: escalationFlags.length,
      guardrailFlags: guardrailFlags.length,
      missingCriticalFields: missingFieldsMap.size,
      warnedMissingPriority: warnedMissingPriority.length,
    },
  };

  return {
    eligibleTreatments,
    rankedEligibleTreatments: rankedList,
    preferredTreatments,
    blockedTreatments,
    escalationFlags,
    guardrailFlags,
    reviewTriggers,
    missingCriticalInformation: Array.from(missingFieldsMap.values()),
    treatmentRuleTrace,
    treatmentSelectionTrace,
    stageMetrics,
  };
}
