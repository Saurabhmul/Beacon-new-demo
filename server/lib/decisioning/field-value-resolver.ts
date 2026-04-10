import type { CatalogEntry } from "../../field-catalog";
import type { SourceResolutionTrace, SourceResolutionMethod } from "./types";

/**
 * Normalize a field key to lowercase snake_case for comparison.
 * Trims, lowercases, collapses whitespace/hyphens/dots to underscores,
 * removes remaining non-alphanumeric-underscore characters.
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
  /** canonicalFieldId → winner trace; "_unresolved:<rawKey>" → unresolved trace */
  traces: Record<string, SourceResolutionTrace>;
  /** raw keys that could not be matched (no catalog entry) OR lost to a higher-priority match */
  unresolvedRawKeys: string[];
}

/**
 * Resolve raw source data keys to catalog field entries.
 *
 * Resolution is FIELD-CENTRIC, not raw-key-centric. For each canonical catalog
 * field, all competing raw keys are evaluated and the highest-priority match wins:
 *
 *   1. Exact match    — rawKey === entry.label  (or short form of source: id)
 *   2. Normalized     — normalizeKey(rawKey) === normalizeKey(entry.label)
 *   3. Alias map      — aliasMap[rawKey] === canonicalFieldId
 *   4. Unresolved     — no match found
 *
 * This ordering is enforced regardless of the order keys appear in rawData,
 * so an alias key arriving before an exact key never wins.
 *
 * Every "losing" raw key (lower-priority match for an already-won field) AND
 * every truly-unmatched raw key gets an explicit `_unresolved:<rawKey>` trace
 * entry — nothing is silently dropped.
 *
 * @param rawData     Raw customer data row
 * @param catalog     Full field catalog (source + derived + business entries)
 * @param aliasMap    Optional mapping: rawKey → canonicalFieldId
 */
export function resolveSourceFields(
  rawData: Record<string, unknown>,
  catalog: CatalogEntry[],
  aliasMap: Record<string, string> = {}
): FieldResolutionResult {
  const sourceCatalog = catalog.filter(e => e.sourceType === "source_field");

  // Build lookup structures
  const byExact = new Map<string, CatalogEntry>();       // label (and short source: suffix) → entry
  const byNormalized = new Map<string, CatalogEntry>();  // normalizeKey(label) → first entry
  const byCanonicalId = new Map<string, CatalogEntry>(); // canonicalId → entry

  for (const entry of sourceCatalog) {
    byExact.set(entry.label, entry);
    const nk = normalizeKey(entry.label);
    if (!byNormalized.has(nk)) byNormalized.set(nk, entry);
    const cid = canonicalId(entry);
    byCanonicalId.set(cid, entry);
    if (entry.id && entry.id !== cid) byCanonicalId.set(entry.id, entry);
    // Also index by the short-form of source: ids so "DPD" matches "source:DPD"
    if (cid.startsWith("source:")) byExact.set(cid.slice(7), entry);
  }

  const METHOD_PRIORITY: Record<SourceResolutionMethod, number> = {
    exact: 0,
    normalized: 1,
    alias: 2,
    unresolved: 99,
  };

  interface Candidate {
    rawKey: string;
    entry: CatalogEntry;
    method: SourceResolutionMethod;
    aliasUsed?: string;
  }

  // ── Pass 1: for each raw key, find its best single match ──────────────────
  //
  // Each raw key is evaluated independently: we identify which catalog entry
  // it matches (if any) and at what method level. Multiple raw keys may
  // resolve to the SAME canonical field — we handle conflicts in Pass 2.

  const fieldCandidates = new Map<string, Candidate[]>(); // cid → competing candidates
  const noMatchRawKeys: string[] = [];

  for (const rawKey of Object.keys(rawData)) {
    let entry: CatalogEntry | undefined;
    let method: SourceResolutionMethod = "unresolved";
    let aliasUsed: string | undefined;

    // Step 1: exact
    if (byExact.has(rawKey)) {
      entry = byExact.get(rawKey)!;
      method = "exact";
    }

    // Step 2: normalized (only if exact failed)
    if (!entry) {
      const nk = normalizeKey(rawKey);
      if (byNormalized.has(nk)) {
        entry = byNormalized.get(nk)!;
        method = "normalized";
      }
    }

    // Step 3: alias map (only if exact and normalized both failed)
    if (!entry) {
      const aliasTarget = aliasMap[rawKey];
      if (aliasTarget) {
        const fromAlias = byCanonicalId.get(aliasTarget);
        if (fromAlias) {
          entry = fromAlias;
          method = "alias";
          aliasUsed = aliasTarget;
        }
      }
    }

    if (entry) {
      const cid = canonicalId(entry);
      if (!fieldCandidates.has(cid)) fieldCandidates.set(cid, []);
      fieldCandidates.get(cid)!.push({ rawKey, entry, method, aliasUsed });
    } else {
      // No match at all for this raw key
      noMatchRawKeys.push(rawKey);
    }
  }

  // ── Pass 2: for each canonical field, pick the best candidate ─────────────
  //
  // Candidates for the same field are sorted by method priority so exact
  // always wins over normalized, which always wins over alias — regardless
  // of the order keys appeared in rawData.

  const resolvedValues: Record<string, unknown> = {};
  const traces: Record<string, SourceResolutionTrace> = {};
  const unresolvedRawKeys: string[] = [...noMatchRawKeys];

  for (const [cid, candidates] of fieldCandidates) {
    // Sort ascending by method priority so the best match is candidates[0]
    candidates.sort((a, b) => METHOD_PRIORITY[a.method] - METHOD_PRIORITY[b.method]);

    const winner = candidates[0];
    const rawValue = rawData[winner.rawKey];
    const normalizedValue = rawValue === null || rawValue === undefined ? null : String(rawValue);

    // Log non-exact matches so consumers know resolution fell back
    if (winner.method === "normalized") {
      console.warn(
        `[field-value-resolver] Normalized match used: rawKey="${winner.rawKey}" → "${winner.entry.label}". ` +
        `Consider adding an alias for deterministic resolution.`
      );
    } else if (winner.method === "alias") {
      console.warn(
        `[field-value-resolver] Alias match used: rawKey="${winner.rawKey}" → alias="${winner.aliasUsed}" → "${winner.entry.label}".`
      );
    }

    resolvedValues[cid] = rawValue;
    traces[cid] = {
      rawKey: winner.rawKey,
      canonicalFieldId: cid,
      method: winner.method,
      rawValue,
      normalizedValue,
      ...(winner.aliasUsed !== undefined ? { aliasUsed: winner.aliasUsed } : {}),
    };

    // Every losing candidate becomes explicitly unresolved — never silently dropped
    for (const loser of candidates.slice(1)) {
      const loserRawValue = rawData[loser.rawKey];
      const traceKey = `_unresolved:${loser.rawKey}`;
      traces[traceKey] = {
        rawKey: loser.rawKey,
        canonicalFieldId: cid, // the field it would have mapped to
        method: "unresolved",
        rawValue: loserRawValue,
        normalizedValue: loserRawValue === null || loserRawValue === undefined ? null : String(loserRawValue),
      };
      unresolvedRawKeys.push(loser.rawKey);
    }
  }

  // ── Unmatched raw keys (no catalog entry found at all) ────────────────────
  for (const rawKey of noMatchRawKeys) {
    const rawValue = rawData[rawKey];
    traces[`_unresolved:${rawKey}`] = {
      rawKey,
      canonicalFieldId: rawKey, // placeholder — no canonical target
      method: "unresolved",
      rawValue,
      normalizedValue: rawValue === null || rawValue === undefined ? null : String(rawValue),
    };
  }

  // ── Catalog entries with no raw data match → mark unresolved in traces ────
  //
  // This lets callers distinguish "absent from data" (no key in resolvedValues)
  // from "present but null" (key present, value === null).
  for (const entry of sourceCatalog) {
    const cid = canonicalId(entry);
    if (!traces[cid]) {
      traces[cid] = {
        rawKey: "",
        canonicalFieldId: cid,
        method: "unresolved",
        rawValue: undefined,
        normalizedValue: null,
      };
    }
  }

  return { resolvedValues, traces, unresolvedRawKeys };
}
