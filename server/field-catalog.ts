import type { DataConfig, PolicyFieldRecord, DerivationConfig } from "@shared/schema";

export interface CatalogEntry {
  id?: string;
  label: string;
  sourceType: "source_field" | "business_field" | "derived_field";
  description?: string | null;
  derivationSummary?: string | null;
  derivationConfig?: DerivationConfig | null;
}

export function normalizeFieldLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

interface FieldCatalogStorage {
  getDataConfig(companyId: string): Promise<DataConfig | undefined>;
  getPolicyFields(companyId: string): Promise<PolicyFieldRecord[]>;
}

export async function buildFullFieldCatalog(
  companyId: string | null,
  storage: FieldCatalogStorage
): Promise<CatalogEntry[]> {
  const dedup = new Map<string, CatalogEntry>();

  if (companyId) {
    let dataConfig: DataConfig | undefined;
    try {
      dataConfig = await storage.getDataConfig(companyId);
    } catch {
      dataConfig = undefined;
    }

    const categoryData = dataConfig?.categoryData as
      | Record<string, { fieldAnalysis?: { fieldName: string; ignored: boolean; beaconsUnderstanding?: string }[] }>
      | null
      | undefined;

    if (categoryData && typeof categoryData === "object") {
      for (const [, catEntry] of Object.entries(categoryData)) {
        if (!catEntry || !Array.isArray(catEntry.fieldAnalysis)) continue;
        for (const f of catEntry.fieldAnalysis) {
          if (!f.fieldName || f.ignored) continue;
          const key = normalizeFieldLabel(f.fieldName);
          if (!dedup.has(key)) {
            dedup.set(key, {
              id: `source:${f.fieldName}`,
              label: f.fieldName,
              sourceType: "source_field",
              description: f.beaconsUnderstanding ?? null,
              derivationSummary: null,
              derivationConfig: null,
            });
          }
        }
      }
    }

    try {
      const dbFields = await storage.getPolicyFields(companyId);
      for (const f of dbFields) {
        const key = normalizeFieldLabel(f.label);
        dedup.set(key, {
          id: String(f.id),
          label: f.label,
          sourceType: f.sourceType === "derived_field" ? "derived_field" : "business_field",
          description: f.description ?? null,
          derivationSummary: f.derivationSummary ?? null,
          derivationConfig: f.derivationConfig ?? null,
        });
      }
    } catch {
    }
  }

  return Array.from(dedup.values()).sort((a, b) => a.label.localeCompare(b.label));
}
