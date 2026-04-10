import { describe, it, expect } from "vitest";
import { evaluateDerivedFields, toNumber, toBoolean } from "../../server/lib/decisioning/derived-field-engine";
import type { CatalogEntry } from "../../server/field-catalog";
import type { ArithmeticDerivationConfig, LogicalDerivationConfig } from "@shared/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSourceEntry(label: string): CatalogEntry {
  return { id: `source:${label}`, label, sourceType: "source_field" };
}

function makeArithmeticEntry(
  label: string,
  config: ArithmeticDerivationConfig,
  summary?: string
): CatalogEntry {
  return {
    id: `derived:${label}`,
    label,
    sourceType: "derived_field",
    derivationConfig: config,
    derivationSummary: summary,
  };
}

function makeLogicalEntry(
  label: string,
  config: LogicalDerivationConfig,
  summary?: string
): CatalogEntry {
  return {
    id: `derived:${label}`,
    label,
    sourceType: "derived_field",
    derivationConfig: config,
    derivationSummary: summary,
  };
}

function makeSkippedEntry(label: string): CatalogEntry {
  return { id: `derived:${label}`, label, sourceType: "derived_field", derivationConfig: null };
}

// ─── Coercion helper tests ────────────────────────────────────────────────────

describe("toNumber coercion", () => {
  it("converts numeric strings", () => expect(toNumber("42")).toBe(42));
  it("converts boolean true to 1", () => expect(toNumber(true)).toBe(1));
  it("converts boolean false to 0", () => expect(toNumber(false)).toBe(0));
  it("converts 'Yes' to 1", () => expect(toNumber("Yes")).toBe(1));
  it("converts 'No' to 0", () => expect(toNumber("No")).toBe(0));
  it("returns null for non-numeric string", () => expect(toNumber("banana")).toBeNull());
  it("returns null for null", () => expect(toNumber(null)).toBeNull());
  it("returns null for undefined", () => expect(toNumber(undefined)).toBeNull());
  it("returns null for Infinity", () => expect(toNumber(Infinity)).toBeNull());
});

describe("toBoolean coercion", () => {
  it("converts 'true' string", () => expect(toBoolean("true")).toBe(true));
  it("converts 'false' string", () => expect(toBoolean("false")).toBe(false));
  it("converts 'yes' string", () => expect(toBoolean("yes")).toBe(true));
  it("converts 'no' string", () => expect(toBoolean("no")).toBe(false));
  it("converts 1 to true", () => expect(toBoolean(1)).toBe(true));
  it("converts 0 to false", () => expect(toBoolean(0)).toBe(false));
  it("returns null for arbitrary number", () => expect(toBoolean(5)).toBeNull());
  it("returns null for null", () => expect(toBoolean(null)).toBeNull());
});

// ─── Arithmetic derivation ────────────────────────────────────────────────────

describe("arithmetic derivation", () => {
  it("computes field + constant", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("surplus", {
        fieldA: "source:income",
        fieldALabel: "income",
        operator1: "-",
        operandBType: "constant",
        operandBValue: "500",
      }),
    ];
    const resolved = { "source:income": 1200 };
    const result = evaluateDerivedFields(catalog, resolved);
    expect(result.values["surplus"]).toBe(700);
    expect(result.traces["surplus"].status).toBe("computed");
    expect(result.stageMetrics.counts["computed"]).toBe(1);
  });

  it("computes field * field", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("total", {
        fieldA: "source:price",
        fieldALabel: "price",
        operator1: "*",
        operandBType: "field",
        operandBValue: "source:quantity",
      }),
    ];
    const resolved = { "source:price": 10, "source:quantity": 3 };
    const result = evaluateDerivedFields(catalog, resolved);
    expect(result.values["total"]).toBe(30);
  });

  it("handles three-operand formula", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("weighted", {
        fieldA: "source:a",
        fieldALabel: "a",
        operator1: "+",
        operandBType: "field",
        operandBValue: "source:b",
        operator2: "*",
        operandCType: "constant",
        operandCValue: "2",
      }),
    ];
    const resolved = { "source:a": 3, "source:b": 4 };
    // (3 + 4) * 2 = 14
    const result = evaluateDerivedFields(catalog, resolved);
    expect(result.values["weighted"]).toBe(14);
  });

  it("returns null status when input field is missing", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("surplus", {
        fieldA: "source:income",
        fieldALabel: "income",
        operator1: "-",
        operandBType: "constant",
        operandBValue: "500",
      }),
    ];
    const result = evaluateDerivedFields(catalog, {});
    expect(result.traces["surplus"].status).toBe("null");
    expect(result.traces["surplus"].nullReason).toMatch(/not found/);
    expect(result.stageMetrics.counts["null"]).toBe(1);
  });

  it("returns null status for division by zero", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("ratio", {
        fieldA: "source:numerator",
        fieldALabel: "numerator",
        operator1: "/",
        operandBType: "constant",
        operandBValue: "0",
      }),
    ];
    const result = evaluateDerivedFields(catalog, { "source:numerator": 10 });
    expect(result.traces["ratio"].status).toBe("null");
    expect(result.traces["ratio"].nullReason).toMatch(/division by zero/i);
  });

  it("returns null when value cannot be coerced to number", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("surplus", {
        fieldA: "source:income",
        fieldALabel: "income",
        operator1: "+",
        operandBType: "constant",
        operandBValue: "100",
      }),
    ];
    const result = evaluateDerivedFields(catalog, { "source:income": "not-a-number" });
    expect(result.traces["surplus"].status).toBe("null");
  });
});

// ─── Logical derivation ───────────────────────────────────────────────────────

describe("logical derivation", () => {
  it("AND condition: all true → true", () => {
    const catalog: CatalogEntry[] = [
      makeLogicalEntry("is_high_risk", {
        type: "logical",
        operator: "AND",
        conditions: [
          { field: "source:dpd", operator: ">", value: 90 },
          { field: "source:balance", operator: ">", value: 5000 },
        ],
      }),
    ];
    const resolved = { "source:dpd": 120, "source:balance": 6000 };
    const result = evaluateDerivedFields(catalog, resolved);
    expect(result.values["is_high_risk"]).toBe(true);
    expect(result.traces["is_high_risk"].status).toBe("computed");
  });

  it("AND condition: one false → false", () => {
    const catalog: CatalogEntry[] = [
      makeLogicalEntry("both_present", {
        type: "logical",
        operator: "AND",
        conditions: [
          { field: "source:dpd", operator: ">", value: 90 },
          { field: "source:balance", operator: ">", value: 50000 },
        ],
      }),
    ];
    const resolved = { "source:dpd": 120, "source:balance": 6000 };
    const result = evaluateDerivedFields(catalog, resolved);
    expect(result.values["both_present"]).toBe(false);
  });

  it("OR condition: one true → true", () => {
    const catalog: CatalogEntry[] = [
      makeLogicalEntry("either_risk", {
        type: "logical",
        operator: "OR",
        conditions: [
          { field: "source:dpd", operator: ">", value: 90 },
          { field: "source:balance", operator: ">", value: 1000000 },
        ],
      }),
    ];
    const resolved = { "source:dpd": 120, "source:balance": 500 };
    const result = evaluateDerivedFields(catalog, resolved);
    expect(result.values["either_risk"]).toBe(true);
  });

  it("is_true operator evaluates boolean field", () => {
    const catalog: CatalogEntry[] = [
      makeLogicalEntry("vuln_flag", {
        type: "logical",
        operator: "AND",
        conditions: [{ field: "source:is_vulnerable", operator: "is_true" }],
      }),
    ];
    const result = evaluateDerivedFields(catalog, { "source:is_vulnerable": "yes" });
    expect(result.values["vuln_flag"]).toBe(true);
  });

  it("returns null when a required field is missing", () => {
    const catalog: CatalogEntry[] = [
      makeLogicalEntry("risk_flag", {
        type: "logical",
        operator: "AND",
        conditions: [{ field: "source:missing_field", operator: ">", value: 10 }],
      }),
    ];
    const result = evaluateDerivedFields(catalog, {});
    expect(result.traces["risk_flag"].status).toBe("null");
    expect(result.stageMetrics.counts["null"]).toBe(1);
  });
});

// ─── null vs skipped distinction ─────────────────────────────────────────────

describe("null vs skipped distinction", () => {
  it("marks field as skipped when derivationConfig is null", () => {
    const catalog: CatalogEntry[] = [makeSkippedEntry("incomplete_field")];
    const result = evaluateDerivedFields(catalog, {});
    expect(result.traces["incomplete_field"].status).toBe("skipped");
    expect(result.stageMetrics.counts["skipped"]).toBe(1);
  });

  it("marks field as null when config present but inputs missing", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("ratio", {
        fieldA: "source:absent",
        fieldALabel: "absent",
        operator1: "+",
        operandBType: "constant",
        operandBValue: "1",
      }),
    ];
    const result = evaluateDerivedFields(catalog, {});
    expect(result.traces["ratio"].status).toBe("null");
    expect(result.stageMetrics.counts["null"]).toBe(1);
    expect(result.stageMetrics.counts["skipped"]).toBe(0);
  });

  it("does not include skipped fields in values", () => {
    const catalog: CatalogEntry[] = [makeSkippedEntry("skipped_derived")];
    const result = evaluateDerivedFields(catalog, {});
    expect("skipped_derived" in result.values).toBe(false);
  });
});

// ─── Topological dependency ordering ─────────────────────────────────────────

describe("topological dependency ordering", () => {
  it("evaluates dependent derived field after its dependency", () => {
    // surplus = income - 500
    // surplus_double = surplus * 2
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("surplus_double", {
        fieldA: "surplus",
        fieldALabel: "surplus",
        operator1: "*",
        operandBType: "constant",
        operandBValue: "2",
      }),
      makeArithmeticEntry("surplus", {
        fieldA: "source:income",
        fieldALabel: "income",
        operator1: "-",
        operandBType: "constant",
        operandBValue: "500",
      }),
    ];
    const result = evaluateDerivedFields(catalog, { "source:income": 1000 });
    expect(result.values["surplus"]).toBe(500);
    expect(result.values["surplus_double"]).toBe(1000);
    expect(result.traces["surplus"].status).toBe("computed");
    expect(result.traces["surplus_double"].status).toBe("computed");
  });
});

// ─── Cycle detection ─────────────────────────────────────────────────────────

describe("cycle detection", () => {
  it("marks cyclic fields as error with cycle description", () => {
    // A depends on B, B depends on A
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("field_a", {
        fieldA: "field_b",
        fieldALabel: "field_b",
        operator1: "+",
        operandBType: "constant",
        operandBValue: "1",
      }),
      makeArithmeticEntry("field_b", {
        fieldA: "field_a",
        fieldALabel: "field_a",
        operator1: "+",
        operandBType: "constant",
        operandBValue: "1",
      }),
    ];
    const result = evaluateDerivedFields(catalog, {});
    expect(result.traces["field_a"].status).toBe("error");
    expect(result.traces["field_b"].status).toBe("error");
    expect(result.traces["field_a"].error).toMatch(/cycle/i);
    expect(result.stageMetrics.counts["error"]).toBe(2);
  });
});

// ─── Stage metrics ────────────────────────────────────────────────────────────

describe("stage metrics", () => {
  it("records counts by status", () => {
    const catalog: CatalogEntry[] = [
      makeArithmeticEntry("ok", {
        fieldA: "source:income",
        fieldALabel: "income",
        operator1: "+",
        operandBType: "constant",
        operandBValue: "1",
      }),
      makeSkippedEntry("skipped"),
    ];
    const result = evaluateDerivedFields(catalog, { "source:income": 100 });
    expect(result.stageMetrics.counts["computed"]).toBe(1);
    expect(result.stageMetrics.counts["skipped"]).toBe(1);
  });

  it("returns timing fields", () => {
    const catalog: CatalogEntry[] = [];
    const result = evaluateDerivedFields(catalog, {});
    expect(result.stageMetrics.startedAt).toBeTruthy();
    expect(result.stageMetrics.completedAt).toBeTruthy();
    expect(typeof result.stageMetrics.durationMs).toBe("number");
  });
});
