// ─── Source Resolution ───────────────────────────────────────────────────────

export type SourceResolutionMethod = "exact" | "normalized" | "alias" | "unresolved";

export interface SourceResolutionTrace {
  rawKey: string;
  canonicalFieldId: string;
  method: SourceResolutionMethod;
  rawValue: unknown;
  normalizedValue: string | null;
  aliasUsed?: string;
}

// ─── Stage Metrics ───────────────────────────────────────────────────────────

export interface StageMetrics {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  counts: Record<string, number>;
}

// ─── Derived Field ────────────────────────────────────────────────────────────

export type DerivedFieldStatus = "computed" | "null" | "error" | "skipped";

export interface DerivedFieldTrace {
  status: DerivedFieldStatus;
  formula: string;
  inputsUsed: string[];
  outputValue: unknown;
  nullReason?: string;
  error?: string;
}

export interface DerivedFieldResult {
  values: Record<string, unknown>;
  traces: Record<string, DerivedFieldTrace>;
  stageMetrics: StageMetrics;
}

// ─── Blocker ─────────────────────────────────────────────────────────────────

export type BlockerType = "hard" | "soft" | "missing_info";

// ─── Treatment Rule Trace ─────────────────────────────────────────────────────

/**
 * Row-level rule evaluation result.
 * Includes group provenance fields (groupId, ruleType, blockerType?) so
 * the flat view is self-explanatory without needing the grouped view.
 */
export interface RuleEvaluatedRow {
  ruleId: number;
  field: string;
  operator: string;
  expected: unknown;
  actual: unknown;
  result: "pass" | "fail" | "not_evaluable";
  reason: string;
  /** Which rule group this row came from */
  groupId: number;
  /** Rule type of the group (eligibility, hard_blocker, soft_blocker, etc.) */
  ruleType: string;
  /** Only present for hard/soft blocker groups */
  blockerType?: BlockerType;
}

/**
 * Group-level trace entry: organises rows by group and carries group metadata.
 * Useful for quickly identifying which group passed/failed and why.
 */
export interface TreatmentRuleGroupTrace {
  groupId: number;
  ruleType: string;
  logicOperator: string;
  groupPassed: boolean;
  /** Only present for hard/soft blocker groups */
  blockerType?: BlockerType;
  evaluatedRules: RuleEvaluatedRow[];
}

export interface TreatmentRuleTrace {
  treatmentCode: string;
  /**
   * Flat list of all evaluated rules across all groups (per task contract).
   * Each row includes groupId, ruleType, and optional blockerType for provenance.
   */
  evaluatedRules: RuleEvaluatedRow[];
  /**
   * Same rows organised by group (additional explainability layer).
   * Groups carry their own metadata: ruleType, logicOperator, groupPassed, blockerType?.
   */
  evaluatedGroups: TreatmentRuleGroupTrace[];
}

// ─── Ranked Treatment ─────────────────────────────────────────────────────────

/**
 * prioritySource:
 *   "configured"  = priority value explicitly set on the treatment in policy
 *   "defaulted"   = a real configured default-priority rule assigned this value
 *   "missing"     = no priority defined; treatment ranked last by the system
 */
export type PrioritySource = "configured" | "defaulted" | "missing";

export interface RankedTreatment {
  code: string;
  name: string;
  priority: number | null;
  prioritySource: PrioritySource;
  rank: number;
  reasons: string[];
  isPreferred: boolean;
}

// ─── Treatment Selection Trace ────────────────────────────────────────────────

/**
 * selectionMode (populated by validator / final-selection step):
 *   "preferred"               = this treatment was the sole preferred choice
 *   "tied_preferred"          = AI chose among multiple tied preferred treatments
 *   "lower_rank_justified"    = AI justified choosing a lower-ranked treatment
 *   "fallback_agent_review"   = system fell back to AGENT_REVIEW
 *   "no_action"               = system fell back to NO_ACTION
 */
export type SelectionMode =
  | "preferred"
  | "tied_preferred"
  | "lower_rank_justified"
  | "fallback_agent_review"
  | "no_action";

export interface TreatmentSelectionTraceEntry {
  treatmentCode: string;
  // Populated by rule-evaluator:
  priority: number | null;
  prioritySource: PrioritySource;
  rank: number;
  isPreferred: boolean;
  // Populated by validator / final-selection step (undefined until that stage runs):
  selectionMode?: SelectionMode;
  selectionReason?: string;
}

// ─── Rule Evaluation Result ───────────────────────────────────────────────────

export interface BlockedTreatment {
  code: string;
  name: string;
  blockerType: BlockerType;
  reasons: string[];
}

export interface ReviewTrigger {
  type: string;
  description: string;
  fieldId?: string;
}

export interface EscalationFlag {
  type: string;
  description: string;
}

export interface GuardrailFlag {
  type: string;
  description: string;
}

export interface MissingCriticalField {
  fieldId: string;
  label: string;
  requiredBy: string;
}

export interface RuleEvaluationResult {
  eligibleTreatments: Array<{ code: string; name: string }>;
  rankedEligibleTreatments: RankedTreatment[];
  preferredTreatments: RankedTreatment[];
  blockedTreatments: BlockedTreatment[];
  escalationFlags: EscalationFlag[];
  guardrailFlags: GuardrailFlag[];
  reviewTriggers: ReviewTrigger[];
  missingCriticalInformation: MissingCriticalField[];
  treatmentRuleTrace: TreatmentRuleTrace[];
  treatmentSelectionTrace: TreatmentSelectionTraceEntry[];
  stageMetrics: StageMetrics;
}

// ─── Business Field Inference ─────────────────────────────────────────────────

/**
 * Tier classification for business field inference ordering:
 *   1 = referenced by hard_blocker rules (most critical)
 *   2 = referenced by escalation / review_trigger rules
 *   3 = referenced by eligibility rules
 *   4 = optional / enrichment (only inferred when inferTier4Fields is enabled
 *       or when required by another inferred field)
 */
export type BusinessFieldTier = 1 | 2 | 3 | 4;

export interface BusinessFieldTrace {
  fieldId: string;
  fieldLabel: string;
  tier: BusinessFieldTier;
  /** Position within the final ordered inference list (0-indexed). */
  dependencyPosition: number;
  value: unknown;
  confidence: number | null;
  rationale: string | null;
  nullReason: string | null;
  evidence: string[];
  retryCount: number;
  /** True if any prior-inferred business field values were included in the prompt context. */
  priorBusinessFieldsReferenced: boolean;
  /** Raw JSON string returned by the model (for audit). */
  rawAiResponse: string | null;
  durationMs: number;
  /** Set when payment or conversation history was truncated before prompting. */
  truncationWarning?: string;
  /** Flagged when confidence > 0.8 but only a single weak evidence item was present. */
  highConfidenceSingleEvidenceWarning?: boolean;
}

export interface BusinessFieldResult {
  /** Inferred field values keyed by canonical field ID. */
  values: Record<string, unknown>;
  /** Per-field trace records. */
  traces: Record<string, BusinessFieldTrace>;
  /** True when the engine determined the run must be routed to AGENT_REVIEW. */
  requires_agent_review: boolean;
  /** Human-readable reason for agent review routing (only set when requires_agent_review = true). */
  agentReviewReason?: string;
  /**
   * Structured fallback reason string consumed by the orchestrator to populate
   * DecisionPacket.runFallbackReason. Follows the spec format:
   *   "required tier 1–3 business field timed out: <field_id>" for per-field timeouts
   *   "required tier 1–3 business field cap reached" for cap-enforced truncation
   *   "stage budget exhausted: required tier 1–3 fields uninferred" for total-budget overrun
   * Null on normal completion (no escalation).
   */
  runFallbackReason: string | null;
  /** True when tier-4 fields were skipped because the cap would have been exceeded. */
  tier4Skipped: boolean;
  /** Set when tier-4 or other non-critical fields were omitted due to the cap. */
  capWarning?: string;
  stageMetrics: StageMetrics;
}

// ─── (Legacy validation types — superseded by decision-validator.ts in v2.1) ──
// These are retained here for reference only. Authoritatve types are in:
//   server/lib/decisioning/decision-validator.ts  (FinalAIOutput, DecisionValidationResult)
//   server/lib/decisioning/decision-packet.ts      (DecisionPacket, CommunicationSection)

export type LegacyValidationStatus = "valid" | "failed_validation" | "agent_review";
