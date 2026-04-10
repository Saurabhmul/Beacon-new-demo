import type { CatalogEntry } from "../../field-catalog";
import type { SourceResolutionTrace, SourceResolutionMethod } from "./types";

/**
 * Normalize a field key to lowercase snake_case for comparison.
 * Trims, lowercases, collapses whitespace/hyphens/dots to underscores,
 * removes any remaining non-alphanumeric-underscore characters.
 */
export function normalizeKey(k: string): string {
  return k
    .trim()
    .toLowerCase()
    .replace(/[\s\-\.]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Derive the canonical field ID for a catalog entry.
 * Source fields from data_config get id "source:<fieldName>".
 * Policy fields (derived/business) get their DB row ID.
 */
function canonicalId(entry: CatalogEntry): string {
  if (entry.id) return entry.id;
  if (entry.sourceType === "source_field") return `source:${entry.label}`;
  return entry.label;
}

export interface FieldResolutionResult {
  /** canonicalFieldId → resolved value (may be null if field present but value is null) */
  resolvedValues: Record<string, unknown>;
  /** canonicalFieldId → resolution trace */
  traces: Record<string, SourceResolutionTrace>;
  /** raw keys that could not be matched to any catalog entry */
  unresolvedRawKeys: string[];
}

/**
 * Resolve raw source data keys to catalog field entries.
 *
 * Priority (strict, no fuzzy guessing beyond these three steps):
 *   1. Exact match    — rawKey === entry.label  (or rawKey matches the id suffix for source: entries)
 *   2. Normalized     — normalizeKey(rawKey) === normalizeKey(entry.label)
 *   3. Alias map      — aliasMap[rawKey] === canonicalFieldId
 *   4. Unresolved     — explicitly marked, never silently dropped
 *
 * Only source_field catalog entries are matched against raw data.
 * Derived and business fields are computed later by other engines.
 *
 * @param rawData     Raw customer data row
 * @param catalog     Full field catalog (source + derived + business entries)
 * @param aliasMap    Optional mapping: rawKey → canonicalFieldId
 * @returns           Resolved values, traces per field, and unresolved raw keys
 */
export function resolveSourceFields(
  rawData: Record<string, unknown>,
  catalog: CatalogEntry[],
  aliasMap: Record<string, string> = {}
): FieldResolutionResult {
  const sourceCatalog = catalog.filter(e => e.sourceType === "source_field");

  // Pre-build lookup structures
  const byExact = new Map<string, CatalogEntry>(); // label → entry
  const byNormalized = new Map<string, CatalogEntry>(); // normalizeKey(label) → entry (first wins)
  const byCanonicalId = new Map<string, CatalogEntry>(); // canonicalId → entry

  for (const entry of sourceCatalog) {
    byExact.set(entry.label, entry);
    const nk = normalizeKey(entry.label);
    if (!byNormalized.has(nk)) byNormalized.set(nk, entry);
    byCanonicalId.set(canonicalId(entry), entry);

    // Also index by the suffix of "source:<name>" ids
    const cid = canonicalId(entry);
    if (cid.startsWith("source:")) {
      const shortKey = cid.slice(7);
      byExact.set(shortKey, entry);
    }
  }

  const resolvedValues: Record<string, unknown> = {};
  const traces: Record<string, SourceResolutionTrace> = {};
  const unresolvedRawKeys: string[] = [];

  // Track which catalog entries have already been matched to avoid double-assignment
  const matchedCanonicalIds = new Set<string>();

  for (const rawKey of Object.keys(rawData)) {
    const rawValue = rawData[rawKey];
    let matchedEntry: CatalogEntry | undefined;
    let method: SourceResolutionMethod = "unresolved";
    let aliasUsed: string | undefined;

    // Step 1: Exact match
    if (byExact.has(rawKey)) {
      matchedEntry = byExact.get(rawKey)!;
      method = "exact";
    }

    // Step 2: Normalized match
    if (!matchedEntry) {
      const nk = normalizeKey(rawKey);
      if (byNormalized.has(nk)) {
        matchedEntry = byNormalized.get(nk)!;
        method = "normalized";
        console.warn(
          `[field-value-resolver] Normalized match used: rawKey="${rawKey}" → "${matchedEntry.label}". ` +
          `Consider adding an alias for deterministic resolution.`
        );
      }
    }

    // Step 3: Alias map match
    if (!matchedEntry) {
      const aliasTarget = aliasMap[rawKey];
      if (aliasTarget) {
        const fromId = byCanonicalId.get(aliasTarget);
        if (fromId) {
          matchedEntry = fromId;
          method = "alias";
          aliasUsed = aliasTarget;
          console.warn(
            `[field-value-resolver] Alias match used: rawKey="${rawKey}" → alias="${aliasTarget}" → "${matchedEntry.label}". `
          );
        }
      }
    }

    if (matchedEntry) {
      const cid = canonicalId(matchedEntry);

      // If this canonical ID was already resolved by a higher-priority match, skip
      if (matchedCanonicalIds.has(cid)) {
        // Lower-priority match for an already-resolved field — treat raw key as unresolved
        unresolvedRawKeys.push(rawKey);
        continue;
      }

      matchedCanonicalIds.add(cid);

      const normalizedValue =
        rawValue === null || rawValue === undefined
          ? null
          : String(rawValue);

      const trace: SourceResolutionTrace = {
        rawKey,
        canonicalFieldId: cid,
        method,
        rawValue,
        normalizedValue,
        ...(aliasUsed !== undefined ? { aliasUsed } : {}),
      };

      resolvedValues[cid] = rawValue;
      traces[cid] = trace;
    } else {
      // Unresolved: explicitly track it
      const trace: SourceResolutionTrace = {
        rawKey,
        canonicalFieldId: rawKey,
        method: "unresolved",
        rawValue,
        normalizedValue: rawValue === null || rawValue === undefined ? null : String(rawValue),
      };
      traces[`_unresolved:${rawKey}`] = trace;
      unresolvedRawKeys.push(rawKey);
    }
  }

  // Also mark catalog entries for which no raw key was found as unresolved
  for (const entry of sourceCatalog) {
    const cid = canonicalId(entry);
    if (!matchedCanonicalIds.has(cid)) {
      traces[cid] = {
        rawKey: "",
        canonicalFieldId: cid,
        method: "unresolved",
        rawValue: undefined,
        normalizedValue: null,
      };
      // resolvedValues does NOT get an entry — callers distinguish
      // "field absent from data" (no key in resolvedValues) from
      // "field present but value is null" (key present, value === null)
    }
  }

  return { resolvedValues, traces, unresolvedRawKeys };
}
