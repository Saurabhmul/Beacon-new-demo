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
import type { StageMetrics } from "./types";
import type { DecisionPacket } from "./decision-packet";

export const ENGINE_VERSION = "decision-layer-v2.1";

// ─── Pipeline result ──────────────────────────────────────────────────────────

export interface DecisionPipelineResult {
  /** Unique run identifier for idempotency tracking */
  runId: string;
  engineVersion: string;
  policyVersion: string;
  timestamp: string;
  companyId: string;
  customerGuid: string | null;

  /** Final recommended treatment code: one of the treatment codes, "AGENT_REVIEW", or "NO_ACTION" */
  recommended_treatment_code: string;
  recommended_treatment_name: string;
  requires_agent_review: boolean;
  proposed_email_to_customer: string;
  internal_action: string | null;
  customer_situation: string | null;

  /** Run-level fallback reason (null for normal AI treatment selections) */
  runFallbackReason: string | null;

  /** Full aiRawOutput stored in the decisions table */
  aiRawOutput: Record<string, unknown>;

  /** Legacy-compat fields for the existing DB columns */
  problemDescription: string | null;
  solutionEvidence: string | null;
}

// ─── Stage timer helper ───────────────────────────────────────────────────────

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

// ─── Deterministic fallback ───────────────────────────────────────────────────

function buildFallbackOutput(reason: string, treatmentEligibilityExplanation: string): FinalAIOutput {
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
    customer_situation: treatmentEligibilityExplanation,
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
    treatment_eligibility_explanation: treatmentEligibilityExplanation,
    blocked_conditions: [],
    proposed_next_best_confidence_score: 1,
    proposed_next_best_evidence: reason,
    requires_agent_review: true,
    internal_action: `SYSTEM_HOLD: ${reason}`,
    proposed_email_to_customer: "NO_ACTION",
  };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

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
  const partialStageMetrics: Record<string, StageMetrics> = {};

  // ── Stage 1: Policy completeness check ──────────────────────────────────
  const s1 = startStage();
  const completenessResult = checkPolicyCompleteness(treatments, catalog);
  partialStageMetrics["policyCompleteness"] = endStage(s1, {
    issues: completenessResult.issues.length,
    passed: completenessResult.passed ? 1 : 0,
  });

  if (!completenessResult.passed) {
    const fallbackOutput = buildFallbackOutput(
      "policy completeness check failed",
      "SYSTEM_HOLD: policy configuration incomplete — not a customer-driven review"
    );

    const selectionTrace = treatments.filter(t => t.enabled).map((t, i) => ({
      treatmentCode: t.name,
      priority: null as number | null,
      prioritySource: "missing" as const,
      rank: i + 1,
      isPreferred: false,
    }));

    const aiRawOutput = buildAiRawOutput({
      runId,
      policyVersion,
      stageMetrics: partialStageMetrics,
      runFallbackReason: "policy completeness check failed",
      fieldAvailabilitySummary: {},
      sourceResolutionTrace: {},
      derivedFieldTrace: {},
      businessFieldTrace: {},
      ruleEvaluation: { notes: "not reached — policy completeness check failed" },
      treatmentSelectionTrace: selectionTrace,
      decisionBasisSummary: {},
      decisionPacket: null,
      finalAIOutput: fallbackOutput,
      validation: {
        status: "passed",
        notes: "deterministic fallback — no AI validation needed",
        selectionMode: "fallback_agent_review",
        selectionReason: "Policy completeness check failed before customer analysis began",
      },
    });

    return {
      runId,
      engineVersion: ENGINE_VERSION,
      policyVersion,
      timestamp,
      companyId,
      customerGuid: extractCustomerGuid(rawCustomerData),
      recommended_treatment_code: "AGENT_REVIEW",
      recommended_treatment_name: "Agent Review",
      requires_agent_review: true,
      proposed_email_to_customer: "NO_ACTION",
      internal_action: "SYSTEM_HOLD: policy configuration incomplete — not a customer-driven review",
      customer_situation: "Policy completeness check failed before customer analysis began",
      runFallbackReason: "policy completeness check failed",
      aiRawOutput,
      problemDescription: "Policy completeness check failed",
      solutionEvidence: completenessResult.issues.join("; "),
    };
  }

  // ── Stage 2: Resolve source field values ─────────────────────────────────
  const s2 = startStage();
  const fieldResolution = resolveSourceFields(rawCustomerData, catalog, aliasMap);
  partialStageMetrics["fieldResolution"] = endStage(s2, {
    resolved: Object.keys(fieldResolution.resolvedValues).length,
    unresolved: fieldResolution.unresolvedRawKeys.length,
  });

  // ── Stage 3: Compute derived fields ──────────────────────────────────────
  const s3 = startStage();
  const derivedFieldResult = evaluateDerivedFields(catalog, fieldResolution.resolvedValues);
  partialStageMetrics["derivedFields"] = endStage(s3, derivedFieldResult.stageMetrics.counts);

  // Combined resolved values: source + derived
  const combinedResolvedValues: Record<string, unknown> = {
    ...fieldResolution.resolvedValues,
    ...derivedFieldResult.values,
  };

  // ── Stage 4: Field availability summary (pre-business-field) ─────────────
  // (Computed as part of decision packet later — tracked here for metrics)
  partialStageMetrics["fieldAvailability"] = endStage(startStage(), { summary: 1 });

  // ── Stage 5 + 6: Business field inference ────────────────────────────────
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
    partialStageMetrics["businessFields"] = endStage(s5, businessFieldResult.stageMetrics.counts);

    // Merge business field values into combined resolved values
    for (const [k, v] of Object.entries(businessFieldResult.values)) {
      if (v !== null && v !== undefined) combinedResolvedValues[k] = v;
    }
  } catch (err) {
    console.warn("[orchestrator] Business field inference failed:", err);
    partialStageMetrics["businessFields"] = endStage(s5, { error: 1 });
    // Continue without business fields
  }

  // Check if business field stage forces AGENT_REVIEW
  if (businessFieldResult?.requires_agent_review) {
    const bfFallbackReason = businessFieldResult.runFallbackReason ?? "required business fields could not be inferred";

    const emptyRuleResult = {
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

    const dp = buildDecisionPacket({
      runId,
      policyPack,
      rawCustomerData,
      fieldResolution,
      derivedFieldResult,
      businessFieldResult,
      ruleEvalResult: emptyRuleResult,
      sopText,
    });

    const fallbackOutput = buildFallbackOutput(bfFallbackReason, bfFallbackReason);

    return buildPipelineResult({
      runId, engineVersion: ENGINE_VERSION, policyVersion, timestamp, companyId,
      fallbackOutput,
      runFallbackReason: bfFallbackReason,
      selectionTrace: [],
      stageMetrics: partialStageMetrics,
      decisionPacket: dp,
      fieldResolution,
      derivedFieldResult,
      businessFieldResult,
      ruleEvalResult: emptyRuleResult,
      validationResult: null,
      rawCustomerData,
    });
  }

  // ── Stage 7: Evaluate rules + rank eligible treatments ───────────────────
  const s7 = startStage();
  const ruleEvalResult = evaluateTreatmentRules(treatments, combinedResolvedValues, defaultPriorityMap);
  partialStageMetrics["ruleEvaluation"] = endStage(s7, ruleEvalResult.stageMetrics.counts);

  // ── Stage 8: Assemble decision packet ────────────────────────────────────
  const s8 = startStage();
  const decisionPacket = buildDecisionPacket({
    runId,
    policyPack,
    rawCustomerData,
    fieldResolution,
    derivedFieldResult,
    businessFieldResult,
    ruleEvalResult,
    sopText,
  });
  partialStageMetrics["decisionPacket"] = endStage(s8, { built: 1 });

  // ── Deterministic fallback: no eligible treatments ───────────────────────
  if (ruleEvalResult.rankedEligibleTreatments.length === 0) {
    const fallbackOutput = buildFallbackOutput(
      "no eligible treatments",
      "No eligible treatments found for this customer after rule evaluation"
    );
    return buildPipelineResult({
      runId, engineVersion: ENGINE_VERSION, policyVersion, timestamp, companyId,
      fallbackOutput,
      runFallbackReason: "no eligible treatments",
      selectionTrace: ruleEvalResult.treatmentSelectionTrace,
      stageMetrics: partialStageMetrics,
      decisionPacket,
      fieldResolution,
      derivedFieldResult,
      businessFieldResult,
      ruleEvalResult,
      validationResult: null,
      rawCustomerData,
    });
  }

  // ── Stage 9: Final AI call ───────────────────────────────────────────────
  const s9 = startStage();
  const userPrompt = buildFinalDecisionUserPrompt(decisionPacket, ruleEvalResult);

  let finalAIOutput: FinalAIOutput;
  let validationResult: DecisionValidationResult | null = null;
  let aiRawText = "";
  let retryCount = 0;

  try {
    aiRawText = await callFinalDecisionAI(userPrompt);
    const parseResult = parseFinalAIOutput(aiRawText);

    if (!parseResult.ok) {
      // Structural parse failure — retry once
      retryCount = 1;
      const retryPrompt = buildFinalDecisionRetryPrompt(parseResult.error);
      aiRawText = await callFinalDecisionAI(`${userPrompt}\n\n${retryPrompt}`);
      const retryParseResult = parseFinalAIOutput(aiRawText);
      if (!retryParseResult.ok) {
        finalAIOutput = buildFallbackOutput("AI output could not be parsed after retry", "Structural parse failure after retry");
        validationResult = null;
      } else {
        finalAIOutput = retryParseResult.data;
      }
    } else {
      finalAIOutput = parseResult.data;
    }

    // ── Stage 10: Validate output ─────────────────────────────────────────
    if (finalAIOutput && finalAIOutput.recommended_treatment_code !== "AGENT_REVIEW") {
      validationResult = validateDecision(finalAIOutput, decisionPacket, ruleEvalResult.treatmentSelectionTrace);

      // ── Stage 11: Retry once on structural failure ────────────────────
      if (validationResult.status === "failed" && validationResult.failureType === "structural_failure" && retryCount === 0) {
        retryCount = 1;
        const issueList = validationResult.blockingIssues.map(i => i.message).join("; ");
        const retryPrompt = buildFinalDecisionRetryPrompt(issueList);
        const retryRaw = await callFinalDecisionAI(`${userPrompt}\n\n${retryPrompt}`);
        const retryParseResult = parseFinalAIOutput(retryRaw);
        if (retryParseResult.ok) {
          aiRawText = retryRaw;
          finalAIOutput = retryParseResult.data;
          validationResult = validateDecision(finalAIOutput, decisionPacket, ruleEvalResult.treatmentSelectionTrace);
        }
      }

      // After validation, if still failed for non-structural reasons → failed_validation record
      if (validationResult.status === "failed") {
        // Don't apply deterministic fallback for policy/guardrail/evidence failures
        // The failed_validation status is surfaced in aiRawOutput
      }
    }

  } catch (err) {
    console.error("[orchestrator] Final AI call failed:", err);
    finalAIOutput = buildFallbackOutput(
      "AI call failed: " + String(err).substring(0, 100),
      "AI call failed during final decision stage"
    );
  }

  partialStageMetrics["finalDecision"] = endStage(s9, { retryCount });

  return buildPipelineResult({
    runId, engineVersion: ENGINE_VERSION, policyVersion, timestamp, companyId,
    fallbackOutput: null,
    finalAIOutputOverride: finalAIOutput!,
    runFallbackReason: validationResult?.runFallbackReason ?? null,
    selectionTrace: validationResult?.updatedSelectionTrace ?? ruleEvalResult.treatmentSelectionTrace,
    stageMetrics: partialStageMetrics,
    decisionPacket,
    fieldResolution,
    derivedFieldResult,
    businessFieldResult,
    ruleEvalResult,
    validationResult,
    rawCustomerData,
    aiRawText,
  });
}

// ─── Result assembler ─────────────────────────────────────────────────────────

interface BuildResultArgs {
  runId: string;
  engineVersion: string;
  policyVersion: string;
  timestamp: string;
  companyId: string;
  fallbackOutput: FinalAIOutput | null;
  finalAIOutputOverride?: FinalAIOutput;
  runFallbackReason: string | null;
  selectionTrace: Array<{
    treatmentCode: string;
    priority: number | null;
    prioritySource: "configured" | "defaulted" | "missing";
    rank: number;
    isPreferred: boolean;
    selectionMode?: string;
    selectionReason?: string;
  }>;
  stageMetrics: Record<string, StageMetrics>;
  decisionPacket: DecisionPacket;
  fieldResolution: { resolvedValues: Record<string, unknown>; traces: Record<string, unknown> };
  derivedFieldResult: { values: Record<string, unknown>; traces: Record<string, unknown>; stageMetrics: StageMetrics };
  businessFieldResult: { values: Record<string, unknown>; traces: Record<string, unknown>; stageMetrics: StageMetrics } | null;
  ruleEvalResult: {
    eligibleTreatments: Array<{ code: string; name: string }>;
    rankedEligibleTreatments: unknown[];
    blockedTreatments: unknown[];
    treatmentRuleTrace: unknown[];
    stageMetrics: StageMetrics;
  };
  validationResult: DecisionValidationResult | null;
  rawCustomerData: Record<string, unknown>;
  aiRawText?: string;
}

function buildPipelineResult(args: BuildResultArgs): DecisionPipelineResult {
  const {
    runId, engineVersion, policyVersion, timestamp, companyId,
    fallbackOutput, finalAIOutputOverride, runFallbackReason, selectionTrace,
    stageMetrics, decisionPacket, fieldResolution, derivedFieldResult,
    businessFieldResult, ruleEvalResult, validationResult, rawCustomerData, aiRawText,
  } = args;

  const output = fallbackOutput ?? finalAIOutputOverride!;
  const customerGuid = output.customer_guid ?? decisionPacket.customer_guid ?? extractCustomerGuid(rawCustomerData);

  // Determine status for the decisions record
  let decisionStatus = "pending";
  if (validationResult?.status === "failed") {
    decisionStatus = "failed_validation";
  }

  const aiRawOutput = buildAiRawOutput({
    runId,
    policyVersion,
    stageMetrics,
    runFallbackReason: runFallbackReason ?? (output.recommended_treatment_code === "AGENT_REVIEW" ? (output.treatment_eligibility_explanation ?? null) : null),
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
    engineVersion,
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
    runFallbackReason: runFallbackReason,
    aiRawOutput,
    problemDescription: output.customer_situation ?? null,
    solutionEvidence: output.proposed_next_best_evidence ?? null,
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

function extractCustomerGuid(rawData: Record<string, unknown>): string | null {
  const v = rawData["customer / account / loan id"] ?? rawData.customer_id ?? rawData.account_id ?? rawData.customer_guid;
  if (v !== null && v !== undefined) return String(v);
  return null;
}

export { PolicyCompletenessError };
