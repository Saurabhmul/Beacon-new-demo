import { randomUUID } from "crypto";
import { geminiClient } from "../../ai-engine";
import type { CatalogEntry } from "../../field-catalog";
import type { TreatmentWithRules, PolicyPack } from "@shared/schema";
import { resolveSourceFields } from "./field-value-resolver";
import { evaluateDerivedFields } from "./derived-field-engine";
import { inferBusinessFields } from "./business-field-engine";
import { evaluateTreatmentRules } from "./rule-evaluator";
import { checkPolicyCompleteness, PolicyCompletenessError } from "./policy-completeness";
import { buildDecisionPacket } from "./decision-packet";
import {
  buildFinalDecisionSystemPrompt,
  buildFinalDecisionUserPrompt,
  buildFinalDecisionRetryPrompt,
  FINAL_DECISION_PROMPT_VERSION,
} from "./prompts/final-decision-prompt";
import {
  validateDecision,
  parseFinalAIOutput,
  type FinalAIOutput,
  type DecisionValidationResult,
} from "./decision-validator";
import type { StageMetrics, TreatmentSelectionTraceEntry } from "./types";
import type { DecisionPacket } from "./decision-packet";

export const ENGINE_VERSION = "decision-layer-v2.1";

// ─── Pipeline result ──────────────────────────────────────────────────────────

export interface DecisionPipelineResult {
  runId: string;
  engineVersion: string;
  policyVersion: string;
  timestamp: string;
  companyId: string;
  customerGuid: string | null;

  recommended_treatment_code: string;
  recommended_treatment_name: string;
  requires_agent_review: boolean;
  proposed_email_to_customer: string;
  internal_action: string | null;
  customer_situation: string | null;

  /**
   * Non-null ONLY for deterministic fallback runs:
   *   "policy completeness check failed"
   *   "no eligible treatments"
   *   "required tier 1–3 business field …"
   *   "AI output could not be parsed after retry"
   *   "AI call failed"
   * Null for all normal AI runs, including when AI returns AGENT_REVIEW naturally.
   */
  runFallbackReason: string | null;

  /**
   * "pending"          — normal; ready for agent review
   * "failed_validation" — validation layer blocked; excluded from normal review
   */
  decisionStatus: "pending" | "failed_validation";

  aiRawOutput: Record<string, unknown>;

  problemDescription: string | null;
  solutionEvidence: string | null;
}

// ─── Stage timer ──────────────────────────────────────────────────────────────

function startStage(): { startedAt: string; startMs: number } {
  return { startedAt: new Date().toISOString(), startMs: Date.now() };
}

function endStage(start: { startedAt: string; startMs: number }, counts: Record<string, number> = {}): StageMetrics {
  return {
    startedAt: start.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - start.startMs,
    counts,
  };
}

// ─── Final AI call ────────────────────────────────────────────────────────────

async function callFinalDecisionAI(userPrompt: string): Promise<string> {
  const response = await geminiClient.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: {
      maxOutputTokens: 6000,
      systemInstruction: buildFinalDecisionSystemPrompt(),
    },
  });
  return response.text ?? "";
}

// ─── Deterministic fallback output ───────────────────────────────────────────

function buildFallbackOutput(reason: string, customerSituation: string): FinalAIOutput {
  return {
    customer_guid: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    days_past_due: null,
    amount_due: null,
    minimum_due: null,
    additional_customer_context: {},
    recent_payment_history_summary: "Not available",
    conversation_summary: "Not available",
    customer_situation: customerSituation,
    customer_situation_confidence_score: 1,
    customer_situation_evidence: [],
    used_fields: [],
    used_rules: [],
    missing_information: [reason],
    key_factors_considered: [],
    structured_assessments: [],
    recommended_treatment_name: "Agent Review",
    recommended_treatment_code: "AGENT_REVIEW",
    proposed_next_best_action: "Escalate to human agent for manual review",
    treatment_eligibility_explanation: customerSituation,
    blocked_conditions: [],
    proposed_next_best_confidence_score: 1,
    proposed_next_best_evidence: reason,
    requires_agent_review: true,
    internal_action: `SYSTEM_HOLD: ${reason}`,
    proposed_email_to_customer: "NO_ACTION",
  };
}

// ─── Orchestrator args ────────────────────────────────────────────────────────

export interface RunDecisionPipelineArgs {
  companyId: string;
  rawCustomerData: Record<string, unknown>;
  treatments: TreatmentWithRules[];
  catalog: CatalogEntry[];
  policyPack: PolicyPack | null;
  aliasMap?: Record<string, string>;
  defaultPriorityMap?: Record<string, number>;
  sopText?: string | null;
  inferBusinessFieldConfig?: {
    maxBusinessFieldsPerRun?: number;
    perFieldTimeoutMs?: number;
    totalBudgetMs?: number;
    inferTier4Fields?: boolean;
  };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function runDecisionPipeline(args: RunDecisionPipelineArgs): Promise<DecisionPipelineResult> {
  const {
    companyId,
    rawCustomerData,
    treatments,
    catalog,
    policyPack,
    aliasMap = {},
    defaultPriorityMap = {},
    sopText,
    inferBusinessFieldConfig = {},
  } = args;

  const runId = randomUUID();
  const timestamp = new Date().toISOString();
  const policyVersion = policyPack?.updatedAt?.toISOString() ?? "unknown";
  const stageMetrics: Record<string, StageMetrics> = {};

  // ── Stage 1: Policy completeness check ──────────────────────────────────
  const s1 = startStage();
  const completenessResult = checkPolicyCompleteness(treatments, catalog);
  stageMetrics["policyCompleteness"] = endStage(s1, {
    issues: completenessResult.issues.length,
    passed: completenessResult.passed ? 1 : 0,
  });

  if (!completenessResult.passed) {
    const reason = "policy completeness check failed";
    const fallbackOutput = buildFallbackOutput(
      reason,
      "SYSTEM_HOLD: policy configuration incomplete — not a customer-driven review"
    );
    // Build selection trace annotated with policy completeness failure reason
    const trace = buildAnnotatedEmptyTrace(
      treatments,
      "Policy completeness check failed before customer analysis began"
    );
    return assembleDeterministicFallback({
      runId, engineVersion: ENGINE_VERSION, policyVersion, timestamp, companyId,
      runFallbackReason: reason,
      fallbackOutput,
      stageMetrics,
      rawCustomerData,
      selectionTrace: trace,
      issues: completenessResult.issues,
    });
  }

  // ── Stage 2: Resolve source fields ──────────────────────────────────────
  const s2 = startStage();
  const fieldResolution = resolveSourceFields(rawCustomerData, catalog, aliasMap);
  stageMetrics["fieldResolution"] = endStage(s2, {
    resolved: Object.keys(fieldResolution.resolvedValues).length,
    unresolved: fieldResolution.unresolvedRawKeys.length,
  });

  // ── Stage 3: Compute derived fields ─────────────────────────────────────
  const s3 = startStage();
  const derivedFieldResult = evaluateDerivedFields(catalog, fieldResolution.resolvedValues);
  stageMetrics["derivedFields"] = endStage(s3, derivedFieldResult.stageMetrics.counts);

  const combinedResolvedValues: Record<string, unknown> = {
    ...fieldResolution.resolvedValues,
    ...derivedFieldResult.values,
  };

  stageMetrics["fieldAvailability"] = endStage(startStage(), { summary: 1 });

  // ── Stage 5+6: Business field inference ─────────────────────────────────
  const s5 = startStage();
  const businessFieldCatalog = catalog.filter(e => e.sourceType === "business_field");

  let businessFieldResult = null;
  try {
    businessFieldResult = await inferBusinessFields(
      treatments,
      businessFieldCatalog,
      fieldResolution.resolvedValues,
      rawCustomerData,
      derivedFieldResult.values,
      inferBusinessFieldConfig
    );
    stageMetrics["businessFields"] = endStage(s5, businessFieldResult.stageMetrics.counts);

    for (const [k, v] of Object.entries(businessFieldResult.values)) {
      if (v !== null && v !== undefined) combinedResolvedValues[k] = v;
    }
  } catch (err) {
    console.warn("[orchestrator] Business field inference failed:", err);
    stageMetrics["businessFields"] = endStage(s5, { error: 1 });
  }

  // Business field cap forces deterministic AGENT_REVIEW
  if (businessFieldResult?.requires_agent_review) {
    const bfFallbackReason = businessFieldResult.runFallbackReason ?? "required business fields could not be inferred";
    const emptyRuleResult = buildEmptyRuleResult();
    const dp = buildDecisionPacket({
      runId, policyPack, rawCustomerData, fieldResolution,
      derivedFieldResult, businessFieldResult,
      ruleEvalResult: emptyRuleResult, sopText,
    });
    const fallbackOutput = buildFallbackOutput(bfFallbackReason, bfFallbackReason);
    return assembleDeterministicFallback({
      runId, engineVersion: ENGINE_VERSION, policyVersion, timestamp, companyId,
      runFallbackReason: bfFallbackReason,
      fallbackOutput,
      stageMetrics,
      rawCustomerData,
      selectionTrace: [],
      issues: [],
      decisionPacket: dp,
      fieldResolution,
      derivedFieldResult,
      businessFieldResult,
      ruleEvalResult: emptyRuleResult,
    });
  }

  // ── Stage 7: Rule evaluation ─────────────────────────────────────────────
  const s7 = startStage();
  const ruleEvalResult = evaluateTreatmentRules(treatments, combinedResolvedValues, defaultPriorityMap);
  stageMetrics["ruleEvaluation"] = endStage(s7, ruleEvalResult.stageMetrics.counts);

  // ── Stage 8: Assemble decision packet ────────────────────────────────────
  const s8 = startStage();
  const decisionPacket = buildDecisionPacket({
    runId, policyPack, rawCustomerData, fieldResolution,
    derivedFieldResult, businessFieldResult, ruleEvalResult, sopText,
  });
  stageMetrics["decisionPacket"] = endStage(s8, { built: 1 });

  // Deterministic fallback: no eligible treatments
  if (ruleEvalResult.rankedEligibleTreatments.length === 0) {
    const reason = "no eligible treatments";
    const fallbackOutput = buildFallbackOutput(reason, "No eligible treatments found after rule evaluation");
    return assembleDeterministicFallback({
      runId, engineVersion: ENGINE_VERSION, policyVersion, timestamp, companyId,
      runFallbackReason: reason,
      fallbackOutput,
      stageMetrics,
      rawCustomerData,
      selectionTrace: ruleEvalResult.treatmentSelectionTrace,
      issues: [],
      decisionPacket,
      fieldResolution,
      derivedFieldResult,
      businessFieldResult,
      ruleEvalResult,
    });
  }

  // ── Stage 9: Final AI call ───────────────────────────────────────────────
  const s9 = startStage();
  const userPrompt = buildFinalDecisionUserPrompt(decisionPacket, ruleEvalResult);

  let finalAIOutput: FinalAIOutput | null = null;
  let validationResult: DecisionValidationResult | null = null;
  let deterministicFallbackReason: string | null = null;
  let aiRawText = "";
  let retryCount = 0;

  try {
    aiRawText = await callFinalDecisionAI(userPrompt);
    const parseResult = parseFinalAIOutput(aiRawText);

    if (!parseResult.ok) {
      // Parse failure → retry once
      retryCount = 1;
      const retryText = await callFinalDecisionAI(`${userPrompt}\n\n${buildFinalDecisionRetryPrompt(parseResult.error)}`);
      const retryParse = parseFinalAIOutput(retryText);
      if (!retryParse.ok) {
        // Still unparseable after retry → deterministic AGENT_REVIEW fallback
        deterministicFallbackReason = "AI output could not be parsed after retry";
        finalAIOutput = buildFallbackOutput(deterministicFallbackReason, "AI response could not be parsed");
      } else {
        aiRawText = retryText;
        finalAIOutput = retryParse.data;
      }
    } else {
      finalAIOutput = parseResult.data;
    }

    // ── Stage 10: Validate AI output (runs for all recommendations, including AGENT_REVIEW) ──
    if (finalAIOutput && !deterministicFallbackReason) {
      validationResult = validateDecision(finalAIOutput, decisionPacket, ruleEvalResult.treatmentSelectionTrace);

      // ── Stage 11: Retry once on structural failure ──────────────────────
      if (validationResult.status === "failed" && validationResult.failureType === "structural_failure" && retryCount === 0) {
        retryCount = 1;
        const issueList = validationResult.blockingIssues.map(i => i.message).join("; ");
        const retryRaw = await callFinalDecisionAI(`${userPrompt}\n\n${buildFinalDecisionRetryPrompt(issueList)}`);
        const retryParse = parseFinalAIOutput(retryRaw);
        if (retryParse.ok) {
          aiRawText = retryRaw;
          finalAIOutput = retryParse.data;
          validationResult = validateDecision(finalAIOutput, decisionPacket, ruleEvalResult.treatmentSelectionTrace);
        }
      }

      // ── Structural failure unrepaired after retry → deterministic AGENT_REVIEW ──
      if (validationResult.status === "failed" && validationResult.failureType === "structural_failure") {
        deterministicFallbackReason = "AI output failed structural validation after retry";
        finalAIOutput = buildFallbackOutput(
          deterministicFallbackReason,
          "AI output failed structural validation and could not be repaired"
        );
        validationResult = null;
      }

      // ── Tied-preferred ambiguity → deterministic AGENT_REVIEW ─────────
      // When AI chose among tied preferred treatments without any traceable reason,
      // the validator emits a blocking policy_failure. Convert to deterministic fallback.
      if (
        validationResult !== null &&
        validationResult.status === "failed" &&
        validationResult.failureType === "policy_failure" &&
        validationResult.blockingIssues.some(i =>
          i.field === "treatment_eligibility_explanation" &&
          i.message.toLowerCase().includes("tied preferred")
        )
      ) {
        deterministicFallbackReason = "tied preferred treatments — no traceable reason to choose";
        finalAIOutput = buildFallbackOutput(
          deterministicFallbackReason,
          "Tied preferred treatments with no documented justification; escalating to agent"
        );
        validationResult = null;
      }
    }
  } catch (err) {
    console.error("[orchestrator] Final AI call failed:", err);
    deterministicFallbackReason = "AI call failed: " + String(err).substring(0, 100);
    finalAIOutput = buildFallbackOutput(deterministicFallbackReason, "AI call failed during final decision stage");
  }

  stageMetrics["finalDecision"] = endStage(s9, { retryCount });

  // ── Determine decision status ────────────────────────────────────────────
  // failed_validation: policy/guardrail/evidence failures that are not structural
  // (structural failures are now handled as deterministic fallbacks above)
  let decisionStatus: "pending" | "failed_validation" = "pending";
  if (
    validationResult?.status === "failed" &&
    validationResult.failureType !== "structural_failure" &&
    !deterministicFallbackReason
  ) {
    decisionStatus = "failed_validation";
  }

  const output = finalAIOutput!;
  const customerGuid = output.customer_guid ?? decisionPacket.customer_guid ?? extractCustomerGuid(rawCustomerData);
  const selectionTrace = validationResult?.updatedSelectionTrace ?? ruleEvalResult.treatmentSelectionTrace;

  const aiRawOutput = buildAiRawOutput({
    runId,
    policyVersion,
    stageMetrics,
    runFallbackReason: deterministicFallbackReason,
    fieldAvailabilitySummary: decisionPacket.fieldAvailabilitySummary,
    sourceResolutionTrace: fieldResolution.traces,
    derivedFieldTrace: derivedFieldResult.traces,
    businessFieldTrace: businessFieldResult?.traces ?? {},
    ruleEvaluation: {
      eligibleCount: ruleEvalResult.eligibleTreatments.length,
      blockedCount: ruleEvalResult.blockedTreatments.length,
      treatmentRuleTrace: ruleEvalResult.treatmentRuleTrace,
      stageMetrics: ruleEvalResult.stageMetrics,
    },
    treatmentSelectionTrace: selectionTrace,
    decisionBasisSummary: decisionPacket.decisionBasisSummary,
    decisionPacket: {
      runId: decisionPacket.runId,
      engineVersion: decisionPacket.engineVersion,
      policyVersion: decisionPacket.policyVersion,
      customer_guid: decisionPacket.customer_guid,
      rankedEligibleTreatments: decisionPacket.rankedEligibleTreatments,
      preferredTreatments: decisionPacket.preferredTreatments,
      blockedTreatments: decisionPacket.blockedTreatments,
      escalationFlags: decisionPacket.escalationFlags,
      guardrailFlags: decisionPacket.guardrailFlags,
      reviewTriggers: decisionPacket.reviewTriggers,
      missingCriticalInformation: decisionPacket.missingCriticalInformation,
      decisionBasisSummary: decisionPacket.decisionBasisSummary,
    },
    finalAIOutput: output,
    rawAIText: aiRawText,
    validation: validationResult ? {
      status: validationResult.status,
      failureType: validationResult.failureType ?? null,
      blockingIssues: validationResult.blockingIssues,
      warnings: validationResult.warnings,
    } : null,
  });

  return {
    runId,
    engineVersion: ENGINE_VERSION,
    policyVersion,
    timestamp,
    companyId,
    customerGuid,
    recommended_treatment_code: output.recommended_treatment_code ?? "AGENT_REVIEW",
    recommended_treatment_name: output.recommended_treatment_name ?? "Agent Review",
    requires_agent_review: output.requires_agent_review ?? (output.recommended_treatment_code === "AGENT_REVIEW"),
    proposed_email_to_customer: output.proposed_email_to_customer ?? "NO_ACTION",
    internal_action: output.internal_action ?? null,
    customer_situation: output.customer_situation ?? null,
    runFallbackReason: deterministicFallbackReason,
    decisionStatus,
    aiRawOutput,
    problemDescription: output.customer_situation ?? null,
    solutionEvidence: output.proposed_next_best_evidence ?? null,
  };
}

// ─── Deterministic fallback assembler ────────────────────────────────────────

interface DeterministicFallbackArgs {
  runId: string;
  engineVersion: string;
  policyVersion: string;
  timestamp: string;
  companyId: string;
  runFallbackReason: string;
  fallbackOutput: FinalAIOutput;
  stageMetrics: Record<string, StageMetrics>;
  rawCustomerData: Record<string, unknown>;
  selectionTrace: TreatmentSelectionTraceEntry[];
  issues: string[];
  decisionPacket?: DecisionPacket;
  fieldResolution?: { resolvedValues: Record<string, unknown>; traces: Record<string, unknown> };
  derivedFieldResult?: { values: Record<string, unknown>; traces: Record<string, unknown>; stageMetrics: StageMetrics };
  businessFieldResult?: { values: Record<string, unknown>; traces: Record<string, unknown>; stageMetrics: StageMetrics } | null;
  ruleEvalResult?: {
    eligibleTreatments: Array<{ code: string; name: string }>;
    rankedEligibleTreatments: unknown[];
    blockedTreatments: unknown[];
    treatmentRuleTrace: unknown[];
    stageMetrics: StageMetrics;
  };
}

function assembleDeterministicFallback(args: DeterministicFallbackArgs): DecisionPipelineResult {
  const {
    runId, engineVersion, policyVersion, timestamp, companyId,
    runFallbackReason, fallbackOutput, stageMetrics, rawCustomerData,
    selectionTrace, issues, decisionPacket, fieldResolution, derivedFieldResult,
    businessFieldResult, ruleEvalResult,
  } = args;

  const customerGuid = extractCustomerGuid(rawCustomerData);
  const dp = decisionPacket;

  const aiRawOutput = buildAiRawOutput({
    runId,
    policyVersion,
    stageMetrics,
    runFallbackReason,
    fieldAvailabilitySummary: dp?.fieldAvailabilitySummary ?? {},
    sourceResolutionTrace: fieldResolution?.traces ?? {},
    derivedFieldTrace: derivedFieldResult?.traces ?? {},
    businessFieldTrace: businessFieldResult?.traces ?? {},
    ruleEvaluation: ruleEvalResult
      ? {
          eligibleCount: ruleEvalResult.eligibleTreatments.length,
          blockedCount: ruleEvalResult.blockedTreatments.length,
          treatmentRuleTrace: ruleEvalResult.treatmentRuleTrace,
          stageMetrics: ruleEvalResult.stageMetrics,
        }
      : { notes: "not reached — deterministic fallback triggered before rule evaluation", issues },
    treatmentSelectionTrace: selectionTrace,
    decisionBasisSummary: dp?.decisionBasisSummary ?? {},
    decisionPacket: dp ? {
      runId: dp.runId,
      engineVersion: dp.engineVersion,
      policyVersion: dp.policyVersion,
      customer_guid: dp.customer_guid,
      rankedEligibleTreatments: dp.rankedEligibleTreatments,
      preferredTreatments: dp.preferredTreatments,
      blockedTreatments: dp.blockedTreatments,
      escalationFlags: dp.escalationFlags,
      guardrailFlags: dp.guardrailFlags,
      reviewTriggers: dp.reviewTriggers,
      missingCriticalInformation: dp.missingCriticalInformation,
    } : null,
    finalAIOutput: fallbackOutput,
    validation: null,
  });

  return {
    runId,
    engineVersion,
    policyVersion,
    timestamp,
    companyId,
    customerGuid,
    recommended_treatment_code: "AGENT_REVIEW",
    recommended_treatment_name: "Agent Review",
    requires_agent_review: true,
    proposed_email_to_customer: "NO_ACTION",
    internal_action: fallbackOutput.internal_action ?? null,
    customer_situation: fallbackOutput.customer_situation ?? null,
    runFallbackReason,
    decisionStatus: "pending",
    aiRawOutput,
    problemDescription: fallbackOutput.customer_situation ?? null,
    solutionEvidence: null,
  };
}

// ─── aiRawOutput builder ──────────────────────────────────────────────────────

function buildAiRawOutput(args: {
  runId: string;
  policyVersion: string;
  stageMetrics: Record<string, StageMetrics>;
  runFallbackReason: string | null;
  fieldAvailabilitySummary: unknown;
  sourceResolutionTrace: unknown;
  derivedFieldTrace: unknown;
  businessFieldTrace: unknown;
  ruleEvaluation: unknown;
  treatmentSelectionTrace: unknown;
  decisionBasisSummary: unknown;
  decisionPacket: unknown;
  finalAIOutput: unknown;
  rawAIText?: string;
  validation: unknown;
}): Record<string, unknown> {
  return {
    engineVersion: ENGINE_VERSION,
    promptVersions: {
      businessField: "v1.0",
      finalDecision: FINAL_DECISION_PROMPT_VERSION,
    },
    policyVersion: args.policyVersion,
    runId: args.runId,
    runFallbackReason: args.runFallbackReason,
    stageMetrics: args.stageMetrics,
    fieldAvailabilitySummary: args.fieldAvailabilitySummary,
    sourceResolutionTrace: args.sourceResolutionTrace,
    derivedFieldTrace: args.derivedFieldTrace,
    businessFieldTrace: args.businessFieldTrace,
    ruleEvaluation: args.ruleEvaluation,
    treatmentSelectionTrace: args.treatmentSelectionTrace,
    decisionBasisSummary: args.decisionBasisSummary,
    decisionPacket: args.decisionPacket,
    finalAIOutput: args.finalAIOutput,
    ...(args.rawAIText !== undefined ? { _rawAIText: args.rawAIText.substring(0, 2000) } : {}),
    validation: args.validation,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAnnotatedEmptyTrace(
  treatments: TreatmentWithRules[],
  selectionReason: string
): TreatmentSelectionTraceEntry[] {
  return treatments.filter(t => t.enabled).map((t, i) => ({
    treatmentCode: t.name,
    priority: null,
    prioritySource: "missing" as const,
    rank: i + 1,
    isPreferred: false,
    // selectionMode intentionally omitted: AGENT_REVIEW is a run-level outcome,
    // not a treatment selection. Reason stored in runFallbackReason.
    selectionReason,
  }));
}

function buildEmptyRuleResult() {
  return {
    eligibleTreatments: [],
    rankedEligibleTreatments: [],
    preferredTreatments: [],
    blockedTreatments: [],
    escalationFlags: [],
    guardrailFlags: [],
    reviewTriggers: [],
    missingCriticalInformation: [],
    treatmentRuleTrace: [],
    treatmentSelectionTrace: [],
    stageMetrics: endStage(startStage()),
  };
}

function extractCustomerGuid(rawData: Record<string, unknown>): string | null {
  const v = rawData["customer / account / loan id"] ?? rawData.customer_id ?? rawData.account_id ?? rawData.customer_guid;
  if (v !== null && v !== undefined) return String(v);
  return null;
}

export { PolicyCompletenessError };
