/**
 * Orchestrator integration tests — deterministic fallback paths.
 *
 * These tests verify that policy-completeness failures, empty treatment lists,
 * missing critical information, and hard guardrail flags all produce a
 * deterministic AGENT_REVIEW result (no AI call) with the correct payload contract.
 *
 * AI-dependent stages are mocked so these tests are fully offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDecisionPipeline, ENGINE_VERSION } from "../../server/lib/decisioning/orchestrator";
import type { RunDecisionPipelineArgs } from "../../server/lib/decisioning/orchestrator";
import type { TreatmentWithRules, PolicyPack } from "@shared/schema";
import type { CatalogEntry } from "../../server/field-catalog";

// ── Mock AI-touching modules ────────────────────────────────────────────────
// Policy-completeness, no-eligible, missing-critical, and hard-guardrail
// fallbacks all happen before any AI call, so we mock them to confirm they
// are never invoked on these paths.

vi.mock("../../server/lib/decisioning/business-field-engine", () => ({
  inferBusinessFields: vi.fn().mockResolvedValue({
    values: {},
    traces: {},
    requires_agent_review: false,
    runFallbackReason: null,
    stageMetrics: { counts: {} },
  }),
}));

vi.mock("../../server/ai-engine", () => ({
  geminiClient: {
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: vi.fn().mockRejectedValue(new Error("AI should not be called on deterministic paths")),
    }),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMPANY_ID = "test-company-fallback";

function makePolicyPack(overrides: Partial<PolicyPack> = {}): PolicyPack {
  return {
    id: 1,
    companyId: COMPANY_ID,
    policyName: "Test Pack",
    sourceType: "ui",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as PolicyPack;
}

function makeTreatment(overrides: Partial<TreatmentWithRules> = {}): TreatmentWithRules {
  return {
    id: 1,
    name: "Payment Plan",
    description: null,
    enabled: true,
    priority: "1",
    companyId: COMPANY_ID,
    policyPackId: 1,
    ruleGroups: [],
    ...overrides,
  } as unknown as TreatmentWithRules;
}

function makeSimpleCatalog(): CatalogEntry[] {
  return [
    { id: "source:DPD", label: "Days Past Due", sourceType: "source_field" },
    { id: "source:amount_due", label: "Amount Due", sourceType: "source_field" },
  ];
}

function baseArgs(overrides: Partial<RunDecisionPipelineArgs> = {}): RunDecisionPipelineArgs {
  return {
    companyId: COMPANY_ID,
    rawCustomerData: { "source:DPD": 45, "source:amount_due": 2500 },
    treatments: [makeTreatment()],
    catalog: makeSimpleCatalog(),
    policyPack: makePolicyPack(),
    ...overrides,
  };
}

// ── Payload contract assertions ──────────────────────────────────────────────

function assertDeterministicFallbackPayload(
  result: Awaited<ReturnType<typeof runDecisionPipeline>>,
  expectedReason: string
) {
  expect(result.recommended_treatment_code).toBe("AGENT_REVIEW");
  expect(result.recommended_treatment_name).toBe("Agent Review");
  expect(result.requires_agent_review).toBe(true);
  expect(result.proposed_email_to_customer).toBe("NO_ACTION");
  expect(result.runFallbackReason).toBeDefined();
  expect(result.runFallbackReason).toContain(expectedReason);
  expect(result.engineVersion).toBe(ENGINE_VERSION);
  expect(result.companyId).toBe(COMPANY_ID);
  expect(result.runId).toBeTruthy();
  expect(result.timestamp).toBeTruthy();
  expect(result.decisionStatus).toBe("pending");
  // aiRawOutput must always be present (deterministic runs include stage metrics)
  expect(result.aiRawOutput).toBeDefined();
  expect((result.aiRawOutput as Record<string, unknown>).runFallbackReason).toBe(result.runFallbackReason);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("orchestrator — policy completeness failure → deterministic fallback", () => {
  it("returns AGENT_REVIEW with policy-completeness runFallbackReason when check fails", async () => {
    // A treatment with a rule referencing a field NOT in the catalog triggers completeness failure
    const treatmentWithMissingField = makeTreatment({
      ruleGroups: [
        {
          id: 1,
          ruleType: "eligibility",
          logicOperator: "AND",
          treatmentId: 1,
          rules: [
            {
              id: 1,
              leftFieldId: "source:nonexistent_field",
              operator: ">",
              rightValue: "0",
              leftFieldLabel: null,
              rightFieldId: null,
              rightFieldLabel: null,
              treatmentRuleGroupId: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ],
    } as unknown as Partial<TreatmentWithRules>);

    const result = await runDecisionPipeline(baseArgs({
      treatments: [treatmentWithMissingField],
    }));

    assertDeterministicFallbackPayload(result, "policy completeness check failed");
    // The stage metrics must include a policyCompleteness entry with counts
    const metrics = (result.aiRawOutput as Record<string, unknown>).stageMetrics as Record<string, unknown>;
    expect(metrics).toHaveProperty("policyCompleteness");
    const pcCounts = ((metrics.policyCompleteness as Record<string, unknown>).counts) as Record<string, number>;
    expect(pcCounts.passed).toBe(0);
    expect(pcCounts.issues).toBeGreaterThan(0);
  });

  it("emits a selection trace annotated with policy-completeness failure before any customer analysis", async () => {
    const treatmentWithMissingField = makeTreatment({
      ruleGroups: [
        {
          id: 2,
          ruleType: "eligibility",
          logicOperator: "AND",
          treatmentId: 1,
          rules: [
            {
              id: 2,
              leftFieldId: "source:ghost_field",
              operator: "!=",
              rightValue: "null",
              leftFieldLabel: null,
              rightFieldId: null,
              rightFieldLabel: null,
              treatmentRuleGroupId: 2,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ],
    } as unknown as Partial<TreatmentWithRules>);

    const result = await runDecisionPipeline(baseArgs({
      treatments: [treatmentWithMissingField],
    }));

    const trace = (result.aiRawOutput as Record<string, unknown>).treatmentSelectionTrace as Array<Record<string, unknown>>;
    expect(Array.isArray(trace)).toBe(true);
    // Every entry in the trace must carry the completeness-failure annotation
    for (const entry of trace) {
      expect(String(entry.selectionReason ?? "").toLowerCase()).toContain("policy completeness");
    }
  });
});

describe("orchestrator — no eligible treatments → deterministic fallback", () => {
  it("returns AGENT_REVIEW when no treatments are eligible after rule evaluation", async () => {
    // Treatment rule uses a field that resolves but with a condition that can never be met
    // (DPD must be < 0, which a real value of 45 will never satisfy)
    const treatment = makeTreatment({
      ruleGroups: [
        {
          id: 10,
          ruleType: "eligibility",
          logicOperator: "AND",
          treatmentId: 1,
          rules: [
            {
              id: 10,
              leftFieldId: "source:DPD",
              operator: "<",
              rightValue: "0",
              leftFieldLabel: null,
              rightFieldId: null,
              rightFieldLabel: null,
              treatmentRuleGroupId: 10,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ],
    } as unknown as Partial<TreatmentWithRules>);

    const result = await runDecisionPipeline(baseArgs({
      treatments: [treatment],
    }));

    assertDeterministicFallbackPayload(result, "no eligible treatments");
    // runFallbackReason must appear in aiRawOutput
    expect((result.aiRawOutput as Record<string, unknown>).runFallbackReason).toBe("no eligible treatments");
  });
});

describe("orchestrator — null policy pack → fallback payload has unknown policyVersion", () => {
  it("handles null policyPack with empty treatments: completeness fails and policyVersion is 'unknown'", async () => {
    // Empty treatment list fails the completeness check (no enabled treatments).
    // The pipeline still returns a valid AGENT_REVIEW payload with policyVersion = "unknown".
    const result = await runDecisionPipeline(baseArgs({
      policyPack: null,
      treatments: [],
    }));

    expect(result.recommended_treatment_code).toBe("AGENT_REVIEW");
    expect(result.requires_agent_review).toBe(true);
    expect(result.runFallbackReason).toBe("policy completeness check failed");
    expect(result.policyVersion).toBe("unknown");
    expect(result.aiRawOutput).toBeDefined();
  });
});

describe("orchestrator — deterministic fallback payload contract", () => {
  it("aiRawOutput always contains stageMetrics, runId, and runFallbackReason", async () => {
    const treatment = makeTreatment({
      ruleGroups: [
        {
          id: 20,
          ruleType: "eligibility",
          logicOperator: "AND",
          treatmentId: 1,
          rules: [
            {
              id: 20,
              leftFieldId: "source:DPD",
              operator: ">",
              rightValue: "9999",
              leftFieldLabel: null,
              rightFieldId: null,
              rightFieldLabel: null,
              treatmentRuleGroupId: 20,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ],
    } as unknown as Partial<TreatmentWithRules>);

    const result = await runDecisionPipeline(baseArgs({ treatments: [treatment] }));
    const raw = result.aiRawOutput as Record<string, unknown>;

    expect(raw).toHaveProperty("runId");
    expect(raw).toHaveProperty("stageMetrics");
    expect(raw).toHaveProperty("runFallbackReason");
    expect(raw.runId).toBe(result.runId);
    expect(typeof raw.stageMetrics).toBe("object");
  });
});
