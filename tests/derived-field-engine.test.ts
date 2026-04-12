import { describe, it, expect } from "vitest";
import { computeDerivedFields, buildResolvedSourceFieldsMap } from "../server/lib/decisioning/derived-field-engine";
import type { PolicyFieldRecord } from "../shared/schema";

function makeSourceField(id: number, label: string): PolicyFieldRecord {
  return {
    id,
    companyId: "test-company",
    policyPackId: 1,
    label,
    displayName: null,
    description: null,
    sourceType: "source_field",
    dataType: "number",
    derivationConfig: null,
    derivationSummary: null,
    allowedValues: null,
    defaultValue: null,
    businessMeaning: null,
    aiGenerated: false,
    createdBy: null,
    sourceDocumentId: null,
    createdAt: new Date(),
  };
}

function makeDerivedField(
  id: number,
  label: string,
  derivationConfig: Record<string, unknown>
): PolicyFieldRecord {
  return {
    id,
    companyId: "test-company",
    policyPackId: 1,
    label,
    displayName: null,
    description: null,
    sourceType: "derived_field",
    dataType: "number",
    derivationConfig: derivationConfig as PolicyFieldRecord["derivationConfig"],
    derivationSummary: null,
    allowedValues: null,
    defaultValue: null,
    businessMeaning: null,
    aiGenerated: false,
    createdBy: null,
    sourceDocumentId: null,
    createdAt: new Date(),
  };
}

describe("computeDerivedFields — ID-based arithmetic config", () => {
  it("resolves fieldA stored as numeric DB ID to the correct value", () => {
    const sourceA = makeSourceField(10, "Monthly Income");
    const sourceB = makeSourceField(11, "Monthly Debt");
    const derived = makeDerivedField(20, "Debt-to-Income Ratio", {
      fieldA: "11",
      fieldALabel: "Monthly Debt",
      operator1: "/",
      operandBType: "field",
      operandBValue: "10",
      operandBLabel: "Monthly Income",
    });

    const allPolicyFields = [sourceA, sourceB, derived];
    const resolvedSourceFields = {
      "Monthly Income": 5000,
      "Monthly Debt": 1500,
    };

    const traces = computeDerivedFields([derived], resolvedSourceFields, {}, {}, allPolicyFields);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.field_label).toBe("Debt-to-Income Ratio");
    expect(trace.field_id).toBe("20");
    expect(trace.nullReason).toBeNull();
    expect(trace.output_value).toBeCloseTo(0.3, 5);
  });

  it("resolves a constant operand (operandBType=constant) without normalizing the constant value", () => {
    const sourceA = makeSourceField(10, "Loan Balance");
    const derived = makeDerivedField(21, "Adjusted Balance", {
      fieldA: "10",
      fieldALabel: "Loan Balance",
      operator1: "*",
      operandBType: "constant",
      operandBValue: "1.05",
    });

    const allPolicyFields = [sourceA, derived];
    const resolvedSourceFields = { "Loan Balance": 20000 };

    const traces = computeDerivedFields([derived], resolvedSourceFields, {}, {}, allPolicyFields);

    expect(traces).toHaveLength(1);
    expect(traces[0].nullReason).toBeNull();
    expect(traces[0].output_value).toBeCloseTo(21000, 1);
  });
});

describe("computeDerivedFields — label-based arithmetic config (backward-compatibility)", () => {
  it("resolves fieldA stored as a label string without any translation", () => {
    const sourceA = makeSourceField(10, "Annual Revenue");
    const sourceB = makeSourceField(11, "Annual Costs");
    const derived = makeDerivedField(22, "Net Margin", {
      fieldA: "Annual Revenue",
      fieldALabel: "Annual Revenue",
      operator1: "-",
      operandBType: "field",
      operandBValue: "Annual Costs",
      operandBLabel: "Annual Costs",
    });

    const allPolicyFields = [sourceA, sourceB, derived];
    const resolvedSourceFields = {
      "Annual Revenue": 100000,
      "Annual Costs": 60000,
    };

    const traces = computeDerivedFields([derived], resolvedSourceFields, {}, {}, allPolicyFields);

    expect(traces).toHaveLength(1);
    expect(traces[0].field_label).toBe("Net Margin");
    expect(traces[0].nullReason).toBeNull();
    expect(traces[0].output_value).toBe(40000);
  });

  it("produces the same result whether the config uses IDs or labels for the same fields", () => {
    const src = makeSourceField(30, "Credit Score");
    const derivedById = makeDerivedField(40, "Score Factor A", {
      fieldA: "30",
      fieldALabel: "Credit Score",
      operator1: "/",
      operandBType: "constant",
      operandBValue: "850",
    });
    const derivedByLabel = makeDerivedField(41, "Score Factor B", {
      fieldA: "Credit Score",
      fieldALabel: "Credit Score",
      operator1: "/",
      operandBType: "constant",
      operandBValue: "850",
    });

    const allPolicyFields = [src, derivedById, derivedByLabel];
    const resolvedSourceFields = { "Credit Score": 680 };

    const traceById = computeDerivedFields([derivedById], resolvedSourceFields, {}, {}, allPolicyFields);
    const traceByLabel = computeDerivedFields([derivedByLabel], resolvedSourceFields, {}, {}, allPolicyFields);

    expect(traceById[0].nullReason).toBeNull();
    expect(traceByLabel[0].nullReason).toBeNull();
    expect(traceById[0].output_value).toBeCloseTo(traceByLabel[0].output_value as number, 10);
  });
});

describe("computeDerivedFields — derived-field-to-derived-field dependency chain", () => {
  it("evaluates field A then field B when B depends on A (IDs stored in config)", () => {
    const srcField = makeSourceField(50, "Principal Amount");
    const derivedA = makeDerivedField(60, "Monthly Payment", {
      fieldA: "50",
      fieldALabel: "Principal Amount",
      operator1: "/",
      operandBType: "constant",
      operandBValue: "12",
    });
    const derivedB = makeDerivedField(61, "Annual Obligation", {
      fieldA: "60",
      fieldALabel: "Monthly Payment",
      operator1: "*",
      operandBType: "constant",
      operandBValue: "12",
    });

    const allPolicyFields = [srcField, derivedA, derivedB];
    const resolvedSourceFields = { "Principal Amount": 12000 };

    const traces = computeDerivedFields([derivedA, derivedB], resolvedSourceFields, {}, {}, allPolicyFields);

    expect(traces).toHaveLength(2);

    const traceA = traces.find(t => t.field_label === "Monthly Payment");
    const traceB = traces.find(t => t.field_label === "Annual Obligation");

    expect(traceA).toBeDefined();
    expect(traceA!.nullReason).toBeNull();
    expect(traceA!.output_value).toBe(1000);

    expect(traceB).toBeDefined();
    expect(traceB!.nullReason).toBeNull();
    expect(traceB!.output_value).toBe(12000);
  });

  it("correctly propagates null when the upstream derived field fails", () => {
    const srcField = makeSourceField(50, "Base Amount");
    const derivedA = makeDerivedField(70, "Intermediate Value", {
      fieldA: "999",
      fieldALabel: "Nonexistent Field",
      operator1: "+",
      operandBType: "constant",
      operandBValue: "0",
    });
    const derivedB = makeDerivedField(71, "Final Value", {
      fieldA: "70",
      fieldALabel: "Intermediate Value",
      operator1: "*",
      operandBType: "constant",
      operandBValue: "2",
    });

    const allPolicyFields = [srcField, derivedA, derivedB];
    const resolvedSourceFields = { "Base Amount": 100 };

    const traces = computeDerivedFields([derivedA, derivedB], resolvedSourceFields, {}, {}, allPolicyFields);

    const traceA = traces.find(t => t.field_label === "Intermediate Value");
    const traceB = traces.find(t => t.field_label === "Final Value");

    expect(traceA!.nullReason).toBe("missing dependency");
    expect(traceB!.nullReason).not.toBeNull();
  });

  it("field_label is always set and equals field.label", () => {
    const src = makeSourceField(80, "Input Value");
    const derived = makeDerivedField(90, "Output Value", {
      fieldA: "80",
      operator1: "+",
      operandBType: "constant",
      operandBValue: "10",
    });

    const allPolicyFields = [src, derived];
    const resolvedSourceFields = { "Input Value": 5 };

    const traces = computeDerivedFields([derived], resolvedSourceFields, {}, {}, allPolicyFields);

    expect(traces[0].field_label).toBe("Output Value");
    expect(traces[0].field_id).toBe("90");
  });
});

describe("UI fallback — old traces without field_label", () => {
  it("renders field_id when field_label is absent (backward-compatible fallback expression)", () => {
    const oldTrace: Record<string, unknown> = {
      field_id: "42",
      formula: "some formula",
      output_value: null,
      nullReason: "missing dependency",
    };

    const displayed = String(oldTrace["field_label"] ?? oldTrace["field_id"] ?? "");
    expect(displayed).toBe("42");
  });

  it("prefers field_label over field_id when both are present", () => {
    const newTrace: Record<string, unknown> = {
      field_id: "42",
      field_label: "Debt-to-Income Ratio",
      formula: "some formula",
      output_value: 0.3,
      nullReason: null,
    };

    const displayed = String(newTrace["field_label"] ?? newTrace["field_id"] ?? "");
    expect(displayed).toBe("Debt-to-Income Ratio");
  });

  it("renders empty string when both field_label and field_id are absent", () => {
    const emptyTrace: Record<string, unknown> = {
      formula: "some formula",
      output_value: null,
    };

    // field_label is undefined → falls through; field_id is undefined → falls through; "" is used
    const displayed = String(emptyTrace["field_label"] ?? emptyTrace["field_id"] ?? "");
    expect(displayed).toBe("");
  });
});

describe("buildResolvedSourceFieldsMap", () => {
  it("maps customer data to source field labels generically", () => {
    const src1 = makeSourceField(1, "Outstanding Balance");
    const src2 = makeSourceField(2, "Days Past Due");

    const customerData = {
      "Outstanding Balance": 5000,
      "Days Past Due": 45,
      irrelevant_field: "ignored",
    };

    const result = buildResolvedSourceFieldsMap(customerData, [src1, src2]);
    expect(result["Outstanding Balance"]).toBe(5000);
    expect(result["Days Past Due"]).toBe(45);
    expect("irrelevant_field" in result).toBe(false);
  });
});
