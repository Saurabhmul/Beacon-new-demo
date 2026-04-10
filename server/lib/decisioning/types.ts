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

export interface RuleEvaluatedRow {
  ruleId: number;
  field: string;
  operator: string;
  expected: unknown;
  actual: unknown;
  result: "pass" | "fail" | "not_evaluable";
  reason: string;
}

/**
 * Group-level trace entry: carries rule-type context so callers can tell
 * whether a pass/fail came from eligibility, hard/soft blocker, review trigger, etc.
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
  /** Structured by group so blocker/eligibility/review provenance is explicit */
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

// ─── Validation ───────────────────────────────────────────────────────────────

export type ValidationStatus = "valid" | "failed_validation" | "agent_review";

export interface ValidationIssue {
  type: string;
  message: string;
  field?: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  issues: ValidationIssue[];
}

// ─── Communication ────────────────────────────────────────────────────────────

export interface CommunicationSection {
  subject?: string;
  body?: string;
  communicationSource: "policy_config" | "default_empty";
}

// ─── Decision Packet ─────────────────────────────────────────────────────────

export interface DecisionPacket {
  // Fixed customer context fields
  customer_guid: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  days_past_due: number | null;
  amount_due: number | null;
  minimum_due: number | null;
  // Any additional non-null customer/account context goes here
  additional_customer_context: Record<string, unknown>;

  // Decision outcome
  recommended_treatment: string | null;
  internal_action: string | null;
  // null for normal AI selections; reason string for deterministic fallbacks
  runFallbackReason: string | null;

  // Evidence
  problem_description: string | null;
  solution_evidence: string | null;

  // Communication draft
  communication: CommunicationSection;

  // Pipeline traces
  sourceResolution: Record<string, SourceResolutionTrace>;
  derivedFields: DerivedFieldResult;
  ruleEvaluation: RuleEvaluationResult;
  validation: ValidationResult | null;

  // AI raw output from the final decision stage
  aiRawOutput: Record<string, unknown> | null;

  stageMetrics: {
    fieldResolution?: StageMetrics;
    derivedFields?: StageMetrics;
    ruleEvaluation?: StageMetrics;
    businessFields?: StageMetrics;
    finalDecision?: StageMetrics;
  };
}
