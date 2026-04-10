import { geminiClient } from "../../ai-engine";
import type { CatalogEntry } from "../../field-catalog";
import type { TreatmentWithRules } from "@shared/schema";
import type {
  BusinessFieldTier,
  BusinessFieldTrace,
  BusinessFieldResult,
  StageMetrics,
} from "./types";
import {
  buildBusinessFieldSystemPrompt,
  buildBusinessFieldUserPrompt,
  buildRetryUserPrompt,
  type CustomerContextSections,
} from "./prompts/business-field-prompt";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface BusinessFieldInferenceConfig {
  /** Maximum number of business field inference calls per customer run. Default: 15. */
  maxBusinessFieldsPerRun?: number;
  /** Per-field timeout in milliseconds. Default: 15 000. */
  perFieldTimeoutMs?: number;
  /** Total stage budget in milliseconds. Default: 120 000. */
  totalBudgetMs?: number;
  /** When true, tier-4 optional/enrichment fields are inferred. Default: false. */
  inferTier4Fields?: boolean;
}

const DEFAULT_CONFIG: Required<BusinessFieldInferenceConfig> = {
  maxBusinessFieldsPerRun: 15,
  perFieldTimeoutMs: 15_000,
  totalBudgetMs: 120_000,
  inferTier4Fields: false,
};

// ─── Rule type tier mapping ───────────────────────────────────────────────────

const HARD_BLOCKER_TYPES = new Set(["hard_blocker"]);
const ESCALATION_TYPES = new Set(["escalation", "review_trigger", "soft_blocker"]);
const ELIGIBILITY_TYPES = new Set(["eligibility"]);
// Guardrail-referenced fields are included but assigned to tier 4 (non-blocking,
// so they don't elevate to required tiers but are still inferred).
// (kept for future use as an explicit guardrail type check if needed)
const _GUARDRAIL_TYPES = new Set(["guardrail"]); void _GUARDRAIL_TYPES;

function ruleTypeTier(ruleType: string): BusinessFieldTier {
  const lower = ruleType.toLowerCase();
  if (HARD_BLOCKER_TYPES.has(lower)) return 1;
  if (ESCALATION_TYPES.has(lower)) return 2;
  if (ELIGIBILITY_TYPES.has(lower)) return 3;
  // guardrail and any unknown rule type → tier 4 (included but lowest priority)
  return 4;
}

// ─── Required field selector ──────────────────────────────────────────────────

interface OrderedBusinessField {
  fieldId: string;
  catalogEntry: CatalogEntry;
  tier: BusinessFieldTier;
  dependencyPosition: number;
}

/**
 * Inspect treatment rule groups to find which business fields are referenced,
 * then sort them into tiers (1=hard_blocker, 2=escalation, 3=eligibility, 4=optional).
 * Within each tier, respects depends_on_business_fields ordering.
 *
 * Tier-4 fields are only included when inferTier4Fields = true OR they are
 * explicitly referenced by a required tier-1–3 field.
 */
export function getRequiredBusinessFieldsForCustomer(
  treatments: TreatmentWithRules[],
  businessFieldCatalog: CatalogEntry[],
  inferTier4Fields = false
): OrderedBusinessField[] {
  // Index catalog by ID for fast lookup
  const catalogById = new Map<string, CatalogEntry>();
  const businessFieldIds = new Set<string>();
  for (const entry of businessFieldCatalog) {
    if (entry.sourceType === "business_field" && entry.id) {
      catalogById.set(entry.id, entry);
      businessFieldIds.add(entry.id);
    }
  }

  if (catalogById.size === 0) return [];

  // Map: fieldId → best tier seen (lower number = higher priority)
  const fieldBestTier = new Map<string, BusinessFieldTier>();

  // Helper: register a candidate field at the most critical tier seen
  function registerField(fieldId: string | null | undefined, tier: BusinessFieldTier) {
    if (!fieldId || !businessFieldIds.has(fieldId)) return;
    const current = fieldBestTier.get(fieldId);
    if (current === undefined || tier < current) {
      fieldBestTier.set(fieldId, tier);
    }
  }

  for (const treatment of treatments) {
    if (!treatment.enabled) continue;
    for (const group of treatment.ruleGroups ?? []) {
      // All rule group types are inspected — guardrail → tier 4, others as appropriate.
      // This ensures we never miss a business field referenced anywhere in the policy.
      const tier = ruleTypeTier(group.ruleType ?? "");
      for (const rule of group.rules ?? []) {
        // leftFieldId: LHS of comparison (most common path)
        registerField(rule.leftFieldId, tier);
        // rightFieldId: RHS in field-vs-field comparisons — also a potential business field reference
        if (rule.rightMode === "field") {
          registerField(rule.rightFieldId, tier);
        }
      }
    }
  }

  // Tier-4 via feature flag: all remaining catalog business fields
  if (inferTier4Fields) {
    for (const fieldId of Array.from(businessFieldIds)) {
      if (!fieldBestTier.has(fieldId)) {
        fieldBestTier.set(fieldId, 4);
      }
    }
  }

  // Tier-4 via transitive dependency: if a required tier 1–3 field declares
  // depends_on_business_fields, those dependencies are also inferred (as tier 4)
  // even when inferTier4Fields = false.
  //
  // NOTE: This traversal works with real data once buildFullFieldCatalog is updated to
  // populate CatalogEntry.dependsOnBusinessFields from persisted policy field metadata.
  // Until that DB schema extension lands, dependsOnBusinessFields will be null and this
  // traversal is a no-op (no ordering constraint, no extra fields added). The logic itself
  // is already correct and future-safe.
  {
    const visited = new Set<string>();

    function expandDependencies(fieldId: string) {
      if (visited.has(fieldId)) return;
      visited.add(fieldId);
      const entry = catalogById.get(fieldId);
      for (const depId of entry?.dependsOnBusinessFields ?? []) {
        if (!catalogById.has(depId)) continue;
        if (!fieldBestTier.has(depId)) {
          // Not in any required tier yet — add as tier 4 (dependency of a required field)
          fieldBestTier.set(depId, 4);
        }
        expandDependencies(depId);
      }
    }

    // Seed from all currently known required fields (tier 1–3)
    for (const [fieldId, tier] of Array.from(fieldBestTier.entries())) {
      if (tier <= 3) {
        expandDependencies(fieldId);
      }
    }
  }

  if (fieldBestTier.size === 0) return [];

  // Strict tier-first ordering (1→2→3→4) with per-tier topological sort.
  //
  // Tier determines both inference priority and AGENT_REVIEW routing.
  // depends_on_business_fields ordering is respected WITHIN each tier only, per spec.
  // A tier-4 dependency of a tier-1 field is included at tier 4 (after all required tiers).
  const tierBuckets: Map<BusinessFieldTier, string[]> = new Map([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);

  for (const [fieldId, tier] of Array.from(fieldBestTier.entries())) {
    tierBuckets.get(tier)!.push(fieldId);
  }

  const result: OrderedBusinessField[] = [];
  let position = 0;

  for (const tier of [1, 2, 3, 4] as BusinessFieldTier[]) {
    const tierFields = tierBuckets.get(tier)!;
    if (tierFields.length === 0) continue;
    const sorted = perTierTopologicalSort(tierFields, catalogById);
    for (const fieldId of sorted) {
      const entry = catalogById.get(fieldId);
      if (!entry) continue;
      result.push({ fieldId, catalogEntry: entry, tier, dependencyPosition: position++ });
    }
  }

  return result;
}

/**
 * Topological sort of business field IDs within a single tier.
 * Respects depends_on_business_fields among fields in the same tier only.
 * Falls back to alphabetical order when no dependency info is available
 * or when dependencies span tiers (cross-tier deps are not intra-tier constraints).
 */
function perTierTopologicalSort(fieldIds: string[], catalog: Map<string, CatalogEntry>): string[] {
  const idSet = new Set(fieldIds);
  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle detection
  const ordered: string[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      console.warn(`[business-field-engine] Dependency cycle at "${id}" — skipping`);
      return;
    }
    visiting.add(id);
    const entry = catalog.get(id);
    const deps = entry?.dependsOnBusinessFields ?? [];
    for (const depId of deps) {
      // Only follow deps that are also in this tier's bucket
      if (idSet.has(depId)) visit(depId);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  // Alphabetical for deterministic output
  const sortedIds = [...fieldIds].sort();
  for (const id of sortedIds) {
    visit(id);
  }

  return ordered;
}


// ─── Context assembly ─────────────────────────────────────────────────────────

// Payment / conversation summary thresholds before truncation
const MAX_PAYMENT_ITEMS = 5;
const MAX_CONVERSATION_ITEMS = 3;

/**
 * Categorise source resolved values into the 7 labelled sections used in prompts.
 * Derived and business field values are passed separately.
 */
export function assembleCustomerContext(
  resolvedValues: Record<string, unknown>,
  rawCustomerData: Record<string, unknown> = {},
  derivedFieldValues: Record<string, unknown> = {},
  priorBusinessFieldValues: Record<string, unknown> = {}
): CustomerContextSections {
  const truncationWarnings: string[] = [];

  // ── Categorise source fields heuristically ──────────────────────────────
  const customerProfile: Record<string, unknown> = {};
  const loanData: Record<string, unknown> = {};
  const bureauData: Record<string, unknown> = {};

  const profileKeywords = [
    "name", "email", "phone", "address", "dob", "date_of_birth", "age",
    "gender", "nationality", "country", "city", "postcode", "zip",
    "customer_guid", "customer_id", "account_id", "client_id",
    "first_name", "last_name", "full_name",
  ];
  const bureauKeywords = [
    "credit_score", "bureau", "credit_report", "credit_rating", "fico",
    "equifax", "experian", "transunion", "default_count", "ccj",
    "derogatory", "public_record", "bankruptcy",
  ];

  for (const [rawKey, value] of Object.entries(resolvedValues)) {
    // Skip trace/system keys
    if (rawKey.startsWith("_")) continue;
    if (value === null || value === undefined) continue;

    const normalKey = rawKey.replace(/^source:/, "").toLowerCase().replace(/[\s-]/g, "_");

    if (profileKeywords.some(k => normalKey === k || normalKey.startsWith(k + "_") || normalKey.endsWith("_" + k))) {
      customerProfile[normalKey] = value;
    } else if (bureauKeywords.some(k => normalKey.includes(k))) {
      bureauData[normalKey] = value;
    } else {
      loanData[normalKey] = value;
    }
  }

  // ── Payment history from raw customer data ──────────────────────────────
  let paymentData: unknown[] = [];
  const rawPayments = rawCustomerData._payments ?? rawCustomerData.payments;
  if (Array.isArray(rawPayments)) {
    if (rawPayments.length > MAX_PAYMENT_ITEMS) {
      const sorted = [...rawPayments].sort((a, b) => {
        const da = new Date((a as Record<string, unknown>).date_of_payment as string || 0).getTime();
        const db = new Date((b as Record<string, unknown>).date_of_payment as string || 0).getTime();
        return db - da; // most recent first
      });
      paymentData = sorted.slice(0, MAX_PAYMENT_ITEMS);
      truncationWarnings.push(
        `paymentData truncated: showing ${MAX_PAYMENT_ITEMS} most recent of ${rawPayments.length} total payments`
      );
    } else {
      paymentData = rawPayments;
    }
  }

  // ── Conversation history from raw customer data ─────────────────────────
  let conversationData: unknown[] = [];
  const rawConversations = rawCustomerData._conversations ?? rawCustomerData.conversations;
  if (Array.isArray(rawConversations)) {
    if (rawConversations.length > MAX_CONVERSATION_ITEMS) {
      const sorted = [...rawConversations].sort((a, b) => {
        const da = new Date((a as Record<string, unknown>).date as string || 0).getTime();
        const db = new Date((b as Record<string, unknown>).date as string || 0).getTime();
        return db - da; // most recent first
      });
      conversationData = sorted.slice(0, MAX_CONVERSATION_ITEMS);
      truncationWarnings.push(
        `conversationData truncated: showing ${MAX_CONVERSATION_ITEMS} most recent of ${rawConversations.length} total entries`
      );
    } else {
      conversationData = rawConversations;
    }
  }

  // ── Derived field values ────────────────────────────────────────────────
  const derivedFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(derivedFieldValues)) {
    if (v !== null && v !== undefined) derivedFields[k] = v;
  }

  // ── Prior business field values ─────────────────────────────────────────
  const priorBusinessFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(priorBusinessFieldValues)) {
    if (v !== null && v !== undefined) priorBusinessFields[k] = v;
  }

  return {
    customerProfile,
    loanData,
    paymentData,
    conversationData,
    bureauData,
    derivedFields,
    priorBusinessFields,
    truncationWarnings,
  };
}

// ─── Model response schema / validation ──────────────────────────────────────

interface RawModelResponse {
  field_id: string;
  field_label: string;
  value: unknown;
  confidence: number | null;
  rationale: string | null;
  null_reason: string | null;
  evidence: string[];
}

/**
 * Parse and validate the model JSON response against the required schema.
 * Returns the parsed object on success, or a string error message on failure.
 */
function validateModelResponse(
  rawText: string,
  field: CatalogEntry
): { ok: true; data: RawModelResponse } | { ok: false; error: string } {
  let parsed: Record<string, unknown>;
  try {
    let jsonStr = rawText.trim();
    // Strip markdown code fences if the model disobeyed instructions
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    // Find the outermost JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  // Required keys
  const required = ["value", "confidence", "rationale", "null_reason", "evidence"];
  for (const key of required) {
    if (!(key in parsed)) {
      return { ok: false, error: `Missing required key: "${key}"` };
    }
  }

  // evidence must be an array
  if (!Array.isArray(parsed.evidence)) {
    return { ok: false, error: `"evidence" must be an array` };
  }

  // confidence must be null or a number 0–1
  if (parsed.confidence !== null && typeof parsed.confidence !== "number") {
    return { ok: false, error: `"confidence" must be a number between 0 and 1 or null` };
  }
  if (typeof parsed.confidence === "number" && (parsed.confidence < 0 || parsed.confidence > 1)) {
    return { ok: false, error: `"confidence" must be between 0.0 and 1.0, got ${parsed.confidence}` };
  }

  // If allowed_values provided, value must be one of them or null
  if (
    parsed.value !== null &&
    field.allowedValues &&
    field.allowedValues.length > 0
  ) {
    const strVal = String(parsed.value);
    if (!field.allowedValues.includes(strVal)) {
      return {
        ok: false,
        error: `"value" must be one of [${field.allowedValues.join(", ")}] or null, got "${strVal}"`,
      };
    }
  }

  return {
    ok: true,
    data: {
      field_id: String(parsed.field_id ?? field.id ?? field.label),
      field_label: String(parsed.field_label ?? field.label),
      value: parsed.value,
      confidence: parsed.confidence as number | null,
      rationale: parsed.rationale != null ? String(parsed.rationale) : null,
      null_reason: parsed.null_reason != null ? String(parsed.null_reason) : null,
      evidence: (parsed.evidence as unknown[]).map(String),
    },
  };
}

// ─── Confidence normalization ─────────────────────────────────────────────────

interface ConfidenceNormResult {
  confidence: number | null;
  warning?: string;
}

function normalizeConfidence(
  rawConfidence: number | null,
  value: unknown,
  evidence: string[]
): ConfidenceNormResult {
  let conf = rawConfidence;

  // Null value → confidence must be ≤ 0.1 or null
  if (value === null || value === undefined) {
    if (conf !== null && conf > 0.1) {
      conf = 0.1;
    }
    return { confidence: conf };
  }

  // Clamp to [0, 1]
  if (conf !== null) {
    conf = Math.max(0, Math.min(1, conf));
  }

  // High confidence with single weak evidence → warning
  let warning: string | undefined;
  if (conf !== null && conf > 0.8 && evidence.length <= 1) {
    warning =
      "High confidence (>0.8) assigned with only a single evidence item — consider whether confidence is overstated";
  }

  return { confidence: conf, warning };
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[timeout] ${label} exceeded ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// ─── Single-field inference ───────────────────────────────────────────────────

interface SingleFieldResult {
  value: unknown;
  confidence: number | null;
  rationale: string | null;
  nullReason: string | null;
  evidence: string[];
  retryCount: number;
  rawAiResponse: string | null;
  highConfidenceSingleEvidenceWarning?: boolean;
}

async function inferSingleBusinessField(
  field: CatalogEntry,
  context: CustomerContextSections,
  perFieldTimeoutMs: number
): Promise<SingleFieldResult> {
  const systemPrompt = buildBusinessFieldSystemPrompt();
  const userPrompt = buildBusinessFieldUserPrompt(field, context);

  let rawText: string | null = null;
  let retryCount = 0;
  let lastValidationError = "";

  const callModel = async (prompt: string): Promise<string> => {
    const response = await geminiClient.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Understood. I will infer exactly one business field and return valid JSON only." }] },
        { role: "user", parts: [{ text: prompt }] },
      ],
      config: { maxOutputTokens: 2000 },
    });
    return response.text ?? "";
  };

  // ── Attempt 1 ────────────────────────────────────────────────────────────
  try {
    rawText = await withTimeout(callModel(userPrompt), perFieldTimeoutMs, `field ${field.id}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("[timeout]")) {
      throw new Error(`[field_timeout] ${msg}`);
    }
    throw err;
  }

  const attempt1 = validateModelResponse(rawText, field);

  if (attempt1.ok) {
    const { confidence, warning } = normalizeConfidence(
      attempt1.data.confidence,
      attempt1.data.value,
      attempt1.data.evidence
    );
    return {
      value: attempt1.data.value,
      confidence,
      rationale: attempt1.data.rationale,
      nullReason: attempt1.data.null_reason,
      evidence: attempt1.data.evidence,
      retryCount: 0,
      rawAiResponse: rawText,
      highConfidenceSingleEvidenceWarning: warning !== undefined ? true : undefined,
    };
  }

  // ── Retry (schema/format failure only) ───────────────────────────────────
  lastValidationError = attempt1.error;
  retryCount = 1;
  const retryPrompt = buildRetryUserPrompt(field, context, lastValidationError);

  let rawText2: string | null = null;
  try {
    rawText2 = await withTimeout(callModel(retryPrompt), perFieldTimeoutMs, `field ${field.id} retry`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("[timeout]")) {
      throw new Error(`[field_timeout] ${msg}`);
    }
    throw err;
  }

  const attempt2 = validateModelResponse(rawText2, field);

  if (attempt2.ok) {
    const { confidence, warning } = normalizeConfidence(
      attempt2.data.confidence,
      attempt2.data.value,
      attempt2.data.evidence
    );
    return {
      value: attempt2.data.value,
      confidence,
      rationale: attempt2.data.rationale,
      nullReason: attempt2.data.null_reason,
      evidence: attempt2.data.evidence,
      retryCount: 1,
      rawAiResponse: rawText2,
      highConfidenceSingleEvidenceWarning: warning !== undefined ? true : undefined,
    };
  }

  // ── Both attempts failed → null fallback ─────────────────────────────────
  return {
    value: null,
    confidence: null,
    rationale: null,
    nullReason: "model output invalid after retry",
    evidence: [],
    retryCount: 1,
    rawAiResponse: rawText2,
  };
}

// ─── Main orchestration ───────────────────────────────────────────────────────

/**
 * Infer all required business fields for a customer in the order determined
 * by getRequiredBusinessFieldsForCustomer(). Handles per-field timeouts,
 * total budget enforcement, the cap, and AGENT_REVIEW routing.
 */
export async function inferBusinessFields(
  treatments: TreatmentWithRules[],
  businessFieldCatalog: CatalogEntry[],
  resolvedValues: Record<string, unknown>,
  rawCustomerData: Record<string, unknown> = {},
  derivedFieldValues: Record<string, unknown> = {},
  config: BusinessFieldInferenceConfig = {}
): Promise<BusinessFieldResult> {
  const cfg: Required<BusinessFieldInferenceConfig> = { ...DEFAULT_CONFIG, ...config };
  const startMs = Date.now();
  const startedAt = new Date().toISOString();

  const orderedFields = getRequiredBusinessFieldsForCustomer(
    treatments,
    businessFieldCatalog,
    cfg.inferTier4Fields
  );

  const values: Record<string, unknown> = {};
  const traces: Record<string, BusinessFieldTrace> = {};
  let requires_agent_review = false;
  let agentReviewReason: string | undefined;
  let tier4Skipped = false;
  let capWarning: string | undefined;

  const counts = {
    total: orderedFields.length,
    inferred: 0,
    null: 0,
    failed: 0,
    retried: 0,
    timedOut: 0,
  };

  // ── Cap enforcement ───────────────────────────────────────────────────────
  const requiredFields = orderedFields.filter(f => f.tier <= 3);
  const tier4Fields = orderedFields.filter(f => f.tier === 4);

  let fieldsToInfer: typeof orderedFields;

  if (orderedFields.length > cfg.maxBusinessFieldsPerRun) {
    if (requiredFields.length <= cfg.maxBusinessFieldsPerRun) {
      // Cap only affects tier-4 → skip tier-4, continue normally
      fieldsToInfer = requiredFields;
      tier4Skipped = true;
      capWarning =
        `Business field cap (${cfg.maxBusinessFieldsPerRun}) reached: ` +
        `tier-4 optional fields skipped (${tier4Fields.length} omitted). ` +
        `Required tier 1–3 fields (${requiredFields.length}) will be inferred.`;
      console.warn(`[business-field-engine] ${capWarning}`);
    } else {
      // Cap prevents required tier 1–3 fields from all being inferred
      fieldsToInfer = requiredFields.slice(0, cfg.maxBusinessFieldsPerRun);
      tier4Skipped = true;
      requires_agent_review = true;
      agentReviewReason =
        `Business field cap (${cfg.maxBusinessFieldsPerRun}) reached before all required ` +
        `tier 1–3 fields could be inferred. Inferred ${fieldsToInfer.length} of ` +
        `${requiredFields.length} required fields. Manual review required.`;
      capWarning = agentReviewReason;
      console.warn(`[business-field-engine] ${agentReviewReason}`);
    }
  } else {
    fieldsToInfer = orderedFields;
  }

  // ── Per-field inference loop ──────────────────────────────────────────────
  let priorBusinessFieldValues: Record<string, unknown> = {};

  for (const orderedField of fieldsToInfer) {
    const { fieldId, catalogEntry, tier, dependencyPosition } = orderedField;
    const fieldLabel = catalogEntry.label;

    // Check total budget
    const elapsed = Date.now() - startMs;
    if (elapsed >= cfg.totalBudgetMs) {
      const remainingFields = fieldsToInfer.slice(fieldsToInfer.indexOf(orderedField));
      // Escalate if ANY remaining uninferred field is required (tier 1–3),
      // not just the current field. Covers the case where budget is exhausted
      // mid-tier-4 while tier-1/2/3 fields are still pending.
      const hasRemainingRequired = remainingFields.some(f => f.tier <= 3);
      const timeoutMsg =
        `Total business field stage budget (${cfg.totalBudgetMs}ms) exhausted ` +
        `after ${elapsed}ms. Remaining fields stored as null.`;
      console.warn(`[business-field-engine] ${timeoutMsg}`);
      if (hasRemainingRequired && !requires_agent_review) {
        requires_agent_review = true;
        const remainingRequiredIds = remainingFields.filter(f => f.tier <= 3).map(f => f.fieldId).join(", ");
        agentReviewReason = `Stage budget exhausted before all required tier 1–3 fields could be inferred. ` +
          `Remaining required fields: [${remainingRequiredIds}]. ${timeoutMsg}`;
      }

      // Store null for all remaining fields
      for (const remaining of remainingFields) {
        traces[remaining.fieldId] = {
          fieldId: remaining.fieldId,
          fieldLabel: remaining.catalogEntry.label,
          tier: remaining.tier,
          dependencyPosition: remaining.dependencyPosition,
          value: null,
          confidence: null,
          rationale: null,
          nullReason: "stage budget exhausted",
          evidence: [],
          retryCount: 0,
          priorBusinessFieldsReferenced: false,
          rawAiResponse: null,
          durationMs: 0,
        };
        values[remaining.fieldId] = null;
        counts.null++;
      }
      break;
    }

    const hasPrior = Object.keys(priorBusinessFieldValues).length > 0;
    const context = assembleCustomerContext(
      resolvedValues,
      rawCustomerData,
      derivedFieldValues,
      priorBusinessFieldValues
    );

    const fieldStartMs = Date.now();
    let fieldTrace: BusinessFieldTrace;

    try {
      const inferResult = await inferSingleBusinessField(
        catalogEntry,
        context,
        cfg.perFieldTimeoutMs
      );

      const fieldDurationMs = Date.now() - fieldStartMs;

      if (inferResult.retryCount > 0) counts.retried++;
      if (inferResult.value === null) {
        counts.null++;
      } else {
        counts.inferred++;
      }

      fieldTrace = {
        fieldId,
        fieldLabel,
        tier,
        dependencyPosition,
        value: inferResult.value,
        confidence: inferResult.confidence,
        rationale: inferResult.rationale,
        nullReason: inferResult.nullReason ?? null,
        evidence: inferResult.evidence,
        retryCount: inferResult.retryCount,
        priorBusinessFieldsReferenced: hasPrior,
        rawAiResponse: inferResult.rawAiResponse,
        durationMs: fieldDurationMs,
        truncationWarning:
          context.truncationWarnings.length > 0
            ? context.truncationWarnings.join("; ")
            : undefined,
        highConfidenceSingleEvidenceWarning:
          inferResult.highConfidenceSingleEvidenceWarning,
      };

      values[fieldId] = inferResult.value;
    } catch (err) {
      const msg = (err as Error).message;
      const fieldDurationMs = Date.now() - fieldStartMs;
      const isTimeout = msg.startsWith("[field_timeout]");
      const isCritical = tier <= 3;

      if (isTimeout) {
        counts.timedOut++;
        counts.null++;
        console.warn(
          `[business-field-engine] Field "${fieldId}" timed out (${fieldDurationMs}ms). ` +
          `Critical=${isCritical}. Stored null.`
        );
        if (isCritical && !requires_agent_review) {
          requires_agent_review = true;
          agentReviewReason =
            `required tier ${tier} business field timed out: ${fieldId}`;
        }
        fieldTrace = {
          fieldId,
          fieldLabel,
          tier,
          dependencyPosition,
          value: null,
          confidence: null,
          rationale: null,
          nullReason: "field inference timeout",
          evidence: [],
          retryCount: 0,
          priorBusinessFieldsReferenced: hasPrior,
          rawAiResponse: null,
          durationMs: fieldDurationMs,
        };
        values[fieldId] = null;
      } else {
        counts.failed++;
        counts.null++;
        console.error(`[business-field-engine] Field "${fieldId}" failed: ${msg}`);
        fieldTrace = {
          fieldId,
          fieldLabel,
          tier,
          dependencyPosition,
          value: null,
          confidence: null,
          rationale: null,
          nullReason: `inference error: ${msg}`,
          evidence: [],
          retryCount: 0,
          priorBusinessFieldsReferenced: hasPrior,
          rawAiResponse: null,
          durationMs: fieldDurationMs,
        };
        values[fieldId] = null;
      }
    }

    traces[fieldId] = fieldTrace;

    // Accumulate non-null inferred values for the next field's context
    if (values[fieldId] !== null) {
      priorBusinessFieldValues = {
        ...priorBusinessFieldValues,
        [fieldLabel]: values[fieldId],
      };
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const stageMetrics: StageMetrics = {
    startedAt,
    completedAt,
    durationMs,
    counts: {
      totalFields: counts.total,
      fieldsInferred: counts.inferred,
      fieldsNull: counts.null,
      fieldsFailed: counts.failed,
      fieldsRetried: counts.retried,
      fieldsTimedOut: counts.timedOut,
      fieldsScheduled: fieldsToInfer.length,
    },
  };

  return {
    values,
    traces,
    requires_agent_review,
    ...(agentReviewReason ? { agentReviewReason } : {}),
    tier4Skipped,
    ...(capWarning ? { capWarning } : {}),
    stageMetrics,
  };
}
