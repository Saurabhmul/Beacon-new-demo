import { describe, it, expect } from "vitest";
import { buildFullFieldCatalog, normalizeFieldLabel } from "../server/field-catalog";

const makeStorage = (opts: {
  dataConfig?: object | null;
  policyFields?: Array<{ id: number; label: string; sourceType: string; description?: string | null; derivationSummary?: string | null; derivationConfig?: object | null }>;
}) => ({
  async getDataConfig(_companyId: string) {
    return opts.dataConfig === undefined ? undefined : (opts.dataConfig as any);
  },
  async getPolicyFields(_companyId: string) {
    return (opts.policyFields ?? []) as any[];
  },
});

describe("buildFullFieldCatalog", () => {
  it("includes source fields from dataConfig when not in policy_fields", async () => {
    const storage = makeStorage({
      dataConfig: {
        categoryData: {
          loan_data: {
            fieldAnalysis: [
              { fieldName: "active_breathing_space", ignored: false, beaconsUnderstanding: "Flag for breathing space" },
            ],
          },
        },
      },
      policyFields: [],
    });

    const catalog = await buildFullFieldCatalog("company-1", storage);

    const entry = catalog.find(f => normalizeFieldLabel(f.label) === "active_breathing_space");
    expect(entry).toBeDefined();
    expect(entry!.sourceType).toBe("source_field");
    expect(entry!.id).toBe("source:active_breathing_space");

    const fieldByLabelLower = new Map(catalog.map(f => [normalizeFieldLabel(f.label), f]));
    expect(fieldByLabelLower.has("active_breathing_space")).toBe(true);
  });

  it("DB record wins when same label exists in dataConfig and policy_fields", async () => {
    const storage = makeStorage({
      dataConfig: {
        categoryData: {
          loan_data: {
            fieldAnalysis: [
              { fieldName: "active_breathing_space", ignored: false, beaconsUnderstanding: "Source description" },
            ],
          },
        },
      },
      policyFields: [
        {
          id: 42,
          label: "active_breathing_space",
          sourceType: "business_field",
          description: "DB description",
          derivationSummary: null,
          derivationConfig: null,
        },
      ],
    });

    const catalog = await buildFullFieldCatalog("company-1", storage);

    const entries = catalog.filter(f => normalizeFieldLabel(f.label) === "active_breathing_space");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.id).toBe("42");
    expect(entry.sourceType).toBe("business_field");
    expect(entry.description).toBe("DB description");
  });
});
