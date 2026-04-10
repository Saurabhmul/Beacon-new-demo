import { describe, it, expect } from "vitest";
import { checkPolicyCompleteness, PolicyCompletenessError } from "../../server/lib/decisioning/policy-completeness";
import type { TreatmentWithRules } from "@shared/schema";
import type { CatalogEntry } from "../../server/field-catalog";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(label: string, id?: string): CatalogEntry {
  return { id: id ?? `source:${label}`, label, sourceType: "source_field" };
}

function makeTreatment(overrides: Partial<TreatmentWithRules> = {}): TreatmentWithRules {
  return {
    id: 1,
    name: "TEST_TREATMENT",
    description: null,
    enabled: true,
    priority: null,
    companyId: "co1",
    policyPackId: 1,
    ruleGroups: [],
    ...overrides,
  } as TreatmentWithRules;
}

function makeRuleGroup(rules: any[], ruleType = "eligibility"): any {
  return {
    id: 1,
    ruleType,
    logicOperator: "AND",
    treatmentId: 1,
    rules,
  };
}

function makeRule(overrides: any = {}): any {
  return {
    id: 1,
    leftFieldId: null,
    operator: "=",
    rightMode: "value",
    rightFieldId: null,
    rightValue: "test",
    groupId: 1,
    ...overrides,
  };
}

const catalog: CatalogEntry[] = [
  makeEntry("DPD", "source:DPD"),
  makeEntry("amount_due", "source:amount_due"),
  makeEntry("customer_name", "source:customer_name"),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("checkPolicyCompleteness", () => {
  describe("no enabled treatments", () => {
    it("fails when no treatments at all", () => {
      const result = checkPolicyCompleteness([], catalog);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain("Policy has no enabled treatments");
    });

    it("fails when all treatments are disabled", () => {
      const t = makeTreatment({ enabled: false });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain("Policy has no enabled treatments");
    });
  });

  describe("single enabled treatment — happy path", () => {
    it("passes when treatment has valid rules referencing known fields", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([
            makeRule({ leftFieldId: "source:DPD", operator: ">", rightMode: "value", rightValue: "30" }),
          ]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("passes when treatment has no rule groups", () => {
      const t = makeTreatment({ ruleGroups: [] });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(true);
    });
  });

  describe("empty rule groups", () => {
    it("flags empty rule groups", () => {
      const t = makeTreatment({
        ruleGroups: [makeRuleGroup([])],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes("no rules"))).toBe(true);
    });
  });

  describe("field resolution", () => {
    it("passes with exact source: ID match", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([makeRule({ leftFieldId: "source:DPD" })]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(true);
    });

    it("passes with bare label match (case-insensitive)", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([makeRule({ leftFieldId: "amount_due" })]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(true);
    });

    it("flags leftFieldId not in catalog", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([makeRule({ leftFieldId: "unknown_field_xyz" })]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes("unknown_field_xyz"))).toBe(true);
    });

    it("flags rightFieldId not in catalog when rightMode = field", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([
            makeRule({ leftFieldId: "source:DPD", rightMode: "field", rightFieldId: "ghost_field" }),
          ]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes("ghost_field"))).toBe(true);
    });

    it("does NOT flag rightFieldId when rightMode is value", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([
            makeRule({ leftFieldId: "source:DPD", rightMode: "value", rightFieldId: null }),
          ]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(true);
    });
  });

  describe("unsupported operators", () => {
    it("flags unsupported operator", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([makeRule({ operator: "BETWEEN" })]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(false);
      expect(result.issues.some(i => i.includes("BETWEEN"))).toBe(true);
    });

    it("accepts supported operator >=", () => {
      const t = makeTreatment({
        ruleGroups: [
          makeRuleGroup([makeRule({ leftFieldId: "source:DPD", operator: ">=" })]),
        ],
      });
      const result = checkPolicyCompleteness([t], catalog);
      expect(result.passed).toBe(true);
    });
  });

  describe("disabled treatments are excluded", () => {
    it("only checks enabled treatments", () => {
      const disabled = makeTreatment({
        enabled: false,
        ruleGroups: [
          makeRuleGroup([makeRule({ leftFieldId: "unknown_xyz" })]),
        ],
      });
      const enabled = makeTreatment({ enabled: true, ruleGroups: [] });
      const result = checkPolicyCompleteness([disabled, enabled], catalog);
      // disabled treatment issues not reported; enabled has no rules → passes
      expect(result.passed).toBe(true);
    });
  });

  describe("PolicyCompletenessError", () => {
    it("is constructable with issues array", () => {
      const err = new PolicyCompletenessError(["issue one", "issue two"]);
      expect(err).toBeInstanceOf(Error);
      expect(err.issues).toHaveLength(2);
      expect(err.message).toContain("issue one");
    });
  });
});
