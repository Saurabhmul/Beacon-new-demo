import { describe, it, expect } from "vitest";
import { resolveSourceFields, normalizeKey } from "../../server/lib/decisioning/field-value-resolver";
import type { CatalogEntry } from "../../server/field-catalog";

function makeSrcEntry(label: string, id?: string): CatalogEntry {
  return {
    id: id ?? `source:${label}`,
    label,
    sourceType: "source_field",
  };
}

function makeDerivedEntry(label: string): CatalogEntry {
  return {
    id: `derived:${label}`,
    label,
    sourceType: "derived_field",
  };
}

describe("normalizeKey", () => {
  it("lowercases and replaces spaces with underscores", () => {
    expect(normalizeKey("Days Past Due")).toBe("days_past_due");
  });

  it("handles hyphens and dots", () => {
    expect(normalizeKey("amount-due.value")).toBe("amount_due_value");
  });

  it("removes special characters", () => {
    expect(normalizeKey("field(name)")).toBe("fieldname");
  });

  it("collapses multiple separators", () => {
    expect(normalizeKey("some  field__name")).toBe("some_field_name");
  });
});

describe("resolveSourceFields – exact match", () => {
  it("matches raw key to catalog entry by exact label", () => {
    const catalog = [makeSrcEntry("days_past_due")];
    const raw = { days_past_due: 30 };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog);
    expect(resolvedValues["source:days_past_due"]).toBe(30);
    expect(traces["source:days_past_due"].method).toBe("exact");
  });

  it("records rawKey and normalizedValue in trace", () => {
    const catalog = [makeSrcEntry("amount_due")];
    const raw = { amount_due: "500.00" };
    const { traces } = resolveSourceFields(raw, catalog);
    expect(traces["source:amount_due"].rawKey).toBe("amount_due");
    expect(traces["source:amount_due"].normalizedValue).toBe("500.00");
  });

  it("null field value is stored as null (not absent)", () => {
    const catalog = [makeSrcEntry("email")];
    const raw = { email: null };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog);
    expect("source:email" in resolvedValues).toBe(true);
    expect(resolvedValues["source:email"]).toBeNull();
    expect(traces["source:email"].normalizedValue).toBeNull();
  });
});

describe("resolveSourceFields – normalized match beats alias", () => {
  it("uses normalized match when exact fails", () => {
    const catalog = [makeSrcEntry("days_past_due")];
    const raw = { "Days Past Due": 15 };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog);
    expect(resolvedValues["source:days_past_due"]).toBe(15);
    expect(traces["source:days_past_due"].method).toBe("normalized");
  });

  it("exact match wins over normalized match for same field", () => {
    const catalog = [makeSrcEntry("amount_due")];
    // Both keys normalize to the same thing, but one is exact
    const raw = { amount_due: 100, "Amount Due": 200 };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog);
    expect(resolvedValues["source:amount_due"]).toBe(100);
    expect(traces["source:amount_due"].method).toBe("exact");
  });
});

describe("resolveSourceFields – alias map", () => {
  it("uses alias map when exact and normalized both fail", () => {
    const catalog = [makeSrcEntry("customer_guid", "source:customer_guid")];
    const raw = { cust_id: "abc-123" };
    const aliasMap = { cust_id: "source:customer_guid" };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog, aliasMap);
    expect(resolvedValues["source:customer_guid"]).toBe("abc-123");
    expect(traces["source:customer_guid"].method).toBe("alias");
    expect(traces["source:customer_guid"].aliasUsed).toBe("source:customer_guid");
  });

  it("exact beats alias for the same field", () => {
    const catalog = [makeSrcEntry("customer_guid")];
    const raw = { customer_guid: "direct", cust_id: "via-alias" };
    const aliasMap = { cust_id: "source:customer_guid" };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog, aliasMap);
    expect(resolvedValues["source:customer_guid"]).toBe("direct");
    expect(traces["source:customer_guid"].method).toBe("exact");
  });

  it("normalized beats alias for the same field", () => {
    const catalog = [makeSrcEntry("customer_guid")];
    const raw = { "Customer GUID": "normalized-match", cust_id: "via-alias" };
    const aliasMap = { cust_id: "source:customer_guid" };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog, aliasMap);
    expect(resolvedValues["source:customer_guid"]).toBe("normalized-match");
    expect(traces["source:customer_guid"].method).toBe("normalized");
  });
});

describe("resolveSourceFields – unresolved", () => {
  it("marks keys with no match as unresolved", () => {
    const catalog = [makeSrcEntry("amount_due")];
    const raw = { totally_unknown_field: "foo" };
    const { unresolvedRawKeys, traces } = resolveSourceFields(raw, catalog);
    expect(unresolvedRawKeys).toContain("totally_unknown_field");
    expect(traces["_unresolved:totally_unknown_field"].method).toBe("unresolved");
  });

  it("catalog entries with no raw data match are also marked unresolved in traces", () => {
    const catalog = [makeSrcEntry("days_past_due"), makeSrcEntry("email")];
    const raw = { days_past_due: 10 };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog);
    // email not in raw data → unresolved in traces, absent from resolvedValues
    expect("source:email" in resolvedValues).toBe(false);
    expect(traces["source:email"].method).toBe("unresolved");
    expect(traces["source:email"].rawValue).toBeUndefined();
  });

  it("does NOT include derived/business fields in resolution", () => {
    const catalog = [makeSrcEntry("amount_due"), makeDerivedEntry("affordability_score")];
    const raw = { amount_due: 500, affordability_score: "HIGH" };
    const { resolvedValues } = resolveSourceFields(raw, catalog);
    // affordability_score is derived — should not be resolved here
    expect("derived:affordability_score" in resolvedValues).toBe(false);
    // It should appear in unresolvedRawKeys (since nothing matched it in source catalog)
    // But the source key amount_due should be resolved
    expect(resolvedValues["source:amount_due"]).toBe(500);
  });
});

describe("resolveSourceFields – priority enforcement and duplicate tracking", () => {
  it("second match of the same field is tracked as unresolved raw key", () => {
    const catalog = [makeSrcEntry("days_past_due")];
    // Two raw keys both normalize to the same field; exact match wins
    const raw = { days_past_due: 10, "DAYS_PAST_DUE": 20 };
    const { resolvedValues, traces, unresolvedRawKeys } = resolveSourceFields(raw, catalog);
    // Exact match wins
    expect(resolvedValues["source:days_past_due"]).toBe(10);
    expect(traces["source:days_past_due"].method).toBe("exact");
    // The second key is in unresolvedRawKeys
    expect(unresolvedRawKeys.some(k => k === "DAYS_PAST_DUE")).toBe(true);
  });

  it("exact key wins even when alias key appears first in raw data (priority is field-centric)", () => {
    // This tests the critical fix: priority is enforced per FIELD, not per raw key iteration order.
    // If we iterate raw keys and alias key comes first, it should NOT win over the exact key.
    const catalog = [makeSrcEntry("customer_guid")];
    // Both cust_id (alias) and customer_guid (exact) map to the same field
    // Object key order: cust_id first, customer_guid second
    const raw: Record<string, unknown> = {};
    raw["cust_id"] = "via-alias";
    raw["customer_guid"] = "exact-match";
    const aliasMap = { cust_id: "source:customer_guid" };
    const { resolvedValues, traces, unresolvedRawKeys } = resolveSourceFields(raw, catalog, aliasMap);
    // Exact always wins regardless of iteration order
    expect(resolvedValues["source:customer_guid"]).toBe("exact-match");
    expect(traces["source:customer_guid"].method).toBe("exact");
    // cust_id becomes explicitly unresolved
    expect(unresolvedRawKeys).toContain("cust_id");
    expect(traces["_unresolved:cust_id"]).toBeDefined();
    expect(traces["_unresolved:cust_id"].method).toBe("unresolved");
  });

  it("normalized key wins even when alias key appears first (normalized > alias)", () => {
    const catalog = [makeSrcEntry("customer_guid")];
    const raw: Record<string, unknown> = {};
    raw["cust_id"] = "via-alias";
    raw["Customer GUID"] = "normalized-match"; // normalizes to "customer_guid"
    const aliasMap = { cust_id: "source:customer_guid" };
    const { resolvedValues, traces } = resolveSourceFields(raw, catalog, aliasMap);
    // Normalized wins over alias
    expect(resolvedValues["source:customer_guid"]).toBe("normalized-match");
    expect(traces["source:customer_guid"].method).toBe("normalized");
  });

  it("every losing raw key gets an explicit unresolved trace entry", () => {
    const catalog = [makeSrcEntry("days_past_due")];
    // Three keys all mapping to the same field: exact wins, other two must have trace entries
    const raw = { days_past_due: 10, "Days Past Due": 20, "DAYS_PAST_DUE": 30 };
    const { traces } = resolveSourceFields(raw, catalog);
    // Exact wins
    expect(traces["source:days_past_due"].method).toBe("exact");
    // Both other keys should have _unresolved trace entries
    const unresolvedTraces = Object.keys(traces).filter(k => k.startsWith("_unresolved:"));
    expect(unresolvedTraces.length).toBeGreaterThanOrEqual(2);
  });
});
