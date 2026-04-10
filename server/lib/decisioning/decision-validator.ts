import type { TreatmentSelectionTraceEntry } from "./types";
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
  updatedSelectionTrace: TreatmentSelectionTraceEntry[];
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

/**
 * All keys required by the full output schema — absence of any is a structural_failure.
 */
const REQUIRED_ALL_KEYS: Array<keyof FinalAIOutput> = [
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

const OUTREACH_PROHIBITED_SIGNALS = [
  "no contact", "do not contact", "no outreach", "do not call",
  "deceased", "legal hold", "legal dispute", "in dispute",
  "ceased contact", "opted out", "unsubscribed",
  "communication ban", "do not email",
];

const INTERNAL_ONLY_ACTION_SIGNALS = [
  "system_hold", "escalate_internal", "flag_only", "monitor_only", "internal_only",
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
  // All required keys must be present — absence is always structural_failure
  for (const key of REQUIRED_ALL_KEYS) {
    const val = output[key];
    if (val === undefined || val === null) {
      blockingIssues.push({
        failureType: "structural_failure",
        message: `Missing required field: "${key}"`,
        field: key,
      });
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

  for (const scoreKey of ["customer_situation_confidence_score", "proposed_next_best_confidence_score"] as const) {
    const score = output[scoreKey];
    if (score !== null && score !== undefined) {
      if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
        blockingIssues.push({
          failureType: "structural_failure",
          message: `"${scoreKey}" must be an integer 1–10, got: ${JSON.stringify(score)}`,
          field: scoreKey,
        });
      }
    }
  }

  if (output.requires_agent_review !== undefined && output.requires_agent_review !== null) {
    if (typeof output.requires_agent_review !== "boolean") {
      blockingIssues.push({
        failureType: "structural_failure",
        message: `"requires_agent_review" must be a boolean, got: ${typeof output.requires_agent_review}`,
        field: "requires_agent_review",
      });
    }
  }

  const emailVal = output.proposed_email_to_customer;
  if (emailVal && emailVal !== "NO_ACTION") {
    if (!emailVal.includes("Subject:")) {
      blockingIssues.push({ failureType: "structural_failure", message: "Email draft missing Subject:", field: "proposed_email_to_customer" });
    }
    if (!emailVal.includes("Body:")) {
      blockingIssues.push({ failureType: "structural_failure", message: "Email draft missing Body:", field: "proposed_email_to_customer" });
    }
    const lineCount = emailVal.split("\n").filter(l => l.trim()).length;
    if (lineCount > 10) {
      blockingIssues.push({ failureType: "structural_failure", message: "Email draft exceeds 10-line limit", field: "proposed_email_to_customer" });
    }
  }

  // Early-exit on structural failures
  if (blockingIssues.length > 0) {
    return {
      status: "failed",
      failureType: "structural_failure",
      blockingIssues,
      warnings,
      updatedSelectionTrace: selectionTrace,
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
      message: `Recommended treatment "${recommendedCode}" is not in the allowed list`,
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

  if (recommendedCode === "NO_ACTION") {
    const explanation = String(output.treatment_eligibility_explanation ?? "").toLowerCase();
    const keyFactors = (output.key_factors_considered ?? []).join(" ").toLowerCase();
    const noActionSignals = [
      "cooling", "cooldown", "wait", "waiting", "recent outreach", "no action required",
      "contact window", "policy window", "no review required", "no treatment needed",
    ];
    if (!noActionSignals.some(s => explanation.includes(s) || keyFactors.includes(s))) {
      blockingIssues.push({
        failureType: "policy_failure",
        message: "NO_ACTION recommended without traceable policy or contact-management justification",
        field: "recommended_treatment_code",
      });
    }
  }

  // ── Layer 3: Guardrail failure ───────────────────────────────────────────

  if (decisionPacket.escalationFlags.length > 0 && !isRunFallback) {
    warnings.push({
      failureType: "guardrail_failure",
      message: "Escalation flags active but AGENT_REVIEW was not recommended",
    });
  }

  const allFlagDescriptions = [
    ...decisionPacket.guardrailFlags.map(f => f.description.toLowerCase()),
    ...decisionPacket.escalationFlags.map(f => f.description.toLowerCase()),
  ];
  const outreachProhibited = allFlagDescriptions.some(d =>
    OUTREACH_PROHIBITED_SIGNALS.some(signal => d.includes(signal))
  );

  if (emailVal && emailVal !== "NO_ACTION") {
    if (outreachProhibited) {
      blockingIssues.push({
        failureType: "guardrail_failure",
        message: "Email drafted despite active flag prohibiting customer outreach",
        field: "proposed_email_to_customer",
      });
    }

    const internalActionLower = String(output.internal_action ?? "").toLowerCase();
    if (INTERNAL_ONLY_ACTION_SIGNALS.some(s => internalActionLower.includes(s))) {
      blockingIssues.push({
        failureType: "guardrail_failure",
        message: `Email drafted for internal-only action: "${output.internal_action}"`,
        field: "proposed_email_to_customer",
      });
    }

    // emailWhenNotToUse: blocking guardrail_failure
    const emailWhenNotToUse = decisionPacket.communication?.guidelines?.emailWhenNotToUse ?? [];
    if (emailWhenNotToUse.length > 0) {
      const emailLower = emailVal.toLowerCase();
      const explanationLower = String(output.treatment_eligibility_explanation ?? "").toLowerCase();
      for (const rule of emailWhenNotToUse) {
        const ruleSignals = rule.toLowerCase().split(/[\s,;]+/).filter(t => t.length > 4);
        if (ruleSignals.some(s => emailLower.includes(s) || explanationLower.includes(s))) {
          blockingIssues.push({
            failureType: "guardrail_failure",
            message: `Email violates emailWhenNotToUse guideline: "${rule}"`,
            field: "proposed_email_to_customer",
          });
          break;
        }
      }
    }

    // Email treatment-consistency: blocking evidence_failure when email contradicts recommended treatment
    const emailLower = emailVal.toLowerCase();
    const treatmentLower = recommendedCode.toLowerCase();
    if (treatmentLower.includes("dca") && (emailLower.includes("payment plan") || emailLower.includes("instalment"))) {
      blockingIssues.push({
        failureType: "evidence_failure",
        message: "Email content describes payment plan/instalment for a DCA treatment — invented treatment context",
        field: "proposed_email_to_customer",
      });
    }
    if (!treatmentLower.includes("hardship") && emailLower.includes("hardship arrangement") && emailLower.includes("formal hardship")) {
      blockingIssues.push({
        failureType: "evidence_failure",
        message: "Email references formal hardship arrangement but recommended treatment is not a hardship treatment",
        field: "proposed_email_to_customer",
      });
    }

    // Email invented-facts check: blocking evidence_failure when email references facts
    // that are inconsistent with or absent from the decision packet customer data.
    const sourceFields = decisionPacket.sourceFields ?? {};
    // Check customer name: if email addresses a named individual not in the record
    const dpName = String(sourceFields["customer_name"] ?? sourceFields["full_name"] ?? sourceFields["name"] ?? "").toLowerCase().trim();
    if (dpName && dpName.length > 2) {
      const bodyMatch = emailLower.match(/body:([\s\S]*?)(?:subject:|$)/i);
      const emailBody = bodyMatch ? bodyMatch[1] : emailLower;
      const nameWords = dpName.split(/\s+/).filter(w => w.length > 2);
      const mentionsWrongName = nameWords.every(w => !emailBody.includes(w));
      const mentionsAnyProperNoun = /dear\s+[a-z]+/.test(emailBody);
      if (mentionsAnyProperNoun && mentionsWrongName) {
        blockingIssues.push({
          failureType: "evidence_failure",
          message: "Email salutation references a name that does not match the customer record — invented personal detail",
          field: "proposed_email_to_customer",
        });
      }
    }
    // Check amount: if email states a numerical amount wildly inconsistent with decision packet
    const dpAmount = parseFloat(String(sourceFields["amount_due"] ?? sourceFields["outstanding_balance"] ?? ""));
    if (!isNaN(dpAmount) && dpAmount > 0) {
      const amountMatches = emailLower.match(/[\$£€]?\s*(\d[\d,.]+)/g) ?? [];
      const emailAmounts = amountMatches
        .map(s => parseFloat(s.replace(/[^0-9.]/g, "")))
        .filter(n => !isNaN(n) && n > 10);
      const hasInventedAmount = emailAmounts.some(a => Math.abs(a - dpAmount) / dpAmount > 0.5 && Math.abs(a - dpAmount) > 50);
      if (hasInventedAmount) {
        blockingIssues.push({
          failureType: "evidence_failure",
          message: "Email states a monetary amount significantly different from the outstanding balance in the decision packet — invented financial fact",
          field: "proposed_email_to_customer",
        });
      }
    }
  }

  // ── Layer 4: Evidence failure ────────────────────────────────────────────

  const knownFieldIds = new Set([
    ...Object.keys(decisionPacket.sourceFields),
    ...Object.keys(decisionPacket.derivedFields),
    ...Object.keys(decisionPacket.businessFields),
  ]);

  const usedFields = (output.used_fields ?? []).map(String);
  const unknownUsedFields = usedFields.filter(f => {
    const lower = f.trim().toLowerCase();
    return !Array.from(knownFieldIds).some(k => {
      const kl = k.toLowerCase().replace("source:", "");
      return kl === lower || kl.includes(lower) || lower.includes(kl);
    });
  });

  if (usedFields.length > 0 && unknownUsedFields.length > Math.max(3, Math.ceil(usedFields.length / 2))) {
    blockingIssues.push({
      failureType: "evidence_failure",
      message: `used_fields has ${unknownUsedFields.length}/${usedFields.length} unknown fields — possible hallucinated evidence`,
      field: "used_fields",
    });
  } else if (unknownUsedFields.length > 3) {
    warnings.push({
      failureType: "evidence_failure",
      message: `used_fields references ${unknownUsedFields.length} fields not found in decision packet`,
      field: "used_fields",
    });
  }

  // ── Priority-deviation & tie-ambiguity checks ────────────────────────────
  const updatedTrace = [...selectionTrace];

  if (!isRunFallback) {
    const chosenEntry = updatedTrace.find(e => e.treatmentCode === recommendedCode);
    const isPreferred = chosenEntry?.isPreferred ?? false;
    const isTiedPreferred = isPreferred && decisionPacket.preferredTreatments.length > 1;

    if (isPreferred && !isTiedPreferred) {
      if (chosenEntry) {
        chosenEntry.selectionMode = "preferred";
        chosenEntry.selectionReason = `Highest-priority eligible treatment (rank ${chosenEntry.rank})`;
      }
    } else if (isTiedPreferred) {
      // Tied preferred: AI chose one from multiple equally-ranked preferred treatments.
      // Document the choice; emit a guardrail_failure WARNING if no reason given.
      // Per spec: this is WARNING-only — orchestrator does NOT force fallback.
      const explanation = String(output.treatment_eligibility_explanation ?? "").trim();
      if (chosenEntry) chosenEntry.selectionMode = "tied_preferred";
      if (!explanation) {
        warnings.push({
          failureType: "guardrail_failure",
          message: "Tied preferred treatment selected without documented selection reason — audit recommended",
          field: "treatment_eligibility_explanation",
        });
        if (chosenEntry) chosenEntry.selectionReason = "Tied preferred treatment — no reason documented";
      } else {
        if (chosenEntry) chosenEntry.selectionReason = explanation.substring(0, 500);
      }
    } else {
      // Lower-ranked treatment
      const explanation = String(output.treatment_eligibility_explanation ?? "");
      const hasContextualJustification =
        decisionPacket.reviewTriggers.length > 0 ||
        decisionPacket.guardrailFlags.length > 0 ||
        decisionPacket.missingCriticalInformation.length > 0;
      const hasExplicitJustification = explanation.length >= 100;

      if (chosenEntry) chosenEntry.selectionMode = "lower_rank_justified";

      if (hasContextualJustification || hasExplicitJustification) {
        warnings.push({
          failureType: "policy_failure",
          message: "Lower-priority treatment chosen; contextual justification present",
          field: "recommended_treatment_code",
        });
        if (chosenEntry) chosenEntry.selectionReason = explanation.substring(0, 500);
      } else {
        blockingIssues.push({
          failureType: "policy_failure",
          message: `Lower-priority treatment "${recommendedCode}" chosen without traceable justification`,
          field: "recommended_treatment_code",
        });
        if (chosenEntry) chosenEntry.selectionReason = "no justification found";
      }
    }
  }
  // AGENT_REVIEW / NO_ACTION are run-level outcomes — trace not modified here

  // ── Final status ─────────────────────────────────────────────────────────
  if (blockingIssues.length > 0) {
    return {
      status: "failed",
      failureType: blockingIssues[0].failureType,
      blockingIssues,
      warnings,
      updatedSelectionTrace: updatedTrace,
    };
  }

  return {
    status: warnings.length > 0 ? "warning" : "passed",
    blockingIssues: [],
    warnings,
    updatedSelectionTrace: updatedTrace,
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
