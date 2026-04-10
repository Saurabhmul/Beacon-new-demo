import type { RankedTreatment, TreatmentSelectionTraceEntry } from "./types";
import type { DecisionPacket } from "./decision-packet";

// ─── Validator types ──────────────────────────────────────────────────────────

export type ValidationFailureType =
  | "structural_failure"
  | "policy_failure"
  | "guardrail_failure"
  | "evidence_failure";

export type ValidationStatus = "passed" | "warning" | "failed";

export interface ValidationIssue {
  failureType: ValidationFailureType;
  message: string;
  field?: string;
}

export interface DecisionValidationResult {
  status: ValidationStatus;
  failureType?: ValidationFailureType;
  blockingIssues: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Updated trace entries post-validation (selectionMode + selectionReason set for chosen treatment) */
  updatedSelectionTrace: TreatmentSelectionTraceEntry[];
  /** Run-level fallback reason (null for normal AI selections) */
  runFallbackReason: string | null;
}

// ─── Final AI output type ─────────────────────────────────────────────────────

export interface FinalAIOutput {
  customer_guid?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  days_past_due?: number | null;
  amount_due?: number | null;
  minimum_due?: number | null;
  additional_customer_context?: Record<string, unknown>;

  recent_payment_history_summary?: string | null;
  conversation_summary?: string | null;
  customer_situation?: string | null;
  customer_situation_confidence_score?: number | null;
  customer_situation_evidence?: unknown[];

  used_fields?: unknown[];
  used_rules?: unknown[];
  missing_information?: unknown[];
  key_factors_considered?: unknown[];

  structured_assessments?: Array<{ name?: unknown; value?: unknown; reason?: unknown }>;

  recommended_treatment_name?: string | null;
  recommended_treatment_code?: string | null;
  proposed_next_best_action?: string | null;
  treatment_eligibility_explanation?: string | null;
  blocked_conditions?: unknown[];
  proposed_next_best_confidence_score?: number | null;
  proposed_next_best_evidence?: string | null;

  requires_agent_review?: boolean | null;
  internal_action?: string | null;
  proposed_email_to_customer?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FALLBACK_CODES = new Set(["AGENT_REVIEW", "NO_ACTION"]);
const REQUIRED_TOP_LEVEL_KEYS: Array<keyof FinalAIOutput> = [
  "recommended_treatment_name",
  "recommended_treatment_code",
  "proposed_next_best_action",
  "treatment_eligibility_explanation",
  "requires_agent_review",
  "internal_action",
  "proposed_email_to_customer",
  "customer_situation",
  "customer_situation_confidence_score",
  "proposed_next_best_confidence_score",
  "used_fields",
  "used_rules",
  "structured_assessments",
];

// ─── Validator ────────────────────────────────────────────────────────────────

export function validateDecision(
  output: FinalAIOutput,
  decisionPacket: DecisionPacket,
  selectionTrace: TreatmentSelectionTraceEntry[]
): DecisionValidationResult {
  const blockingIssues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ── Layer 1: Structural failure ──────────────────────────────────────────
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (output[key] === undefined || output[key] === null) {
      if (key === "recommended_treatment_name" || key === "recommended_treatment_code") {
        blockingIssues.push({
          failureType: "structural_failure",
          message: `Missing required field: "${key}"`,
          field: key,
        });
      } else if (["used_fields", "used_rules", "structured_assessments"].includes(key as string)) {
        blockingIssues.push({
          failureType: "structural_failure",
          message: `Missing required array: "${key}"`,
          field: key,
        });
      }
    }
  }

  if (output.used_fields !== undefined && !Array.isArray(output.used_fields)) {
    blockingIssues.push({ failureType: "structural_failure", message: '"used_fields" must be an array', field: "used_fields" });
  }
  if (output.used_rules !== undefined && !Array.isArray(output.used_rules)) {
    blockingIssues.push({ failureType: "structural_failure", message: '"used_rules" must be an array', field: "used_rules" });
  }
  if (output.structured_assessments !== undefined && !Array.isArray(output.structured_assessments)) {
    blockingIssues.push({ failureType: "structural_failure", message: '"structured_assessments" must be an array', field: "structured_assessments" });
  }

  // Confidence scores must be integers 1–10
  for (const scoreKey of ["customer_situation_confidence_score", "proposed_next_best_confidence_score"] as const) {
    const score = output[scoreKey];
    if (score !== null && score !== undefined) {
      if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
        blockingIssues.push({
          failureType: "structural_failure",
          message: `"${scoreKey}" must be an integer between 1 and 10, got: ${JSON.stringify(score)}`,
          field: scoreKey,
        });
      }
    }
  }

  // requires_agent_review must be boolean
  if (output.requires_agent_review !== undefined && output.requires_agent_review !== null) {
    if (typeof output.requires_agent_review !== "boolean") {
      blockingIssues.push({
        failureType: "structural_failure",
        message: `"requires_agent_review" must be a boolean, got: ${typeof output.requires_agent_review}`,
        field: "requires_agent_review",
      });
    }
  }

  // Email format validation
  const emailVal = output.proposed_email_to_customer;
  if (emailVal && emailVal !== "NO_ACTION") {
    if (!emailVal.includes("Subject:")) {
      blockingIssues.push({ failureType: "structural_failure", message: "Email draft missing Subject", field: "proposed_email_to_customer" });
    }
    if (!emailVal.includes("Body:")) {
      blockingIssues.push({ failureType: "structural_failure", message: "Email draft missing Body", field: "proposed_email_to_customer" });
    }
    const lineCount = emailVal.split("\n").filter(l => l.trim()).length;
    if (lineCount > 10) {
      blockingIssues.push({ failureType: "structural_failure", message: "Email draft exceeds 10-line limit", field: "proposed_email_to_customer" });
    }
  }

  // Early exit on structural failures — don't run later checks on invalid output
  if (blockingIssues.length > 0) {
    return {
      status: "failed",
      failureType: "structural_failure",
      blockingIssues,
      warnings,
      updatedSelectionTrace: selectionTrace,
      runFallbackReason: null,
    };
  }

  const recommendedCode = (output.recommended_treatment_code ?? "").trim();
  const isRunFallback = FALLBACK_CODES.has(recommendedCode);

  // ── Layer 2: Policy failure ──────────────────────────────────────────────

  const allowedCodes = new Set([
    ...decisionPacket.rankedEligibleTreatments.map(t => t.code),
    "AGENT_REVIEW",
    "NO_ACTION",
  ]);

  if (!allowedCodes.has(recommendedCode)) {
    blockingIssues.push({
      failureType: "policy_failure",
      message: `Recommended treatment "${recommendedCode}" is not in the allowed list (not eligible, not AGENT_REVIEW, not NO_ACTION)`,
      field: "recommended_treatment_code",
    });
  }

  const blockedCodes = new Set(decisionPacket.blockedTreatments.map(t => t.code));
  if (blockedCodes.has(recommendedCode)) {
    blockingIssues.push({
      failureType: "policy_failure",
      message: `Recommended treatment "${recommendedCode}" is in the blocked list`,
      field: "recommended_treatment_code",
    });
  }

  // NO_ACTION justification check
  if (recommendedCode === "NO_ACTION") {
    const explanation = String(output.treatment_eligibility_explanation ?? "").toLowerCase();
    const keyFactors = (output.key_factors_considered ?? []).join(" ").toLowerCase();
    const noActionJustificationSignals = [
      "cooling", "cooldown", "wait", "waiting", "recent outreach", "no action required",
      "contact window", "policy window", "no review required", "no treatment needed",
    ];
    const hasJustification = noActionJustificationSignals.some(s =>
      explanation.includes(s) || keyFactors.includes(s)
    );
    if (!hasJustification) {
      blockingIssues.push({
        failureType: "policy_failure",
        message: "NO_ACTION recommended without traceable policy or contact-management justification",
        field: "recommended_treatment_code",
      });
    }
  }

  // ── Layer 3: Guardrail failure ───────────────────────────────────────────
  // Check: escalation flags active but AGENT_REVIEW not recommended
  if (decisionPacket.escalationFlags.length > 0 && recommendedCode !== "AGENT_REVIEW") {
    warnings.push({
      failureType: "guardrail_failure",
      message: `Escalation flags are active but AGENT_REVIEW was not recommended`,
    });
  }

  // Email consistency checks (only when email draft is present)
  if (emailVal && emailVal !== "NO_ACTION") {
    // Check: email allowed (not internal-only when active blockers)
    const activeBlockers = decisionPacket.guardrailFlags.length + decisionPacket.escalationFlags.length;
    const explanation = String(output.treatment_eligibility_explanation ?? "").toLowerCase();
    const activeBlockerDescriptions = [
      ...decisionPacket.guardrailFlags.map(f => f.description.toLowerCase()),
      ...decisionPacket.escalationFlags.map(f => f.description.toLowerCase()),
    ];
    const outreachProhibited = activeBlockerDescriptions.some(d =>
      d.includes("no contact") || d.includes("do not contact") || d.includes("no outreach") ||
      d.includes("deceased") || d.includes("legal hold") || d.includes("dispute")
    );
    if (outreachProhibited) {
      blockingIssues.push({
        failureType: "guardrail_failure",
        message: "Email drafted despite active blocker or guardrail prohibiting outreach",
        field: "proposed_email_to_customer",
      });
    }

    // Email content should not contradict treatment
    const emailLower = emailVal.toLowerCase();
    const treatmentLower = recommendedCode.toLowerCase();
    if (treatmentLower.includes("dca") && (emailLower.includes("payment plan") || emailLower.includes("instalment"))) {
      warnings.push({
        failureType: "evidence_failure",
        message: "Email content inconsistent with recommended treatment",
        field: "proposed_email_to_customer",
      });
    }
  }

  // ── Layer 4: Evidence failure ────────────────────────────────────────────
  // Check: used_fields references unknown fields
  const knownFieldIds = new Set([
    ...Object.keys(decisionPacket.sourceFields),
    ...Object.keys(decisionPacket.derivedFields),
    ...Object.keys(decisionPacket.businessFields),
  ]);

  const usedFields = (output.used_fields ?? []).map(String);
  const unknownUsedFields = usedFields.filter(f => {
    const lower = f.trim().toLowerCase();
    // Liberal check: if any known field contains this string, consider it known
    return !Array.from(knownFieldIds).some(k => {
      const kl = k.toLowerCase();
      return kl === lower || kl.includes(lower) || lower.includes(kl.replace("source:", ""));
    });
  });
  // Only add as warning for now — evidence checking should be conservative
  if (unknownUsedFields.length > 3) {
    warnings.push({
      failureType: "evidence_failure",
      message: `used_fields references ${unknownUsedFields.length} fields not found in decision packet`,
      field: "used_fields",
    });
  }

  // ── Priority-deviation check ─────────────────────────────────────────────
  const updatedTrace = [...selectionTrace];
  let runFallbackReason: string | null = null;

  if (!isRunFallback) {
    const chosenEntry = updatedTrace.find(e => e.treatmentCode === recommendedCode);
    const isPreferred = chosenEntry?.isPreferred ?? false;
    const preferredTreatments = decisionPacket.preferredTreatments;
    const isTiedPreferred = isPreferred && preferredTreatments.length > 1;

    if (isPreferred && !isTiedPreferred) {
      // Single preferred treatment chosen — normal case
      if (chosenEntry) {
        chosenEntry.selectionMode = "preferred";
        chosenEntry.selectionReason = `Highest-priority eligible treatment (rank ${chosenEntry.rank})`;
      }
    } else if (isTiedPreferred) {
      // Multiple tied preferred treatments — AI chose one
      const explanation = String(output.treatment_eligibility_explanation ?? "");
      if (chosenEntry) {
        chosenEntry.selectionMode = "tied_preferred";
        if (!explanation.trim()) {
          warnings.push({
            failureType: "guardrail_failure",
            message: "Tied preferred treatment chosen without documented reason",
            field: "treatment_eligibility_explanation",
          });
          chosenEntry.selectionReason = "Tied preferred treatment — no explicit reason documented";
        } else {
          chosenEntry.selectionReason = explanation.substring(0, 500);
        }
      }
    } else if (!isPreferred) {
      // Lower-ranked treatment chosen — check for justification
      const explanation = String(output.treatment_eligibility_explanation ?? "").toLowerCase();
      const hasReviewTrigger = decisionPacket.reviewTriggers.length > 0;
      const hasGuardrail = decisionPacket.guardrailFlags.length > 0;
      const hasMissingInfo = decisionPacket.missingCriticalInformation.length > 0;
      const hasExplicitJustification = explanation.length > 50;

      const hasJustification = hasReviewTrigger || hasGuardrail || hasMissingInfo || hasExplicitJustification;

      if (chosenEntry) {
        chosenEntry.selectionMode = "lower_rank_justified";
      }

      if (hasJustification) {
        warnings.push({
          failureType: "policy_failure",
          message: "Lower-priority treatment chosen; justification present",
          field: "recommended_treatment_code",
        });
        if (chosenEntry) {
          chosenEntry.selectionReason = String(output.treatment_eligibility_explanation ?? "").substring(0, 500);
        }
      } else {
        blockingIssues.push({
          failureType: "policy_failure",
          message: `Lower-priority treatment "${recommendedCode}" chosen without traceable justification (no review trigger, guardrail, missing info, or explicit reasoning)`,
          field: "recommended_treatment_code",
        });
        if (chosenEntry) {
          chosenEntry.selectionReason = "no justification found";
        }
      }
    }
  } else {
    // AGENT_REVIEW or NO_ACTION — run-level fallback, not in treatment trace
    if (recommendedCode === "AGENT_REVIEW") {
      runFallbackReason = String(output.treatment_eligibility_explanation ?? "no eligible treatments or policy requires agent review")
        .substring(0, 200);
    } else if (recommendedCode === "NO_ACTION") {
      runFallbackReason = String(output.treatment_eligibility_explanation ?? "no action required")
        .substring(0, 200);
    }
  }

  // ── Determine final status ───────────────────────────────────────────────
  if (blockingIssues.length > 0) {
    const failureType = blockingIssues[0].failureType;
    return {
      status: "failed",
      failureType,
      blockingIssues,
      warnings,
      updatedSelectionTrace: updatedTrace,
      runFallbackReason,
    };
  }

  return {
    status: warnings.length > 0 ? "warning" : "passed",
    blockingIssues: [],
    warnings,
    updatedSelectionTrace: updatedTrace,
    runFallbackReason,
  };
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

export function parseFinalAIOutput(rawText: string): { ok: true; data: FinalAIOutput } | { ok: false; error: string } {
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) jsonStr = objMatch[0];

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Response is not a JSON object" };
    }
    return { ok: true, data: parsed as FinalAIOutput };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
}
