import { GoogleGenAI } from "@google/genai";
import {
  buildBusinessFieldSystemPrompt,
  buildBusinessFieldUserPrompt,
  buildBusinessFieldRetryPrompt,
  buildBusinessFieldInsufficientEvidenceRetryPrompt,
  type BusinessFieldMeta,
} from "./prompts/business-field-prompt";
import {
  SECTION_CUSTOMER_PROFILE,
  SECTION_LOAN_DATA,
  SECTION_PAYMENT_DATA,
  SECTION_CONVERSATION_DATA,
  SECTION_BUREAU_DATA,
  SECTION_INCOME_EMPLOYMENT_DATA,
  SECTION_RESOLVED_SOURCE_FIELDS,
  SECTION_PRIOR_BUSINESS_FIELDS,
  SECTION_COMPLIANCE_POLICY_INTERNAL_RULES,
  SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE,
  type ContextSections,
  type ContextDataArray,
} from "./context-sections";

const genAiConfig: any = {
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
};
if (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
  genAiConfig.httpOptions = {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  };
}
const ai = new GoogleGenAI(genAiConfig);

const HISTORY_KEEP_LATEST = 10;

/**
 * Thrown when an individual generateContent call inside callAIForField exceeds
 * the configured per-call timeout. Propagates out of inferBusinessFields so
 * the caller (processCustomer in routes.ts) can count the customer as failed.
 * callWithBackoff in routes.ts will NOT retry this error.
 */
class FieldCallTimeoutError extends Error {
  constructor(fieldLabel: string, ms: number) {
    super(`Business-field AI call timed out after ${ms / 1000}s (field: "${fieldLabel}")`);
    this.name = "FieldCallTimeoutError";
  }
}

const FLAGGED_PAYMENT_PATTERNS = [
  /missed/i,
  /failed/i,
  /returned/i,
  /delinquent/i,
  /arrangement/i,
  /promise/i,
];

const FLAGGED_CONVERSATION_PATTERNS = [
  /hardship/i,
  /vulnerability/i,
  /vulnerable/i,
  /complaint/i,
  /escalat/i,
  /legal/i,
  /compliance/i,
  /refusal/i,
  /refused/i,
  /promise/i,
  /dispute/i,
];

const CANONICAL_EVIDENCE_TYPES = new Set([
  "source_field",
  "business_field",
  "conversation",
  "payment",
  "bureau",
  "income_employment",
  "compliance_rule",
  "knowledge_guidance",
]);

const EVIDENCE_NORMALIZATION_MAP: Record<string, string> = {
  source: "source_field",
  payment_history: "payment",
  conversation_note: "conversation",
  bureau_record: "bureau",
};

function normalizeEvidenceType(raw: string): string | null {
  if (CANONICAL_EVIDENCE_TYPES.has(raw)) return raw;
  if (EVIDENCE_NORMALIZATION_MAP[raw]) return EVIDENCE_NORMALIZATION_MAP[raw];
  return null;
}

function isPaymentFlagged(item: Record<string, unknown>): boolean {
  const combined = JSON.stringify(item).toLowerCase();
  return FLAGGED_PAYMENT_PATTERNS.some(p => p.test(combined));
}

function isConversationFlagged(item: Record<string, unknown>): boolean {
  const combined = JSON.stringify(item).toLowerCase();
  return FLAGGED_CONVERSATION_PATTERNS.some(p => p.test(combined));
}

interface TruncationResult {
  items: ContextDataArray;
  originalCount: number;
  retainedCount: number;
  truncated: boolean;
  summarizationUsed: boolean;
  summaryLine?: string;
}

function truncateHistory(
  items: Record<string, unknown>[],
  isFlagged: (item: Record<string, unknown>) => boolean,
  sectionName: string
): TruncationResult {
  const originalCount = items.length;
  if (originalCount <= HISTORY_KEEP_LATEST) {
    return { items, originalCount, retainedCount: originalCount, truncated: false, summarizationUsed: false };
  }
  const sorted = [...items].sort((a, b) => {
    const aDate = String(a["date_of_payment"] || a["date"] || a["created_at"] || a["timestamp"] || "");
    const bDate = String(b["date_of_payment"] || b["date"] || b["created_at"] || b["timestamp"] || "");
    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;
    return bDate.localeCompare(aDate);
  });
  const latestN = sorted.slice(0, HISTORY_KEEP_LATEST);
  const older = sorted.slice(HISTORY_KEEP_LATEST);
  const flaggedOlder = older.filter(isFlagged);
  const kept = [...latestN, ...flaggedOlder];
  const droppedCount = older.length - flaggedOlder.length;
  if (droppedCount === 0) {
    return { items: kept, originalCount, retainedCount: kept.length, truncated: true, summarizationUsed: false };
  }
  const summaryStr = `[${droppedCount} older ${sectionName} item(s) omitted — not flagged for retention]`;
  const final: ContextDataArray = [...kept, summaryStr];
  return {
    items: final,
    originalCount,
    retainedCount: kept.length,
    truncated: true,
    summarizationUsed: true,
    summaryLine: summaryStr,
  };
}

function validateFieldValue(
  value: unknown,
  allowedValues: string[] | null | undefined
): { valid: boolean; reason?: string } {
  if (value === null || value === undefined) return { valid: true };
  if (typeof value === "object") {
    return { valid: false, reason: "value must be scalar (string, number, boolean), not object/array" };
  }
  if (allowedValues && allowedValues.length > 0) {
    const strVal = String(value);
    if (!allowedValues.includes(strVal)) {
      return { valid: false, reason: `value "${strVal}" not in allowed_values: ${JSON.stringify(allowedValues)}` };
    }
  }
  return { valid: true };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  let str = text.trim();
  const jsonMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) str = jsonMatch[1].trim();
  else {
    const braceMatch = str.match(/\{[\s\S]*\}/);
    if (braceMatch) str = braceMatch[0];
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export interface BusinessFieldEvidenceItem {
  type: string;
  source: string;
  snippet: string;
}

export interface BusinessFieldTrace {
  field_id: string;
  field_label: string;
  value: string | number | boolean | null;
  confidence: number | null;
  rationale: string;
  null_reason: string | null;
  evidence: BusinessFieldEvidenceItem[];
  retry_count: number;
  raw_ai_response: string;
  included_context_sections: string[];
  truncated_sections: string[];
  truncation_metrics: {
    paymentData?: { originalCount: number; retainedCount: number };
    conversationData?: { originalCount: number; retainedCount: number };
  };
  summarization_used: boolean;
}

const STANDARD_NULL_REASONS = new Set([
  "insufficient evidence",
  "schema validation failed after retry",
  "field inference timeout",
  "ai call error",
]);

function normalizeNullReason(aiReason: string | null | undefined): string {
  if (!aiReason) return "insufficient evidence";
  const trimmed = aiReason.trim().toLowerCase();
  if (STANDARD_NULL_REASONS.has(trimmed)) return trimmed;
  return "insufficient evidence";
}

interface SingleFieldResult {
  value: string | number | boolean | null;
  confidence: number | null;
  rationale: string;
  null_reason: string | null;
  evidence: BusinessFieldEvidenceItem[];
  retryCount: number;
  rawAiResponse: string;
}

/**
 * Makes one generateContent call for a single business field.
 * If callTimeoutMs is provided, an AbortController is used to enforce a per-call
 * timeout; on expiry FieldCallTimeoutError is thrown (propagated to fail the customer).
 * 429 / 5xx errors are re-thrown as-is so callWithBackoff in routes.ts can retry.
 */
async function callAIForField(
  field: BusinessFieldMeta,
  context: ContextSections,
  isRetry: boolean,
  previousRawResponse?: string,
  validationError?: string,
  retryPromptOverride?: string,
  callTimeoutMs?: number
): Promise<{ rawText: string; parsed: Record<string, unknown> | null }> {
  const systemPrompt = buildBusinessFieldSystemPrompt();
  let userPrompt = buildBusinessFieldUserPrompt(field, context);
  if (isRetry && retryPromptOverride) {
    userPrompt += "\n\n" + retryPromptOverride;
  } else if (isRetry && validationError) {
    userPrompt += "\n\n" + buildBusinessFieldRetryPrompt(validationError);
  }

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  if (callTimeoutMs && callTimeoutMs > 0) {
    timerId = setTimeout(() => controller.abort(), callTimeoutMs);
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
      config: { maxOutputTokens: 8000 },
      abortSignal: controller.signal,
    });
    const rawText = response.text || "";
    const parsed = tryParseJson(rawText);
    return { rawText, parsed };
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new FieldCallTimeoutError(field.label, callTimeoutMs ?? 0);
    }
    throw err;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

function parseAndNormalizeEvidence(parsed: Record<string, unknown>): BusinessFieldEvidenceItem[] {
  if (!Array.isArray(parsed.evidence)) return [];
  const normalized: BusinessFieldEvidenceItem[] = [];
  for (const item of parsed.evidence) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const rawType = String(obj["type"] || "");
    const canonicalType = normalizeEvidenceType(rawType);
    if (!canonicalType) continue;
    normalized.push({
      type: canonicalType,
      source: String(obj["source"] || ""),
      snippet: String(obj["snippet"] || ""),
    });
  }
  return normalized;
}

// Threshold below which a non-null inference is coerced to null.
// Intentionally low (0.15) so that low-confidence but directional inferences
// (e.g. confidence=0.25, value="Low") are preserved rather than suppressed.
// Only near-zero-confidence values are nullified by this guardrail.
const INSUFFICIENT_EVIDENCE_CONFIDENCE_THRESHOLD = 0.15;

function enforceConfidencePolicy(
  confidence: number | null,
  evidence: BusinessFieldEvidenceItem[],
  value: unknown,
  retryCount: number
): number | null {
  if (confidence === null) return null;
  let c = confidence;
  if (value === null && c > 0.1) c = 0.1;
  if (retryCount > 0 && evidence.length < 2 && c > 0.7) c = 0.7;
  if (c > 0.8 && evidence.length < 2) c = 0.8;
  return c;
}

function applyInsufficientEvidenceNormalization(result: SingleFieldResult): SingleFieldResult {
  if (result.value === null) return result;
  const confidence = result.confidence;
  if (confidence !== null && confidence < INSUFFICIENT_EVIDENCE_CONFIDENCE_THRESHOLD) {
    return {
      ...result,
      value: null,
      null_reason: "insufficient evidence",
      confidence: Math.min(confidence, 0.1),
      rationale: result.rationale,
    };
  }
  return result;
}

function extractFieldResult(
  parsed: Record<string, unknown> | null,
  field: BusinessFieldMeta,
  retryCount: number,
  rawText: string,
  forceNull: boolean,
  forceNullReason?: string
): SingleFieldResult {
  if (forceNull || !parsed) {
    return {
      value: null,
      confidence: null,
      rationale: "",
      null_reason: forceNullReason || "ai call error",
      evidence: [],
      retryCount,
      rawAiResponse: rawText,
    };
  }

  let value: string | number | boolean | null = null;
  if (parsed.value === null || parsed.value === undefined) {
    value = null;
  } else if (typeof parsed.value === "string" || typeof parsed.value === "number" || typeof parsed.value === "boolean") {
    value = parsed.value;
  } else {
    value = null;
  }

  let confidence: number | null = null;
  if (typeof parsed.confidence === "number") {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  } else if (parsed.confidence !== null && parsed.confidence !== undefined) {
    const n = parseFloat(String(parsed.confidence));
    if (!isNaN(n)) confidence = Math.max(0, Math.min(1, n));
  }

  const evidence = parseAndNormalizeEvidence(parsed);
  confidence = enforceConfidencePolicy(confidence, evidence, value, retryCount);

  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  const null_reason = value === null
    ? normalizeNullReason(typeof parsed.null_reason === "string" ? parsed.null_reason : null)
    : null;

  return {
    value,
    confidence,
    rationale,
    null_reason,
    evidence,
    retryCount,
    rawAiResponse: rawText,
  };
}

export async function inferBusinessFields(
  fields: BusinessFieldMeta[],
  context: ContextSections,
  callTimeoutMs?: number
): Promise<BusinessFieldTrace[]> {
  const traces: BusinessFieldTrace[] = [];

  const paymentItems = context[SECTION_PAYMENT_DATA].filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null
  );
  const conversationItems = context[SECTION_CONVERSATION_DATA].filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null
  );

  const paymentTrunc = truncateHistory(paymentItems, isPaymentFlagged, "payment");
  const convTrunc = truncateHistory(conversationItems, isConversationFlagged, "conversation");

  const truncatedContext: ContextSections = {
    ...context,
    [SECTION_PAYMENT_DATA]: paymentTrunc.items,
    [SECTION_CONVERSATION_DATA]: convTrunc.items,
  };

  const truncatedSections: string[] = [];
  if (paymentTrunc.truncated) truncatedSections.push(SECTION_PAYMENT_DATA);
  if (convTrunc.truncated) truncatedSections.push(SECTION_CONVERSATION_DATA);

  const truncationMetrics: BusinessFieldTrace["truncation_metrics"] = {};
  if (paymentTrunc.truncated) {
    truncationMetrics.paymentData = {
      originalCount: paymentTrunc.originalCount,
      retainedCount: paymentTrunc.retainedCount,
    };
  }
  if (convTrunc.truncated) {
    truncationMetrics.conversationData = {
      originalCount: convTrunc.originalCount,
      retainedCount: convTrunc.retainedCount,
    };
  }

  const summarizationUsed = paymentTrunc.summarizationUsed || convTrunc.summarizationUsed;

  const priorBusinessFields: Record<string, unknown> = {};

  for (const field of fields) {
    const fieldContext: ContextSections = {
      ...truncatedContext,
      [SECTION_PRIOR_BUSINESS_FIELDS]: { ...priorBusinessFields },
    };

    const includedContextSections = computeIncludedSections(fieldContext);

    let result: SingleFieldResult;

    try {
      let rawText = "";
      let parsed: Record<string, unknown> | null = null;

      // Each callAIForField call has its own AbortController + configurable timeout
      // (callTimeoutMs). FieldCallTimeoutError propagates out to fail the customer.
      const firstResult = await callAIForField(field, fieldContext, false,
        undefined, undefined, undefined, callTimeoutMs);

      rawText = firstResult.rawText;
      parsed = firstResult.parsed;

      const validation = validateAfterParse(parsed, field.allowedValues);

      if (!validation.valid) {
        const retryResult = await callAIForField(field, fieldContext, true,
          rawText, validation.reason, undefined, callTimeoutMs);

        rawText = retryResult.rawText;
        parsed = retryResult.parsed;

        const retryValidation = validateAfterParse(parsed, field.allowedValues);
        if (!retryValidation.valid) {
          result = {
            value: null,
            confidence: null,
            rationale: "",
            null_reason: "schema validation failed after retry",
            evidence: [],
            retryCount: 1,
            rawAiResponse: rawText,
          };
        } else {
          result = applyInsufficientEvidenceNormalization(extractFieldResult(parsed, field, 1, rawText, false));
        }
      } else {
        // First response is schema-valid. If it returned null with null_reason "insufficient
        // evidence", fire one generic evidence retry asking the model to reconsider partial
        // signals. This path is separate from the schema-repair retry above and does not
        // combine with it — whichever retry fires first is the only retry for that field.
        const firstExtracted = extractFieldResult(parsed, field, 0, rawText, false);
        const isInsufficientEvidence =
          firstExtracted.value === null &&
          firstExtracted.null_reason === "insufficient evidence";

        if (isInsufficientEvidence) {
          const evRetryResult = await callAIForField(
            field, fieldContext, true, rawText, undefined,
            buildBusinessFieldInsufficientEvidenceRetryPrompt(), callTimeoutMs
          );

          rawText = evRetryResult.rawText;
          parsed = evRetryResult.parsed;

          const evRetryValidation = validateAfterParse(parsed, field.allowedValues);
          if (!evRetryValidation.valid) {
            // Evidence retry produced an invalid schema — preserve the original null result.
            result = applyInsufficientEvidenceNormalization(firstExtracted);
          } else {
            result = applyInsufficientEvidenceNormalization(extractFieldResult(parsed, field, 1, rawText, false));
          }
        } else {
          result = applyInsufficientEvidenceNormalization(firstExtracted);
        }
      }
    } catch (err: unknown) {
      // FieldCallTimeoutError: individual generateContent call exceeded per-call timeout.
      // Propagate so processCustomer counts this customer as failed.
      if (err instanceof FieldCallTimeoutError) {
        console.warn(`[business-field-engine] ${err.message}`);
        throw err;
      }
      // Retryable HTTP errors (429, 5xx, RESOURCE_EXHAUSTED): propagate so
      // callWithBackoff in routes.ts can retry the entire inferBusinessFields invocation.
      const anyErr = err as Record<string, unknown>;
      const status = anyErr?.["status"] ?? anyErr?.["statusCode"] ?? anyErr?.["code"];
      const isRetryable =
        status === 429 ||
        status === "RESOURCE_EXHAUSTED" ||
        (typeof status === "number" && status >= 500);
      if (isRetryable) {
        console.warn(`[business-field-engine] Retryable error (${String(status)}) on field "${field.label}" — propagating for retry`);
        throw err;
      }
      // Non-retryable, non-timeout: degrade this field to null so other fields can proceed.
      console.error(`[business-field-engine] Error inferring field "${field.label}":`, err);
      result = {
        value: null,
        confidence: null,
        rationale: "",
        null_reason: "ai call error",
        evidence: [],
        retryCount: 0,
        rawAiResponse: "",
      };
    }

    if (result.value !== null && result.value !== undefined) {
      priorBusinessFields[field.label] = result.value;
    }

    traces.push(buildTrace(field, result, includedContextSections, truncatedSections, truncationMetrics, summarizationUsed));
  }

  return traces;
}

function validateAfterParse(
  parsed: Record<string, unknown> | null,
  allowedValues: string[] | null | undefined
): { valid: boolean; reason?: string } {
  if (!parsed) return { valid: false, reason: "could not parse JSON response" };
  if (!("value" in parsed)) return { valid: false, reason: "missing required key: value" };
  return validateFieldValue(parsed.value, allowedValues);
}

function computeIncludedSections(context: ContextSections): string[] {
  const included: string[] = [];
  const checks: [string, unknown][] = [
    [SECTION_CUSTOMER_PROFILE, context.customerProfile],
    [SECTION_LOAN_DATA, context.loanData],
    [SECTION_PAYMENT_DATA, context.paymentData],
    [SECTION_CONVERSATION_DATA, context.conversationData],
    [SECTION_BUREAU_DATA, context.bureauData],
    [SECTION_INCOME_EMPLOYMENT_DATA, context.incomeEmploymentData],
    [SECTION_RESOLVED_SOURCE_FIELDS, context.resolvedSourceFields],
    [SECTION_PRIOR_BUSINESS_FIELDS, context.priorBusinessFields],
    [SECTION_COMPLIANCE_POLICY_INTERNAL_RULES, context.compliancePolicyInternalRules],
    [SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE, context.knowledgeBaseAgentGuidance],
  ];
  for (const [name, value] of checks) {
    if (isNonEmpty(value)) included.push(name);
  }
  return included;
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

function buildTrace(
  field: BusinessFieldMeta,
  result: SingleFieldResult,
  includedContextSections: string[],
  truncatedSections: string[],
  truncationMetrics: BusinessFieldTrace["truncation_metrics"],
  summarizationUsed: boolean
): BusinessFieldTrace {
  return {
    field_id: field.id,
    field_label: field.label,
    value: result.value,
    confidence: result.confidence,
    rationale: result.rationale,
    null_reason: result.null_reason,
    evidence: result.evidence,
    retry_count: result.retryCount,
    raw_ai_response: result.rawAiResponse.substring(0, 2000),
    included_context_sections: includedContextSections,
    truncated_sections: truncatedSections,
    truncation_metrics: truncationMetrics,
    summarization_used: summarizationUsed,
  };
}
