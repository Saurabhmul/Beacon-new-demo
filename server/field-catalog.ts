import type { DataConfig, PolicyFieldRecord, DerivationConfig } from "@shared/schema";
import { resolveFieldType, deduceTypeFromDerivation } from "@shared/field-utils";

export interface CatalogEntry {
  id?: string;
  label: string;
  displayName?: string | null;
  sourceType: "source_field" | "business_field" | "derived_field";
  description?: string | null;
  dataType?: string | null;
  derivationSummary?: string | null;
  derivationConfig?: DerivationConfig | null;
  allowedValues?: string[] | null;
  defaultValue?: string | null;
  businessMeaning?: string | null;
  aiGenerated?: boolean | null;
  createdBy?: string | null;
  sampleValues?: string[] | null;
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
      | Record<string, { fieldAnalysis?: { fieldName: string; ignored: boolean; beaconsUnderstanding?: string; sampleValues?: string[]; dataType?: string | null; allowedValues?: string[] | null; defaultValue?: string | null }[] }>
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
              sampleValues: f.sampleValues ?? [],
              dataType: f.dataType ?? null,
              allowedValues: f.allowedValues ?? null,
              defaultValue: f.defaultValue ?? null,
              derivationSummary: null,
              derivationConfig: null,
            });
          }
        }
      }
    }

    const dbFields = await storage.getPolicyFields(companyId);
    for (const f of dbFields) {
      const key = normalizeFieldLabel(f.label);
      let effectiveType = f.dataType ?? null;
      if (!effectiveType && f.sourceType === "derived_field" && f.derivationConfig) {
        const config = f.derivationConfig as { operator1?: string; operator2?: string };
        const { deducedType } = deduceTypeFromDerivation(config);
        effectiveType = deducedType;
      }
      dedup.set(key, {
        id: String(f.id),
        label: f.label,
        displayName: f.displayName ?? null,
        sourceType: f.sourceType === "derived_field" ? "derived_field" : "business_field",
        description: f.description ?? null,
        dataType: effectiveType,
        derivationSummary: f.derivationSummary ?? null,
        derivationConfig: f.derivationConfig ?? null,
        allowedValues: f.allowedValues ?? null,
        defaultValue: f.defaultValue ?? null,
        businessMeaning: f.businessMeaning ?? null,
        aiGenerated: f.aiGenerated ?? false,
        createdBy: f.createdBy ?? null,
      });
    }
  }

  return Array.from(dedup.values()).sort((a, b) => a.label.localeCompare(b.label));
}
