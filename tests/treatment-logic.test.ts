import { describe, it, expect } from "vitest";
import { DraftTreatmentItemSchema } from "../server/ai-engine";
import { toLogicOperator, normalizeDraftPriorities } from "../server/lib/treatment-logic";

const MINIMAL_ITEM = {
  name: "Test Treatment",
};

describe("DraftTreatmentItemSchema — logic field defaults", () => {
  it("applies correct defaults when logic fields are missing", () => {
    const result = DraftTreatmentItemSchema.parse(MINIMAL_ITEM);
    expect(result.when_to_offer_logic).toBe("ALL");
    expect(result.blocked_if_logic).toBe("ANY");
  });

  it("falls back safely on invalid logic values", () => {
    const result = DraftTreatmentItemSchema.parse({
      ...MINIMAL_ITEM,
      when_to_offer_logic: "SOME",
      blocked_if_logic: null,
    });
    expect(result.when_to_offer_logic).toBe("ALL");
    expect(result.blocked_if_logic).toBe("ANY");
  });

  it("preserves explicit valid logic values", () => {
    const result = DraftTreatmentItemSchema.parse({
      ...MINIMAL_ITEM,
      when_to_offer_logic: "ANY",
      blocked_if_logic: "ALL",
    });
    expect(result.when_to_offer_logic).toBe("ANY");
    expect(result.blocked_if_logic).toBe("ALL");
  });
});

describe("toLogicOperator — ALL/ANY → AND/OR mapping", () => {
  it("maps ALL → AND, ANY → OR, and honours defaultVal for undefined", () => {
    expect(toLogicOperator("ALL", "AND")).toBe("AND");
    expect(toLogicOperator("ANY", "OR")).toBe("OR");
    expect(toLogicOperator(undefined, "OR")).toBe("OR");
    expect(toLogicOperator(undefined, "AND")).toBe("AND");
  });
});

describe("normalizeDraftPriorities", () => {
  it("produces unique 1..N sequence from distinct priorities", () => {
    expect(normalizeDraftPriorities([1, 3, 7])).toEqual(["1", "2", "3"]);
  });

  it("normalizes duplicate priorities using original index as tiebreaker", () => {
    expect(normalizeDraftPriorities([1, 3, 3, 7])).toEqual(["1", "2", "3", "4"]);
  });

  it("puts null priorities at end in document order", () => {
    expect(normalizeDraftPriorities([2, null, 5])).toEqual(["1", "3", "2"]);
  });

  it("assigns 1..N by document order when all priorities are null", () => {
    expect(normalizeDraftPriorities([null, null, null])).toEqual(["1", "2", "3"]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeDraftPriorities([])).toEqual([]);
  });

  it("handles single item", () => {
    expect(normalizeDraftPriorities([42])).toEqual(["1"]);
  });

  it("handles undefined the same as null", () => {
    expect(normalizeDraftPriorities([undefined, 2])).toEqual(["2", "1"]);
  });

  it("preserves AI relative order when priorities are already strictly increasing", () => {
    expect(normalizeDraftPriorities([4, 10, 20])).toEqual(["1", "2", "3"]);
  });
});
