import { describe, it, expect } from "vitest";
import { DraftTreatmentItemSchema } from "../server/ai-engine";
import { toLogicOperator } from "../server/lib/treatment-logic";

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
