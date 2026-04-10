import { describe, it, expect } from "vitest";
import { validateDecision, parseFinalAIOutput } from "../../server/lib/decisioning/decision-validator";
import type { FinalAIOutput } from "../../server/lib/decisioning/decision-validator";
import type { DecisionPacket } from "../../server/lib/decisioning/decision-packet";
import type { TreatmentSelectionTraceEntry } from "../../server/lib/decisioning/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function minimalAIOutput(overrides: Partial<FinalAIOutput> = {}): FinalAIOutput {
  return {
    customer_guid: "CUST001",
    customer_name: "John Doe",
    customer_phone: null,
    customer_email: null,
    days_past_due: 45,
    amount_due: 2500,
    minimum_due: null,
    additional_customer_context: {},
    recent_payment_history_summary: "No recent payments",
    conversation_summary: "No conversations",
    customer_situation: "Customer is 45 DPD with significant arrears",
    customer_situation_confidence_score: 8,
    customer_situation_evidence: ["DPD = 45"],
    used_fields: ["DPD", "amount_due"],
    used_rules: ["eligibility_rule_1"],
    missing_information: [],
    key_factors_considered: ["DPD"],
    structured_assessments: [{ name: "DPD Stage", value: "High", reason: "45 DPD" }],
    recommended_treatment_name: "Payment Plan",
    recommended_treatment_code: "PP",
    proposed_next_best_action: "Offer payment plan",
    treatment_eligibility_explanation: "Customer is eligible for payment plan based on DPD",
    blocked_conditions: [],
    proposed_next_best_confidence_score: 8,
    proposed_next_best_evidence: "DPD = 45",
    requires_agent_review: false,
    internal_action: "offer_payment_plan",
    proposed_email_to_customer: "NO_ACTION",
    ...overrides,
  };
}

function minimalDecisionPacket(overrides: Partial<DecisionPacket> = {}): DecisionPacket {
  return {
    runId: "run-001",
    engineVersion: "v2.1",
    policyVersion: "2024-01-01",
    timestamp: new Date().toISOString(),
    customer_guid: "CUST001",
    customer_name: "John Doe",
    customer_phone: null,
    customer_email: null,
    days_past_due: 45,
    amount_due: 2500,
    minimum_due: null,
    additional_customer_context: {},
    rankedEligibleTreatments: [
      { code: "PP", name: "Payment Plan", priority: 1, prioritySource: "configured", rank: 1, reasons: [], isPreferred: true },
      { code: "PTP", name: "Promise to Pay", priority: 2, prioritySource: "configured", rank: 2, reasons: [], isPreferred: false },
    ],
    preferredTreatments: [
      { code: "PP", name: "Payment Plan", priority: 1, prioritySource: "configured", rank: 1, reasons: [], isPreferred: true },
    ],
    blockedTreatments: [],
    escalationFlags: [],
    guardrailFlags: [],
    reviewTriggers: [],
    missingCriticalInformation: [],
    sourceFields: { "source:DPD": 45, "source:amount_due": 2500 },
    derivedFields: {},
    businessFields: {},
    communication: {
      guidelines: { communicationGuidelines: [], emailGuidelines: [], emailWhenToUse: [], emailWhenNotToUse: [], toneGuidance: [] },
      communicationSource: "default_empty",
    },
    decisionBasisSummary: {
      sourceFieldCount: 2,
      sourceFieldNullCount: 0,
      derivedComputed: 0,
      derivedNull: 0,
      derivedError: 0,
      derivedSkipped: 0,
      businessInferred: 0,
      businessNull: 0,
      businessFailed: 0,
      eligibleTreatmentCount: 2,
      blockedTreatmentCount: 0,
      preferredTreatmentCount: 1,
      missingCriticalInfoCount: 0,
    },
    fieldAvailabilitySummary: {
      hasLoanData: true,
      hasPaymentData: false,
      hasConversationData: false,
      hasBureauData: false,
      sourceFieldCounts: {},
    },
    rawPaymentData: [],
    rawConversationData: [],
    ...overrides,
  } as DecisionPacket;
}

function minimalSelectionTrace(overrides: Partial<TreatmentSelectionTraceEntry>[] = []): TreatmentSelectionTraceEntry[] {
  return [
    {
      treatmentCode: "PP",
      priority: 1,
      prioritySource: "configured",
      rank: 1,
      isPreferred: true,
      ...overrides[0],
    },
    {
      treatmentCode: "PTP",
      priority: 2,
      prioritySource: "configured",
      rank: 2,
      isPreferred: false,
      ...overrides[1],
    },
  ];
}

// ─── Tests: parseFinalAIOutput ────────────────────────────────────────────────

describe("parseFinalAIOutput", () => {
  it("parses clean JSON", () => {
    const input = JSON.stringify({ recommended_treatment_code: "PP", requires_agent_review: false });
    const result = parseFinalAIOutput(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.recommended_treatment_code).toBe("PP");
  });

  it("strips markdown code fences", () => {
    const input = "```json\n{\"recommended_treatment_code\":\"PP\"}\n```";
    const result = parseFinalAIOutput(input);
    expect(result.ok).toBe(true);
  });

  it("extracts JSON object from surrounding text", () => {
    const input = "Here is my response: {\"recommended_treatment_code\":\"PP\"} done.";
    const result = parseFinalAIOutput(input);
    expect(result.ok).toBe(true);
  });

  it("returns error for invalid JSON", () => {
    const result = parseFinalAIOutput("not json at all");
    expect(result.ok).toBe(false);
  });

  it("returns error for JSON array (not object)", () => {
    const result = parseFinalAIOutput("[1, 2, 3]");
    expect(result.ok).toBe(false);
  });
});

// ─── Tests: validateDecision ──────────────────────────────────────────────────

describe("validateDecision – structural failures", () => {
  it("passes for minimal valid output", () => {
    const result = validateDecision(minimalAIOutput(), minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).not.toBe("failed");
    expect(result.blockingIssues).toHaveLength(0);
  });

  it("fails when recommended_treatment_code is missing", () => {
    const output = minimalAIOutput({ recommended_treatment_code: undefined });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
    expect(result.blockingIssues.some(i => i.field === "recommended_treatment_code")).toBe(true);
  });

  it("fails when confidence score is not an integer", () => {
    const output = minimalAIOutput({ customer_situation_confidence_score: 7.5 });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });

  it("fails when confidence score is out of range (0)", () => {
    const output = minimalAIOutput({ proposed_next_best_confidence_score: 0 });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });

  it("fails when confidence score is out of range (11)", () => {
    const output = minimalAIOutput({ customer_situation_confidence_score: 11 });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });

  it("fails when requires_agent_review is a string not boolean", () => {
    const output = minimalAIOutput({ requires_agent_review: "yes" as unknown as boolean });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });

  it("fails when email draft is missing Subject:", () => {
    const output = minimalAIOutput({ proposed_email_to_customer: "Body: Just checking in" });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });

  it("fails when email draft is missing Body:", () => {
    const output = minimalAIOutput({ proposed_email_to_customer: "Subject: Hello" });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });

  it("accepts NO_ACTION as valid email value", () => {
    const output = minimalAIOutput({ proposed_email_to_customer: "NO_ACTION" });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.blockingIssues.some(i => i.field === "proposed_email_to_customer")).toBe(false);
  });

  it("fails when used_fields is not an array", () => {
    const output = minimalAIOutput({ used_fields: "DPD" as unknown as string[] });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("structural_failure");
  });
});

describe("validateDecision – policy failures", () => {
  it("fails when recommended code is not in eligible list", () => {
    const output = minimalAIOutput({ recommended_treatment_code: "GHOST_TREATMENT" });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("policy_failure");
  });

  it("fails when recommended code is a blocked treatment", () => {
    const packet = minimalDecisionPacket({
      blockedTreatments: [{ code: "PP", name: "Payment Plan", blockerType: "hard", reasons: ["hard blocked"] }],
    });
    const output = minimalAIOutput({ recommended_treatment_code: "PP" });
    const result = validateDecision(output, packet, minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("policy_failure");
  });

  it("fails for NO_ACTION without justification", () => {
    const output = minimalAIOutput({
      recommended_treatment_code: "NO_ACTION",
      recommended_treatment_name: "No Action",
      treatment_eligibility_explanation: "no justification given",
      requires_agent_review: false,
    });
    const packet = minimalDecisionPacket();
    const result = validateDecision(output, packet, minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("policy_failure");
  });

  it("accepts NO_ACTION with cooling-off justification", () => {
    const output = minimalAIOutput({
      recommended_treatment_code: "NO_ACTION",
      recommended_treatment_name: "No Action",
      treatment_eligibility_explanation: "Customer is in a cooling-off period after recent outreach",
      requires_agent_review: false,
      key_factors_considered: ["cooling off period active"],
    });
    const packet = minimalDecisionPacket({ rankedEligibleTreatments: [] });
    const result = validateDecision(output, packet, []);
    // should not have a policy_failure for NO_ACTION
    const noActionIssue = result.blockingIssues.find(i =>
      i.message.includes("NO_ACTION") && i.failureType === "policy_failure"
    );
    expect(noActionIssue).toBeUndefined();
  });

  it("fails when lower-priority treatment chosen without justification", () => {
    // Output recommends PTP (rank 2) over PP (rank 1, preferred)
    const output = minimalAIOutput({
      recommended_treatment_code: "PTP",
      recommended_treatment_name: "Promise to Pay",
      treatment_eligibility_explanation: "x",
      requires_agent_review: false,
    });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("policy_failure");
  });

  it("allows lower-priority treatment with explicit long justification", () => {
    const output = minimalAIOutput({
      recommended_treatment_code: "PTP",
      recommended_treatment_name: "Promise to Pay",
      treatment_eligibility_explanation: "The customer has stated a strong intent to pay in full by next Friday, making a formal payment plan unnecessary. Customer confirmed via recent conversation that full arrears will be cleared without requiring structured instalments.",
      requires_agent_review: false,
    });
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    // Should be a warning, not a blocking failure
    const hasBlockingPolicyIssue = result.blockingIssues.some(i => i.failureType === "policy_failure");
    const hasWarning = result.warnings.some(i => i.failureType === "policy_failure");
    expect(hasBlockingPolicyIssue).toBe(false);
    expect(hasWarning).toBe(true);
  });
});

describe("validateDecision – AGENT_REVIEW passthrough", () => {
  it("passes AGENT_REVIEW without validation (natural run-level outcome)", () => {
    const output = minimalAIOutput({
      recommended_treatment_code: "AGENT_REVIEW",
      recommended_treatment_name: "Agent Review",
      treatment_eligibility_explanation: "Complex case requiring human review",
      requires_agent_review: true,
    });
    // When AI returns AGENT_REVIEW, no validation is run by the orchestrator,
    // but if the validator is called with AGENT_REVIEW it should still pass
    const result = validateDecision(output, minimalDecisionPacket(), minimalSelectionTrace());
    // AGENT_REVIEW is in the allowed codes, so no policy_failure for code selection
    const codeIssue = result.blockingIssues.find(i => i.field === "recommended_treatment_code" && i.failureType === "policy_failure");
    expect(codeIssue).toBeUndefined();
  });
});

describe("validateDecision – preferred treatment selection trace", () => {
  it("sets selectionMode=preferred for single preferred treatment", () => {
    const output = minimalAIOutput({ recommended_treatment_code: "PP" });
    const trace = minimalSelectionTrace();
    const result = validateDecision(output, minimalDecisionPacket(), trace);
    expect(result.status).not.toBe("failed");
    const ppEntry = result.updatedSelectionTrace.find(e => e.treatmentCode === "PP");
    expect(ppEntry?.selectionMode).toBe("preferred");
  });

  it("sets selectionMode=tied_preferred when multiple preferred and justification ≥100 chars", () => {
    const packet = minimalDecisionPacket({
      preferredTreatments: [
        { code: "PP", name: "Payment Plan", priority: 1, prioritySource: "configured", rank: 1, reasons: [], isPreferred: true },
        { code: "PTP", name: "Promise to Pay", priority: 1, prioritySource: "configured", rank: 2, reasons: [], isPreferred: true },
      ],
      rankedEligibleTreatments: [
        { code: "PP", name: "Payment Plan", priority: 1, prioritySource: "configured", rank: 1, reasons: [], isPreferred: true },
        { code: "PTP", name: "Promise to Pay", priority: 1, prioritySource: "configured", rank: 2, reasons: [], isPreferred: true },
      ],
    });
    const trace: TreatmentSelectionTraceEntry[] = [
      { treatmentCode: "PP", priority: 1, prioritySource: "configured", rank: 1, isPreferred: true },
      { treatmentCode: "PTP", priority: 1, prioritySource: "configured", rank: 2, isPreferred: true },
    ];
    // Provide ≥100 char explanation to avoid tie-ambiguity blocking
    const output = minimalAIOutput({
      recommended_treatment_code: "PP",
      treatment_eligibility_explanation: "Both treatments are tied at priority 1. PP is preferred because the customer's account history shows they have previously engaged positively with structured payment arrangements, making PP more suitable.",
    });
    const result = validateDecision(output, packet, trace);
    expect(result.status).not.toBe("failed");
    const ppEntry = result.updatedSelectionTrace.find(e => e.treatmentCode === "PP");
    expect(ppEntry?.selectionMode).toBe("tied_preferred");
  });

  it("emits blocking policy_failure when tied preferred chosen without any reason", () => {
    const packet = minimalDecisionPacket({
      preferredTreatments: [
        { code: "PP", name: "Payment Plan", priority: 1, prioritySource: "configured", rank: 1, reasons: [], isPreferred: true },
        { code: "PTP", name: "Promise to Pay", priority: 1, prioritySource: "configured", rank: 2, reasons: [], isPreferred: true },
      ],
      rankedEligibleTreatments: [
        { code: "PP", name: "Payment Plan", priority: 1, prioritySource: "configured", rank: 1, reasons: [], isPreferred: true },
        { code: "PTP", name: "Promise to Pay", priority: 1, prioritySource: "configured", rank: 2, reasons: [], isPreferred: true },
      ],
    });
    const trace: TreatmentSelectionTraceEntry[] = [
      { treatmentCode: "PP", priority: 1, prioritySource: "configured", rank: 1, isPreferred: true },
      { treatmentCode: "PTP", priority: 1, prioritySource: "configured", rank: 2, isPreferred: true },
    ];
    const output = minimalAIOutput({
      recommended_treatment_code: "PP",
      treatment_eligibility_explanation: "",
    });
    const result = validateDecision(output, packet, trace);
    // Tied preferred without reason must be a blocking policy_failure
    // The orchestrator converts this to a deterministic AGENT_REVIEW fallback
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("policy_failure");
    const issue = result.blockingIssues.find(i =>
      i.field === "treatment_eligibility_explanation" &&
      i.message.toLowerCase().includes("tied preferred")
    );
    expect(issue).toBeDefined();
  });
});

describe("validateDecision – guardrail checks", () => {
  it("adds warning when escalation flags active and AGENT_REVIEW not recommended", () => {
    const packet = minimalDecisionPacket({
      escalationFlags: [{ type: "vulnerable_customer", description: "Customer flagged as vulnerable" }],
    });
    const output = minimalAIOutput({ recommended_treatment_code: "PP" });
    const result = validateDecision(output, packet, minimalSelectionTrace());
    const hasGuardrailWarning = result.warnings.some(w => w.failureType === "guardrail_failure");
    expect(hasGuardrailWarning).toBe(true);
  });

  it("blocks email when outreach-prohibited guardrail active", () => {
    const packet = minimalDecisionPacket({
      guardrailFlags: [{ type: "contact_restriction", description: "Do not contact this customer" }],
    });
    const output = minimalAIOutput({
      proposed_email_to_customer: "Subject: Hello\nBody: Checking in about your account",
    });
    const result = validateDecision(output, packet, minimalSelectionTrace());
    expect(result.status).toBe("failed");
    expect(result.failureType).toBe("guardrail_failure");
  });
});
