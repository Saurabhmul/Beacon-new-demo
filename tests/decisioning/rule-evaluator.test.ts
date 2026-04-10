import { describe, it, expect } from "vitest";
import { evaluateTreatmentRules } from "../../server/lib/decisioning/rule-evaluator";
import type { TreatmentWithRules } from "@shared/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let ruleIdSeq = 1;
let groupIdSeq = 1;

function makeRule(
  opts: Partial<{
    id: number;
    ruleGroupId: number;
    fieldName: string;
    operator: string;
    value: string | null;
    leftFieldId: string | null;
    rightMode: string | null;
    rightConstantValue: string | null;
    rightFieldId: string | null;
    sortOrder: number;
  }>
) {
  return {
    id: opts.id ?? ruleIdSeq++,
    ruleGroupId: opts.ruleGroupId ?? 1,
    fieldName: opts.fieldName ?? "unknown_field",
    operator: opts.operator ?? "=",
    value: opts.value ?? null,
    leftFieldId: opts.leftFieldId ?? null,
    rightMode: opts.rightMode ?? "constant",
    rightConstantValue: opts.rightConstantValue ?? null,
    rightFieldId: opts.rightFieldId ?? null,
    sortOrder: opts.sortOrder ?? 0,
  };
}

function makeGroup(
  ruleType: string,
  rules: ReturnType<typeof makeRule>[],
  logicOperator = "AND",
  treatmentId = 1
) {
  return {
    id: groupIdSeq++,
    treatmentId,
    ruleType,
    logicOperator,
    plainEnglishInput: null,
    groupOrder: 0,
    rules,
  };
}

function makeTreatment(
  name: string,
  ruleGroups: ReturnType<typeof makeGroup>[],
  priority: string | null = null,
  enabled = true
): TreatmentWithRules {
  return {
    id: ruleIdSeq++,
    policyPackId: 1,
    name,
    shortDescription: null,
    enabled,
    priority,
    tone: null,
    displayOrder: 0,
    draftSourceFields: null,
    draftDerivedFields: null,
    draftBusinessFields: null,
    aiConfidence: null,
    ruleGroups: ruleGroups as any,
  };
}

// ─── Basic eligibility ────────────────────────────────────────────────────────

describe("eligibility evaluation", () => {
  it("includes treatment when all eligibility rules pass", () => {
    const t = makeTreatment("payment_plan", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: ">=", value: "30" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { dpd: 45 });
    expect(result.eligibleTreatments.map(e => e.code)).toContain("payment_plan");
  });

  it("excludes treatment when eligibility rule fails", () => {
    const t = makeTreatment("payment_plan", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: ">=", value: "90" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { dpd: 30 });
    expect(result.eligibleTreatments.map(e => e.code)).not.toContain("payment_plan");
    expect(result.blockedTreatments.map(b => b.code)).not.toContain("payment_plan");
  });

  it("includes treatment with no rule groups (no eligibility filter)", () => {
    const t = makeTreatment("open_treatment", [], "2");
    const result = evaluateTreatmentRules([t], {});
    expect(result.eligibleTreatments.map(e => e.code)).toContain("open_treatment");
  });

  it("skips disabled treatments", () => {
    const t = makeTreatment("disabled_treatment", [], "1", false);
    const result = evaluateTreatmentRules([t], {});
    expect(result.eligibleTreatments.length).toBe(0);
  });
});

// ─── Hard vs soft blocker classification ──────────────────────────────────────

describe("hard vs soft blocker classification", () => {
  it("marks treatment as hard-blocked when hard_blocker group passes", () => {
    const t = makeTreatment("reduced_plan", [
      makeGroup("hard_blocker", [
        makeRule({ fieldName: "breathing_space_active", operator: "is_true" }),
      ]),
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: ">", value: "0" }),
      ]),
    ], "1");
    const resolved = { breathing_space_active: "yes", dpd: 30 };
    const result = evaluateTreatmentRules([t], resolved);
    const blocked = result.blockedTreatments.find(b => b.code === "reduced_plan");
    expect(blocked).toBeDefined();
    expect(blocked!.blockerType).toBe("hard");
  });

  it("marks treatment as soft-blocked when soft_blocker group passes", () => {
    const t = makeTreatment("reduced_plan", [
      makeGroup("soft_blocker", [
        makeRule({ fieldName: "in_litigation", operator: "is_true" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { in_litigation: true });
    const blocked = result.blockedTreatments.find(b => b.code === "reduced_plan");
    expect(blocked).toBeDefined();
    expect(blocked!.blockerType).toBe("soft");
  });

  it("does not add to blockedTreatments when hard_blocker group does not pass", () => {
    const t = makeTreatment("reduced_plan", [
      makeGroup("hard_blocker", [
        makeRule({ fieldName: "breathing_space_active", operator: "is_true" }),
      ]),
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: ">", value: "0" }),
      ]),
    ], "1");
    const resolved = { breathing_space_active: "no", dpd: 45 };
    const result = evaluateTreatmentRules([t], resolved);
    expect(result.blockedTreatments.find(b => b.code === "reduced_plan")).toBeUndefined();
    expect(result.eligibleTreatments.map(e => e.code)).toContain("reduced_plan");
  });
});

// ─── Review triggers (separate from blockers) ────────────────────────────────

describe("review triggers are NOT blockers", () => {
  it("adds review trigger but treatment remains eligible", () => {
    const t = makeTreatment("payment_plan", [
      makeGroup("review_trigger", [
        makeRule({ fieldName: "ie_assessment_complete", operator: "is_false" }),
      ]),
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: ">", value: "0" }),
      ]),
    ], "1");
    const resolved = { ie_assessment_complete: "false", dpd: 30 };
    const result = evaluateTreatmentRules([t], resolved);
    expect(result.reviewTriggers.length).toBeGreaterThan(0);
    expect(result.eligibleTreatments.map(e => e.code)).toContain("payment_plan");
    expect(result.blockedTreatments.map(b => b.code)).not.toContain("payment_plan");
  });

  it("review trigger NOT fired when condition does not pass", () => {
    const t = makeTreatment("payment_plan", [
      makeGroup("review_trigger", [
        makeRule({ fieldName: "ie_assessment_complete", operator: "is_false" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { ie_assessment_complete: "true" });
    expect(result.reviewTriggers.length).toBe(0);
  });
});

// ─── Treatment ranking ────────────────────────────────────────────────────────

describe("treatment ranking", () => {
  it("single eligible treatment → rank 1, isPreferred true", () => {
    const t = makeTreatment("best_plan", [], "2");
    const result = evaluateTreatmentRules([t], {});
    expect(result.rankedEligibleTreatments[0].rank).toBe(1);
    expect(result.rankedEligibleTreatments[0].isPreferred).toBe(true);
    expect(result.preferredTreatments.length).toBe(1);
  });

  it("two treatments with different priorities → lower priority number ranked first", () => {
    const t1 = makeTreatment("plan_a", [], "1");
    const t2 = makeTreatment("plan_b", [], "3");
    const result = evaluateTreatmentRules([t1, t2], {});
    const ranked = result.rankedEligibleTreatments;
    expect(ranked[0].code).toBe("plan_a");
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].code).toBe("plan_b");
    expect(ranked[1].rank).toBe(2);
  });

  it("tie at top priority → both at rank 1, both preferred", () => {
    const t1 = makeTreatment("plan_a", [], "1");
    const t2 = makeTreatment("plan_b", [], "1");
    const result = evaluateTreatmentRules([t1, t2], {});
    expect(result.rankedEligibleTreatments[0].rank).toBe(1);
    expect(result.rankedEligibleTreatments[1].rank).toBe(1);
    expect(result.preferredTreatments.length).toBe(2);
    expect(result.preferredTreatments.map(p => p.code)).toContain("plan_a");
    expect(result.preferredTreatments.map(p => p.code)).toContain("plan_b");
  });

  it("missing priority → ranked last, prioritySource = 'missing', warns in trace", () => {
    const t1 = makeTreatment("plan_a", [], "1");
    const t2 = makeTreatment("plan_no_priority", [], null);
    const result = evaluateTreatmentRules([t1, t2], {});
    const noPriorityEntry = result.rankedEligibleTreatments.find(r => r.code === "plan_no_priority");
    const priorityEntry = result.rankedEligibleTreatments.find(r => r.code === "plan_a");
    expect(noPriorityEntry!.prioritySource).toBe("missing");
    expect(noPriorityEntry!.priority).toBeNull();
    expect(priorityEntry!.rank).toBeLessThan(noPriorityEntry!.rank);
    expect(result.stageMetrics.counts["warnedMissingPriority"]).toBe(1);
  });

  it("all treatments missing priority → all share rank 1 (all preferred), all 'missing'", () => {
    const t1 = makeTreatment("plan_a", [], null);
    const t2 = makeTreatment("plan_b", [], null);
    const result = evaluateTreatmentRules([t1, t2], {});
    for (const t of result.rankedEligibleTreatments) {
      expect(t.prioritySource).toBe("missing");
      expect(t.rank).toBe(1);
      expect(t.isPreferred).toBe(true);
    }
    expect(result.preferredTreatments.length).toBe(2);
  });

  it("empty preferredTreatments when no eligible treatments", () => {
    const t = makeTreatment("blocked_plan", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: ">", value: "999" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { dpd: 30 });
    expect(result.eligibleTreatments.length).toBe(0);
    expect(result.preferredTreatments.length).toBe(0);
    expect(result.rankedEligibleTreatments.length).toBe(0);
  });
});

// ─── treatmentSelectionTrace ─────────────────────────────────────────────────

describe("treatmentSelectionTrace (rule-evaluator fields)", () => {
  it("populates priority, prioritySource, rank, isPreferred for each eligible treatment", () => {
    const t = makeTreatment("plan_a", [], "2");
    const result = evaluateTreatmentRules([t], {});
    const entry = result.treatmentSelectionTrace[0];
    expect(entry.treatmentCode).toBe("plan_a");
    expect(entry.priority).toBe(2);
    expect(entry.prioritySource).toBe("configured");
    expect(entry.rank).toBe(1);
    expect(entry.isPreferred).toBe(true);
  });

  it("selectionMode and selectionReason are undefined (set by validator later)", () => {
    const t = makeTreatment("plan_a", [], "1");
    const result = evaluateTreatmentRules([t], {});
    expect(result.treatmentSelectionTrace[0].selectionMode).toBeUndefined();
    expect(result.treatmentSelectionTrace[0].selectionReason).toBeUndefined();
  });

  it("does not include blocked or ineligible treatments in treatmentSelectionTrace", () => {
    const t1 = makeTreatment("eligible_plan", [], "1");
    const t2 = makeTreatment("blocked_plan", [
      makeGroup("hard_blocker", [
        makeRule({ fieldName: "flag", operator: "is_true" }),
      ]),
    ], "2");
    const result = evaluateTreatmentRules([t1, t2], { flag: true });
    const codes = result.treatmentSelectionTrace.map(e => e.treatmentCode);
    expect(codes).toContain("eligible_plan");
    expect(codes).not.toContain("blocked_plan");
  });
});

// ─── Critical missing information ────────────────────────────────────────────

describe("critical missing information", () => {
  it("flags fields missing in hard_blocker rules as critical", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("hard_blocker", [
        makeRule({ fieldName: "breathing_space_active", operator: "is_true" }),
      ]),
    ], "1");
    // Field not in resolved values
    const result = evaluateTreatmentRules([t], {});
    const missing = result.missingCriticalInformation;
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0].fieldId).toBe("breathing_space_active");
    expect(missing[0].requiredBy).toMatch(/hard_blocker/i);
  });

  it("flags fields missing in eligibility rules as critical", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "required_eligibility_field", operator: "=", value: "yes" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], {});
    const missing = result.missingCriticalInformation;
    expect(missing.some(m => m.fieldId === "required_eligibility_field")).toBe(true);
  });

  it("does NOT flag fields missing only in guardrail rules as critical", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("guardrail", [
        makeRule({ fieldName: "non_critical_guardrail_field", operator: "is_true" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], {});
    expect(result.missingCriticalInformation.length).toBe(0);
  });
});

// ─── Rule integrity – broken field IDs and invalid operators ─────────────────

describe("rule integrity – graceful handling", () => {
  it("handles broken leftFieldId gracefully (not_evaluable)", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ leftFieldId: "source:nonexistent_field", operator: "=", rightConstantValue: "yes" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], {});
    const trace = result.treatmentRuleTrace.find(r => r.treatmentCode === "plan_a");
    const ruleRow = trace?.evaluatedRules[0];
    expect(ruleRow?.result).toBe("not_evaluable");
  });

  it("handles invalid operator gracefully (not_evaluable)", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "dpd", operator: "INVALID_OP", value: "30" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { dpd: 30 });
    const trace = result.treatmentRuleTrace.find(r => r.treatmentCode === "plan_a");
    const ruleRow = trace?.evaluatedRules[0];
    expect(ruleRow?.result).toBe("not_evaluable");
    expect(ruleRow?.reason).toMatch(/unknown operator/i);
  });

  it("handles empty rule groups gracefully (no crash)", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", []), // empty rules
    ], "1");
    // Should not throw; treatment with empty group is simply not blocked
    expect(() => evaluateTreatmentRules([t], {})).not.toThrow();
  });

  it("handles treatment with null ruleGroups gracefully", () => {
    const t: TreatmentWithRules = {
      ...makeTreatment("plan_no_groups", [], "1"),
      ruleGroups: null as any,
    };
    expect(() => evaluateTreatmentRules([t], {})).not.toThrow();
    const result = evaluateTreatmentRules([t], {});
    expect(result.eligibleTreatments.map(e => e.code)).toContain("plan_no_groups");
  });
});

// ─── Operators ────────────────────────────────────────────────────────────────

describe("rule operators", () => {
  it("= operator matches string equality", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [makeRule({ fieldName: "status", operator: "=", value: "active" })]),
    ], "1");
    expect(evaluateTreatmentRules([t], { status: "active" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { status: "inactive" }).eligibleTreatments.length).toBe(0);
  });

  it("!= operator", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [makeRule({ fieldName: "status", operator: "!=", value: "closed" })]),
    ], "1");
    expect(evaluateTreatmentRules([t], { status: "active" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { status: "closed" }).eligibleTreatments.length).toBe(0);
  });

  it("> operator", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [makeRule({ fieldName: "dpd", operator: ">", value: "30" })]),
    ], "1");
    expect(evaluateTreatmentRules([t], { dpd: 31 }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { dpd: 30 }).eligibleTreatments.length).toBe(0);
  });

  it("in operator matches value in list", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "tier", operator: "in", value: '["gold","platinum"]' }),
      ]),
    ], "1");
    expect(evaluateTreatmentRules([t], { tier: "gold" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { tier: "bronze" }).eligibleTreatments.length).toBe(0);
  });

  it("not_in operator", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ fieldName: "tier", operator: "not_in", value: '["excluded","blocked"]' }),
      ]),
    ], "1");
    expect(evaluateTreatmentRules([t], { tier: "gold" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { tier: "excluded" }).eligibleTreatments.length).toBe(0);
  });

  it("contains operator", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [makeRule({ fieldName: "notes", operator: "contains", value: "hardship" })]),
    ], "1");
    expect(evaluateTreatmentRules([t], { notes: "customer reported hardship recently" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { notes: "no issues" }).eligibleTreatments.length).toBe(0);
  });

  it("is_true operator", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [makeRule({ fieldName: "is_active", operator: "is_true" })]),
    ], "1");
    expect(evaluateTreatmentRules([t], { is_active: "yes" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { is_active: "no" }).eligibleTreatments.length).toBe(0);
  });

  it("is_false operator", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [makeRule({ fieldName: "is_closed", operator: "is_false" })]),
    ], "1");
    expect(evaluateTreatmentRules([t], { is_closed: "false" }).eligibleTreatments.length).toBe(1);
    expect(evaluateTreatmentRules([t], { is_closed: "true" }).eligibleTreatments.length).toBe(0);
  });
});

// ─── leftFieldId with source: prefix ─────────────────────────────────────────

describe("leftFieldId resolution", () => {
  it("resolves leftFieldId starting with source: prefix", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ leftFieldId: "source:dpd", operator: ">", rightConstantValue: "0" }),
      ]),
    ], "1");
    const result = evaluateTreatmentRules([t], { "source:dpd": 30 });
    expect(result.eligibleTreatments.map(e => e.code)).toContain("plan_a");
  });

  it("falls back to short key after source: prefix when canonical not found", () => {
    const t = makeTreatment("plan_a", [
      makeGroup("eligibility", [
        makeRule({ leftFieldId: "source:dpd", operator: ">", rightConstantValue: "0" }),
      ]),
    ], "1");
    // Values stored under short key (without source: prefix)
    const result = evaluateTreatmentRules([t], { dpd: 30 });
    expect(result.eligibleTreatments.map(e => e.code)).toContain("plan_a");
  });
});

// ─── Stage metrics ────────────────────────────────────────────────────────────

describe("stage metrics", () => {
  it("returns timing and count metrics", () => {
    const t1 = makeTreatment("plan_a", [], "1");
    const t2 = makeTreatment("plan_b", [
      makeGroup("hard_blocker", [makeRule({ fieldName: "flag", operator: "is_true" })]),
    ], "2");
    const result = evaluateTreatmentRules([t1, t2], { flag: true });
    expect(result.stageMetrics.counts["eligible"]).toBe(1);
    expect(result.stageMetrics.counts["blocked"]).toBe(1);
    expect(typeof result.stageMetrics.durationMs).toBe("number");
    expect(result.stageMetrics.startedAt).toBeTruthy();
  });
});
