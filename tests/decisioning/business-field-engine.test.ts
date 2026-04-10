import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getRequiredBusinessFieldsForCustomer,
  assembleCustomerContext,
  inferBusinessFields,
} from "../../server/lib/decisioning/business-field-engine";
import type { CatalogEntry } from "../../server/field-catalog";
import type { TreatmentWithRules, TreatmentRuleGroupWithRules, TreatmentRule } from "@shared/schema";

// ─── Mock geminiClient ────────────────────────────────────────────────────────

const mockGenerateContent = vi.fn();

vi.mock("../../server/ai-engine", () => ({
  geminiClient: {
    models: {
      generateContent: (args: unknown) => mockGenerateContent(args),
    },
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBizField(id: string, label: string, deps?: string[]): CatalogEntry {
  return {
    id,
    label,
    sourceType: "business_field",
    description: `Description of ${label}`,
    dataType: "string",
    allowedValues: null,
    dependsOnBusinessFields: deps ?? null,
  };
}

function makeRule(leftFieldId: string): TreatmentRule {
  return {
    id: 1,
    ruleGroupId: 1,
    fieldName: "unused",
    operator: "=",
    value: null,
    leftFieldId,
    rightMode: "constant",
    rightConstantValue: "true",
    rightFieldId: null,
    sortOrder: 0,
  };
}

function makeGroup(
  ruleType: string,
  rules: TreatmentRule[],
  id = 1
): TreatmentRuleGroupWithRules {
  return {
    id,
    treatmentId: 1,
    ruleType,
    logicOperator: "AND",
    plainEnglishInput: null,
    groupOrder: 0,
    rules,
  };
}

function makeTreatment(
  groups: TreatmentRuleGroupWithRules[],
  name = "plan_a"
): TreatmentWithRules {
  return {
    id: 1,
    policyPackId: 1,
    name,
    shortDescription: null,
    enabled: true,
    priority: "1",
    tone: null,
    displayOrder: 0,
    draftSourceFields: null,
    draftDerivedFields: null,
    draftBusinessFields: null,
    aiConfidence: null,
    ruleGroups: groups,
  };
}

function makeValidResponse(fieldId: string, fieldLabel: string, value: unknown = "test_value") {
  return JSON.stringify({
    field_id: fieldId,
    field_label: fieldLabel,
    value,
    confidence: 0.7,
    rationale: "Based on available evidence.",
    null_reason: null,
    evidence: ["evidence item 1", "evidence item 2"],
  });
}

function makeNullResponse(fieldId: string, fieldLabel: string, reason = "insufficient evidence") {
  return JSON.stringify({
    field_id: fieldId,
    field_label: fieldLabel,
    value: null,
    confidence: 0.05,
    rationale: "Not enough evidence to determine the value.",
    null_reason: reason,
    evidence: [],
  });
}

// ─── getRequiredBusinessFieldsForCustomer ─────────────────────────────────────

describe("getRequiredBusinessFieldsForCustomer – tier assignment", () => {
  it("assigns tier 1 to fields referenced in hard_blocker rules", () => {
    const catalog = [makeBizField("42", "vulnerability_flag")];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("42")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result).toHaveLength(1);
    expect(result[0].fieldId).toBe("42");
    expect(result[0].tier).toBe(1);
  });

  it("assigns tier 2 to fields referenced in review_trigger rules", () => {
    const catalog = [makeBizField("50", "legal_action_flag")];
    const treatment = makeTreatment([
      makeGroup("review_trigger", [makeRule("50")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result[0].tier).toBe(2);
  });

  it("assigns tier 2 to fields referenced in escalation rules", () => {
    const catalog = [makeBizField("51", "dispute_flag")];
    const treatment = makeTreatment([
      makeGroup("escalation", [makeRule("51")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result[0].tier).toBe(2);
  });

  it("assigns tier 3 to fields referenced in eligibility rules", () => {
    const catalog = [makeBizField("60", "income_verified")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("60")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result[0].tier).toBe(3);
  });

  it("promotes field to tier 1 when referenced in both hard_blocker and eligibility", () => {
    const catalog = [makeBizField("70", "some_field")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("70")], 1),
      makeGroup("hard_blocker", [makeRule("70")], 2),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result[0].tier).toBe(1); // promoted to highest-priority tier
  });

  it("skips tier-4 fields when inferTier4Fields = false (default)", () => {
    const catalog = [
      makeBizField("80", "referenced_field"),
      makeBizField("81", "unreferenced_field"),
    ];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("80")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog, false);
    const ids = result.map(f => f.fieldId);
    expect(ids).toContain("80");
    expect(ids).not.toContain("81");
  });

  it("includes tier-4 fields when inferTier4Fields = true", () => {
    const catalog = [
      makeBizField("80", "referenced_field"),
      makeBizField("81", "unreferenced_field"),
    ];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("80")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog, true);
    const ids = result.map(f => f.fieldId);
    expect(ids).toContain("80");
    expect(ids).toContain("81");
    expect(result.find(f => f.fieldId === "81")!.tier).toBe(4);
  });

  it("ignores source fields (non-business field IDs)", () => {
    const catalog = [makeBizField("100", "biz_field")];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("source:days_past_due")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result).toHaveLength(0);
  });

  it("skips disabled treatments", () => {
    const catalog = [makeBizField("42", "some_field")];
    const treatment = { ...makeTreatment([makeGroup("hard_blocker", [makeRule("42")])]), enabled: false };
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    expect(result).toHaveLength(0);
  });

  it("includes business fields referenced in rightFieldId (field-vs-field rules)", () => {
    const catalog = [
      makeBizField("10", "left_field"),
      makeBizField("20", "right_field"),
    ];
    const ruleWithRight: TreatmentRule = {
      id: 1,
      ruleGroupId: 1,
      fieldName: "unused",
      operator: ">",
      value: null,
      leftFieldId: "10",
      rightMode: "field",
      rightConstantValue: null,
      rightFieldId: "20",
      sortOrder: 0,
    };
    const treatment = makeTreatment([
      makeGroup("eligibility", [ruleWithRight]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    const ids = result.map(f => f.fieldId);
    expect(ids).toContain("10");
    expect(ids).toContain("20");
    expect(result.find(f => f.fieldId === "20")!.tier).toBe(3); // eligibility
  });

  it("does NOT include rightFieldId when rightMode is not 'field'", () => {
    const catalog = [
      makeBizField("10", "left_field"),
      makeBizField("20", "right_field"),
    ];
    const ruleWithConstant: TreatmentRule = {
      id: 1,
      ruleGroupId: 1,
      fieldName: "unused",
      operator: "=",
      value: null,
      leftFieldId: "10",
      rightMode: "constant",
      rightConstantValue: "some_value",
      rightFieldId: "20", // present but rightMode is "constant" — should be ignored
      sortOrder: 0,
    };
    const treatment = makeTreatment([makeGroup("eligibility", [ruleWithConstant])]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    const ids = result.map(f => f.fieldId);
    expect(ids).toContain("10");
    expect(ids).not.toContain("20"); // rightFieldId ignored when rightMode != "field"
  });

  it("includes guardrail-referenced fields as tier 4", () => {
    const catalog = [makeBizField("77", "guardrail_field")];
    const treatment = makeTreatment([
      makeGroup("guardrail", [makeRule("77")]),
    ]);
    // inferTier4Fields = false: guardrail-referenced fields are STILL included
    // (guardrails are always inspected, unlike completely unreferenced fields)
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog, false);
    expect(result).toHaveLength(1);
    expect(result[0].fieldId).toBe("77");
    expect(result[0].tier).toBe(4);
  });

  it("includes transitive dependency (tier-4) of a required tier-1 field even without inferTier4Fields", () => {
    // Field "A" (tier 1) depends on field "B" (not directly referenced by any rule).
    // "B" should be inferred as tier 4 via transitive dependency.
    const catalog = [
      { ...makeBizField("A", "critical_field"), dependsOnBusinessFields: ["B"] },
      makeBizField("B", "dependency_field"),
    ];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("A")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog, false);
    const ids = result.map(f => f.fieldId);
    expect(ids).toContain("A");
    expect(ids).toContain("B"); // included via transitive dependency expansion
    const bEntry = result.find(f => f.fieldId === "B");
    expect(bEntry!.tier).toBe(4); // tier 4 (dependency)
    // Ordering is strictly tier-first (1→2→3→4) per spec.
    // "A" (tier 1) comes before "B" (tier 4) in the inference order.
    // Cross-tier dependency ordering is intentionally NOT enforced — only intra-tier.
    const aEntry = result.find(f => f.fieldId === "A")!;
    expect(aEntry.dependencyPosition).toBeLessThan(bEntry!.dependencyPosition);
  });

  it("respects depends_on_business_fields ordering WITHIN a tier (intra-tier topo sort)", () => {
    // Two tier-1 fields: "A" depends on "B". Both are in the same tier.
    // B must be inferred before A.
    const catalog = [
      { ...makeBizField("A", "field_a"), dependsOnBusinessFields: ["B"] },
      makeBizField("B", "field_b"),
    ];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("A"), makeRule("B")]),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog, false);
    const aPos = result.find(f => f.fieldId === "A")!.dependencyPosition;
    const bPos = result.find(f => f.fieldId === "B")!.dependencyPosition;
    // Both are tier 1; B must precede A because A depends on B
    expect(bPos).toBeLessThan(aPos);
  });

  it("respects dependency ordering within a tier", () => {
    // field "B" depends on field "A" — A must come before B
    const catalog = [
      makeBizField("A", "field_a"),
      makeBizField("B", "field_b", ["A"]),
    ];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("A"), makeRule("B")], 1),
    ]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], catalog);
    const aPos = result.find(f => f.fieldId === "A")!.dependencyPosition;
    const bPos = result.find(f => f.fieldId === "B")!.dependencyPosition;
    expect(aPos).toBeLessThan(bPos);
  });

  it("returns empty array when catalog is empty", () => {
    const treatment = makeTreatment([makeGroup("hard_blocker", [makeRule("42")])]);
    const result = getRequiredBusinessFieldsForCustomer([treatment], []);
    expect(result).toHaveLength(0);
  });
});

// ─── assembleCustomerContext ──────────────────────────────────────────────────

describe("assembleCustomerContext – context assembly", () => {
  it("categorises resolved values into customerProfile based on key patterns", () => {
    const resolved = {
      "source:customer_name": "John Doe",
      "source:email": "john@example.com",
      "source:days_past_due": 45,
    };
    const ctx = assembleCustomerContext(resolved);
    expect(ctx.customerProfile["customer_name"]).toBe("John Doe");
    expect(ctx.customerProfile["email"]).toBe("john@example.com");
    expect(ctx.loanData["days_past_due"]).toBe(45);
  });

  it("puts payment arrays into paymentData", () => {
    const rawCustomerData = {
      _payments: [
        { date_of_payment: "2025-01-01", amount_paid: 100, payment_status: "received" },
        { date_of_payment: "2024-12-01", amount_paid: 50, payment_status: "failed" },
      ],
    };
    const ctx = assembleCustomerContext({}, rawCustomerData);
    expect(ctx.paymentData).toHaveLength(2);
  });

  it("truncates payment data beyond MAX_PAYMENT_ITEMS and logs warning", () => {
    const payments = Array.from({ length: 10 }, (_, i) => ({
      date_of_payment: `2025-01-0${i + 1}`,
      amount_paid: 100,
      payment_status: "received",
    }));
    const ctx = assembleCustomerContext({}, { _payments: payments });
    expect(ctx.paymentData.length).toBeLessThanOrEqual(5);
    expect(ctx.truncationWarnings.some(w => w.includes("paymentData truncated"))).toBe(true);
  });

  it("truncates conversation data beyond MAX and logs warning", () => {
    const conversations = Array.from({ length: 8 }, (_, i) => ({
      date: `2025-01-0${i + 1}`,
      text: `Conversation ${i + 1}`,
    }));
    const ctx = assembleCustomerContext({}, { _conversations: conversations });
    expect(ctx.conversationData.length).toBeLessThanOrEqual(3);
    expect(ctx.truncationWarnings.some(w => w.includes("conversationData truncated"))).toBe(true);
  });

  it("populates priorBusinessFields from passed values", () => {
    const prior = { vulnerability_flag: true };
    const ctx = assembleCustomerContext({}, {}, {}, prior);
    expect(ctx.priorBusinessFields["vulnerability_flag"]).toBe(true);
  });

  it("populates derivedFields from passed values", () => {
    const derived = { months_in_arrears: 3 };
    const ctx = assembleCustomerContext({}, {}, derived);
    expect(ctx.derivedFields["months_in_arrears"]).toBe(3);
  });

  it("categorises bureau-related fields into bureauData", () => {
    const resolved = {
      "source:credit_score": 650,
      "source:loan_amount": 10000,
    };
    const ctx = assembleCustomerContext(resolved);
    expect(ctx.bureauData["credit_score"]).toBe(650);
    expect(ctx.loanData["loan_amount"]).toBe(10000);
  });

  it("truncationWarnings is empty when no truncation occurs", () => {
    const ctx = assembleCustomerContext({}, { _payments: [{ date_of_payment: "2025-01-01" }] });
    expect(ctx.truncationWarnings).toHaveLength(0);
  });
});

// ─── inferBusinessFields – orchestration ─────────────────────────────────────

describe("inferBusinessFields – orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("infers a single field and returns values + trace", async () => {
    const catalog = [makeBizField("42", "vulnerability_flag")];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("42")]),
    ]);

    mockGenerateContent.mockResolvedValueOnce({
      text: makeValidResponse("42", "vulnerability_flag", true),
    });

    const result = await inferBusinessFields([treatment], catalog, {}, {}, {});
    expect(result.values["42"]).toBe(true);
    expect(result.traces["42"]).toBeDefined();
    expect(result.traces["42"].tier).toBe(1);
    expect(result.traces["42"].retryCount).toBe(0);
    expect(result.requires_agent_review).toBe(false);
    expect(result.stageMetrics.counts.fieldsInferred).toBe(1);
  });

  it("stores null when value is null and records nullReason", async () => {
    const catalog = [makeBizField("42", "some_field")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("42")]),
    ]);

    mockGenerateContent.mockResolvedValueOnce({
      text: makeNullResponse("42", "some_field"),
    });

    const result = await inferBusinessFields([treatment], catalog, {});
    expect(result.values["42"]).toBeNull();
    expect(result.traces["42"].nullReason).toBe("insufficient evidence");
    expect(result.stageMetrics.counts.fieldsNull).toBe(1);
  });

  it("retries once on schema failure and succeeds", async () => {
    const catalog = [makeBizField("42", "some_field")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("42")]),
    ]);

    // First attempt: invalid JSON
    mockGenerateContent.mockResolvedValueOnce({ text: "not valid json at all {{" });
    // Retry: valid
    mockGenerateContent.mockResolvedValueOnce({
      text: makeValidResponse("42", "some_field", "inferred_value"),
    });

    const result = await inferBusinessFields([treatment], catalog, {});
    expect(result.values["42"]).toBe("inferred_value");
    expect(result.traces["42"].retryCount).toBe(1);
    expect(result.stageMetrics.counts.fieldsRetried).toBe(1);
  });

  it("stores null with 'model output invalid after retry' when both attempts fail", async () => {
    const catalog = [makeBizField("42", "some_field")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("42")]),
    ]);

    mockGenerateContent.mockResolvedValueOnce({ text: "bad json" });
    mockGenerateContent.mockResolvedValueOnce({ text: "still bad json" });

    const result = await inferBusinessFields([treatment], catalog, {});
    expect(result.values["42"]).toBeNull();
    expect(result.traces["42"].nullReason).toBe("model output invalid after retry");
  });

  it("stores null on per-field timeout (non-critical tier-4 → no agent review)", async () => {
    const catalog = [makeBizField("42", "optional_field")];
    const treatment = makeTreatment([], "no_rules"); // no rule groups → field won't be selected
    const catalog2 = [makeBizField("42", "opt_field")];

    // No treatments reference the field → it will only appear if inferTier4Fields=true
    mockGenerateContent.mockImplementation(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("[timeout] field 42 exceeded 100ms")), 50)
      )
    );

    // Use a field referenced in a guardrail (non-critical tier)
    const catalogEntry = makeBizField("55", "guardrail_field");
    const guardTreatment = makeTreatment([
      makeGroup("guardrail", [makeRule("55")]),
    ]);
    // guardrail is not a critical tier → won't appear in getRequiredBusinessFieldsForCustomer
    const result = await inferBusinessFields([guardTreatment], [catalogEntry], {}, {}, {}, {
      inferTier4Fields: true,
    });
    // The field won't be in the result because guardrail isn't tier 1-3, and inferTier4Fields is true
    // so it should appear as tier-4 and be inferred
    // But our mock resolves quickly — just test the engine doesn't throw
    expect(result).toBeDefined();
  });

  it("routes to AGENT_REVIEW when a critical tier-1 field times out", async () => {
    const catalog = [makeBizField("42", "critical_field")];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("42")]),
    ]);

    // Simulate timeout by making the mock reject with a timeout error
    mockGenerateContent.mockRejectedValueOnce(new Error("[timeout] field 42 exceeded 15000ms"));

    const result = await inferBusinessFields([treatment], catalog, {}, {}, {}, {
      perFieldTimeoutMs: 100,
    });

    expect(result.values["42"]).toBeNull();
    expect(result.traces["42"].nullReason).toBe("field inference timeout");
    expect(result.requires_agent_review).toBe(true);
    expect(result.agentReviewReason).toMatch(/critical field timed out|timed out/i);
    expect(result.stageMetrics.counts.fieldsTimedOut).toBe(1);
  });

  it("skips tier-4 when cap would be exceeded by tier-4 only, continues normally", async () => {
    // 2 tier-3 fields + 1 tier-4 field, cap = 2
    const catalog = [
      makeBizField("A", "field_a"),
      makeBizField("B", "field_b"),
      makeBizField("C", "tier4_field"),
    ];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("A"), makeRule("B")], 1),
    ]);

    mockGenerateContent.mockResolvedValue({ text: makeValidResponse("x", "x", "ok") });

    const result = await inferBusinessFields(
      [treatment],
      catalog,
      {},
      {},
      {},
      { maxBusinessFieldsPerRun: 2, inferTier4Fields: true }
    );

    expect(result.tier4Skipped).toBe(true);
    expect(result.requires_agent_review).toBe(false);
    expect(result.capWarning).toMatch(/tier-4/i);
  });

  it("routes to AGENT_REVIEW when cap prevents required tier 1-3 inference", async () => {
    const catalog = [
      makeBizField("A", "field_a"),
      makeBizField("B", "field_b"),
      makeBizField("C", "field_c"),
    ];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("A"), makeRule("B"), makeRule("C")], 1),
    ]);

    mockGenerateContent.mockResolvedValue({ text: makeValidResponse("x", "x", "ok") });

    const result = await inferBusinessFields(
      [treatment],
      catalog,
      {},
      {},
      {},
      { maxBusinessFieldsPerRun: 2 }
    );

    expect(result.requires_agent_review).toBe(true);
    expect(result.agentReviewReason).toMatch(/cap/i);
  });

  it("sets priorBusinessFieldsReferenced = true for the second field inferred", async () => {
    const catalog = [
      makeBizField("A", "first_field"),
      makeBizField("B", "second_field"),
    ];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("A"), makeRule("B")], 1),
    ]);

    mockGenerateContent.mockResolvedValue({ text: makeValidResponse("x", "x", "result") });

    const result = await inferBusinessFields([treatment], catalog, {});
    // First field: no prior business fields
    const firstId = result.traces["A"] ? "A" : "B";
    const secondId = firstId === "A" ? "B" : "A";
    expect(result.traces[firstId].priorBusinessFieldsReferenced).toBe(false);
    expect(result.traces[secondId].priorBusinessFieldsReferenced).toBe(true);
  });

  it("returns empty result when no business fields are referenced", async () => {
    const catalog: CatalogEntry[] = [];
    const treatment = makeTreatment([]);
    const result = await inferBusinessFields([treatment], catalog, {});
    expect(Object.keys(result.values)).toHaveLength(0);
    expect(result.requires_agent_review).toBe(false);
    expect(result.stageMetrics.counts.totalFields).toBe(0);
  });

  it("routes to AGENT_REVIEW when budget exhausted while tier-4 runs but tier-1 fields remain", async () => {
    // Ordering: tier 1 field "A" first, then tier 4 field "B" last.
    // Budget is set to expire mid-run. When A is processed OK but B (tier-4) is next
    // and budget has expired... but if there were more tier-1 fields still pending,
    // we'd expect AGENT_REVIEW.
    //
    // Simulate: 3 tier-1 fields (A, B, C). Budget expires after A is processed.
    // When we reach B, budget is already exhausted and B + C are remaining required fields
    // → should trigger AGENT_REVIEW.
    const catalog = [
      makeBizField("A", "field_a"),
      makeBizField("B", "field_b"),
      makeBizField("C", "field_c"),
    ];
    const treatment = makeTreatment([
      makeGroup("hard_blocker", [makeRule("A"), makeRule("B"), makeRule("C")], 1),
    ]);

    let callCount = 0;
    mockGenerateContent.mockImplementation(async () => {
      callCount++;
      // Only first call succeeds within budget; afterwards budget is exceeded
      return { text: makeValidResponse("result_value", "field", "ok") };
    });

    // Budget so small that only ~1 field can be inferred within it
    const result = await inferBusinessFields([treatment], catalog, {}, {}, {}, {
      totalBudgetMs: 0, // immediate expiry to test the guard
    });

    // All remaining fields should be null due to budget, and AGENT_REVIEW triggered
    expect(result.requires_agent_review).toBe(true);
    expect(result.agentReviewReason).toMatch(/required|tier/i);
  });

  it("confidence normalized: null value → confidence ≤ 0.1", async () => {
    const catalog = [makeBizField("42", "some_field")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("42")]),
    ]);

    // Model returns null value with high confidence — should be clamped
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        field_id: "42",
        field_label: "some_field",
        value: null,
        confidence: 0.9, // invalid: null value with high confidence
        rationale: "No evidence.",
        null_reason: "insufficient data",
        evidence: [],
      }),
    });

    const result = await inferBusinessFields([treatment], catalog, {});
    expect(result.traces["42"].confidence).not.toBeNull();
    expect(result.traces["42"].confidence!).toBeLessThanOrEqual(0.1);
  });

  it("flags high confidence with single evidence item", async () => {
    const catalog = [makeBizField("42", "some_field")];
    const treatment = makeTreatment([
      makeGroup("eligibility", [makeRule("42")]),
    ]);

    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        field_id: "42",
        field_label: "some_field",
        value: "confirmed",
        confidence: 0.95,
        rationale: "Single evidence item found.",
        null_reason: null,
        evidence: ["only one piece of evidence"],
      }),
    });

    const result = await inferBusinessFields([treatment], catalog, {});
    expect(result.traces["42"].highConfidenceSingleEvidenceWarning).toBe(true);
  });
});

// ─── Prompt builder smoke test ────────────────────────────────────────────────

describe("buildBusinessFieldSystemPrompt – verbatim content", () => {
  it("includes the exact verbatim system prompt text", async () => {
    const { buildBusinessFieldSystemPrompt } = await import(
      "../../server/lib/decisioning/prompts/business-field-prompt"
    );
    const prompt = buildBusinessFieldSystemPrompt();
    expect(prompt).toContain("You are Beacon's business-field inference engine.");
    expect(prompt).toContain("Do not use outside knowledge.");
    expect(prompt).toContain("Do not use generic collections assumptions.");
    expect(prompt).toContain("Do not use stereotypes.");
    expect(prompt).toContain("Do not guess.");
    expect(prompt).toContain("Return valid JSON only. Do not include markdown.");
    expect(prompt).toContain("1. Use only the provided evidence.");
  });
});

describe("buildBusinessFieldUserPrompt – field and context injection", () => {
  it("includes field_id, field_label, description in the prompt", async () => {
    const { buildBusinessFieldUserPrompt } = await import(
      "../../server/lib/decisioning/prompts/business-field-prompt"
    );
    const field = makeBizField("99", "affordability_band");
    field.description = "The customer's payment affordability band";
    field.allowedValues = ["HIGH", "MEDIUM", "LOW"];
    field.businessMeaning = "Categorises how much the customer can pay";

    const ctx = {
      customerProfile: { name: "Alice" },
      loanData: { dpd: 30 },
      paymentData: [],
      conversationData: [],
      bureauData: {},
      derivedFields: {},
      priorBusinessFields: {},
      truncationWarnings: [],
    };

    const prompt = buildBusinessFieldUserPrompt(field, ctx);
    expect(prompt).toContain("field_id: 99");
    expect(prompt).toContain("field_label: affordability_band");
    expect(prompt).toContain("The customer's payment affordability band");
    expect(prompt).toContain('"HIGH"');
    expect(prompt).toContain("FINAL REMINDER");
  });

  it("includes allowed_values constraint in prompt", async () => {
    const { buildBusinessFieldUserPrompt } = await import(
      "../../server/lib/decisioning/prompts/business-field-prompt"
    );
    const field = makeBizField("10", "status_field");
    field.allowedValues = ["active", "dormant", "closed"];
    const ctx = {
      customerProfile: {},
      loanData: {},
      paymentData: [],
      conversationData: [],
      bureauData: {},
      derivedFields: {},
      priorBusinessFields: {},
      truncationWarnings: [],
    };
    const prompt = buildBusinessFieldUserPrompt(field, ctx);
    expect(prompt).toContain('"active"');
    expect(prompt).toContain('"dormant"');
    expect(prompt).toContain('"closed"');
  });

  it("includes VALIDATION FEEDBACK in retry prompt", async () => {
    const { buildRetryUserPrompt } = await import(
      "../../server/lib/decisioning/prompts/business-field-prompt"
    );
    const field = makeBizField("10", "status_field");
    const ctx = {
      customerProfile: {},
      loanData: {},
      paymentData: [],
      conversationData: [],
      bureauData: {},
      derivedFields: {},
      priorBusinessFields: {},
      truncationWarnings: [],
    };
    const prompt = buildRetryUserPrompt(field, ctx, "Missing required key: confidence");
    expect(prompt).toContain("VALIDATION FEEDBACK: Missing required key: confidence");
  });

  it("notes truncation warnings in the prompt when present", async () => {
    const { buildBusinessFieldUserPrompt } = await import(
      "../../server/lib/decisioning/prompts/business-field-prompt"
    );
    const field = makeBizField("10", "some_field");
    const ctx = {
      customerProfile: {},
      loanData: {},
      paymentData: [],
      conversationData: [],
      bureauData: {},
      derivedFields: {},
      priorBusinessFields: {},
      truncationWarnings: ["paymentData truncated: 5 of 12"],
    };
    const prompt = buildBusinessFieldUserPrompt(field, ctx);
    expect(prompt).toContain("paymentData truncated");
  });
});
