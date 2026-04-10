import type {
  FieldResolutionResult,
} from "./field-value-resolver";
import type {
  DerivedFieldResult,
  BusinessFieldResult,
  RuleEvaluationResult,
  StageMetrics,
  TreatmentSelectionTraceEntry,
  RankedTreatment,
} from "./types";
import type { PolicyPack, TreatmentWithRules } from "@shared/schema";

// ─── Communication types ───────────────────────────────────────────────────────

export interface CommunicationGuidelines {
  communicationGuidelines: string[];
  emailGuidelines: string[];
  emailWhenToUse: string[];
  emailWhenNotToUse: string[];
  toneGuidance: string[];
}

export type CommunicationSource = "policy_config" | "default_empty";

export interface CommunicationSection {
  guidelines: CommunicationGuidelines;
  communicationSource: CommunicationSource;
}

// ─── Decision Basis Summary ───────────────────────────────────────────────────

export interface DecisionBasisSummary {
  sourceFieldCount: number;
  sourceFieldNullCount: number;
  derivedComputed: number;
  derivedNull: number;
  derivedError: number;
  derivedSkipped: number;
  businessInferred: number;
  businessNull: number;
  businessFailed: number;
  eligibleTreatmentCount: number;
  blockedTreatmentCount: number;
  preferredTreatmentCount: number;
  missingCriticalInfoCount: number;
}

// ─── Field Availability Summary ──────────────────────────────────────────────

export interface FieldAvailabilitySummary {
  hasLoanData: boolean;
  hasPaymentData: boolean;
  hasConversationData: boolean;
  hasBureauData: boolean;
  sourceFieldCounts: Record<string, number>;
}

// ─── Full Decision Packet ─────────────────────────────────────────────────────

export interface DecisionPacket {
  runId: string;
  engineVersion: string;
  policyVersion: string;
  timestamp: string;

  // Customer identity (fixed top-level fields per spec)
  customer_guid: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  days_past_due: number | null;
  amount_due: number | null;
  minimum_due: number | null;
  additional_customer_context: Record<string, string | number | null>;

  // Treatment context
  rankedEligibleTreatments: RankedTreatment[];
  preferredTreatments: RankedTreatment[];
  blockedTreatments: Array<{ code: string; name: string; blockerType: string; reasons: string[] }>;
  escalationFlags: Array<{ type: string; description: string }>;
  guardrailFlags: Array<{ type: string; description: string }>;
  reviewTriggers: Array<{ type: string; description: string; fieldId?: string }>;
  missingCriticalInformation: Array<{ fieldId: string; label: string; requiredBy: string }>;

  // Resolved data context (for the AI prompt)
  sourceFields: Record<string, unknown>;
  derivedFields: Record<string, unknown>;
  businessFields: Record<string, unknown>;

  // Communication guidelines
  communication: CommunicationSection;

  // Summaries
  decisionBasisSummary: DecisionBasisSummary;
  fieldAvailabilitySummary: FieldAvailabilitySummary;

  // Payment / conversation data (for context in final prompt)
  rawPaymentData: unknown[];
  rawConversationData: unknown[];
}

// ─── Builder ──────────────────────────────────────────────────────────────────

interface BuildDecisionPacketArgs {
  runId: string;
  policyPack: PolicyPack | null;
  rawCustomerData: Record<string, unknown>;
  fieldResolution: FieldResolutionResult;
  derivedFieldResult: DerivedFieldResult;
  businessFieldResult: BusinessFieldResult | null;
  ruleEvalResult: RuleEvaluationResult;
  sopText?: string | null;
  /** Treatment records with full config (used for policy-config-backed communication compilation) */
  treatments?: TreatmentWithRules[];
}

/** Extract a numeric value from resolved source fields by multiple possible key aliases */
function extractNumeric(values: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = values[k];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return null;
}

/** Extract a string value from resolved source fields by multiple possible key aliases */
function extractString(values: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = values[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Compile communication guidelines from policy configuration.
 *
 * Primary source: structured treatment `tone` fields and policy pack metadata.
 * Secondary source: SOP text structured-section parsing (bullet lists only).
 *
 * `communicationSource` is "policy_config" when structured data drives the output,
 * "default_empty" only when neither source yields any content.
 */
function compileCommunicationFromPolicy(
  sopText: string | null | undefined,
  treatments?: TreatmentWithRules[]
): CommunicationSection {
  const communicationGuidelines: string[] = [];
  const emailGuidelines: string[] = [];
  const emailWhenToUse: string[] = [];
  const emailWhenNotToUse: string[] = [];
  const toneGuidance: string[] = [];

  // ── Primary: policy-config treatment tone fields (structured DB data) ──────
  if (treatments && treatments.length > 0) {
    const tones = treatments
      .map(t => t.tone)
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    const uniqueTones = [...new Set(tones.map(t => t.trim()))];
    for (const tone of uniqueTones) {
      toneGuidance.push(`Treatment tone: ${tone}`);
    }
  }

  // ── Secondary: SOP text structured-section parsing (bullet-list sections) ─
  if (sopText && sopText.trim()) {
    const lines = sopText.split("\n");
    let currentSection: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const lower = line.toLowerCase();
      // Section header detection (only for explicit structural headings)
      if (/^#+\s/.test(line) || (line.endsWith(":") && line.length < 80)) {
        if (lower.includes("communication guideline") || lower.includes("outreach rule")) {
          currentSection = "comm";
        } else if (lower.includes("email guideline") || lower.includes("email rule")) {
          currentSection = "email";
        } else if (lower.includes("when to send email") || lower.includes("email when to use")) {
          currentSection = "emailWhen";
        } else if (lower.includes("do not send email") || lower.includes("email when not") || lower.includes("no email when")) {
          currentSection = "emailWhenNot";
        } else if (lower.includes("tone") || lower.includes("communication tone")) {
          currentSection = "tone";
        }
        continue;
      }

      const bulletContent = line.replace(/^[-•*]\s*/, "").replace(/^\d+\.\s*/, "");
      if (
        bulletContent &&
        currentSection &&
        (line.startsWith("-") || line.startsWith("•") || line.startsWith("*") || /^\d+\./.test(line))
      ) {
        switch (currentSection) {
          case "comm": communicationGuidelines.push(bulletContent); break;
          case "email": emailGuidelines.push(bulletContent); break;
          case "emailWhen": emailWhenToUse.push(bulletContent); break;
          case "emailWhenNot": emailWhenNotToUse.push(bulletContent); break;
          case "tone": toneGuidance.push(bulletContent); break;
        }
      }
    }
  }

  const hasAnyContent =
    communicationGuidelines.length > 0 ||
    emailGuidelines.length > 0 ||
    emailWhenToUse.length > 0 ||
    emailWhenNotToUse.length > 0 ||
    toneGuidance.length > 0;

  return {
    guidelines: {
      communicationGuidelines,
      emailGuidelines,
      emailWhenToUse,
      emailWhenNotToUse,
      toneGuidance,
    },
    communicationSource: hasAnyContent ? "policy_config" : "default_empty",
  };
}

/** Build field availability summary from resolved values and raw data */
function buildFieldAvailabilitySummary(
  resolvedValues: Record<string, unknown>,
  rawCustomerData: Record<string, unknown>
): FieldAvailabilitySummary {
  const countsBySource: Record<string, number> = {};

  let hasLoanData = false;
  let hasBureauData = false;

  for (const [k, v] of Object.entries(resolvedValues)) {
    if (v === null || v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower.includes("bureau") || lower.includes("credit_score") || lower.includes("fico")) {
      hasBureauData = true;
      countsBySource["bureau"] = (countsBySource["bureau"] ?? 0) + 1;
    } else if (lower.startsWith("source:")) {
      hasLoanData = true;
      countsBySource["loan_data"] = (countsBySource["loan_data"] ?? 0) + 1;
    } else {
      hasLoanData = true;
      countsBySource["loan_data"] = (countsBySource["loan_data"] ?? 0) + 1;
    }
  }

  const payments = rawCustomerData._payments ?? rawCustomerData.payments;
  const conversations = rawCustomerData._conversations ?? rawCustomerData.conversations;
  const hasPaymentData = Array.isArray(payments) && payments.length > 0;
  const hasConversationData = Array.isArray(conversations) && conversations.length > 0;
  if (hasPaymentData) countsBySource["payment_history"] = (payments as unknown[]).length;
  if (hasConversationData) countsBySource["conversation_history"] = (conversations as unknown[]).length;

  return {
    hasLoanData,
    hasPaymentData,
    hasConversationData,
    hasBureauData,
    sourceFieldCounts: countsBySource,
  };
}

export function buildDecisionPacket(args: BuildDecisionPacketArgs): DecisionPacket {
  const {
    runId,
    policyPack,
    rawCustomerData,
    fieldResolution,
    derivedFieldResult,
    businessFieldResult,
    ruleEvalResult,
    sopText,
    treatments,
  } = args;

  const rv = fieldResolution.resolvedValues;
  const bv = businessFieldResult?.values ?? {};

  // ── Customer identity ────────────────────────────────────────────────────
  const customer_guid = extractString(rv,
    "source:customer / account / loan id",
    "customer / account / loan id",
    "source:customer_id", "customer_id",
    "source:account_id", "account_id",
    "source:customer_guid", "customer_guid"
  ) ?? extractString(rawCustomerData as Record<string, unknown>,
    "customer / account / loan id", "customer_id", "account_id"
  );

  const customer_name = extractString(rv,
    "source:customer_name", "customer_name",
    "source:full_name", "full_name",
    "source:name", "name"
  );
  const customer_phone = extractString(rv,
    "source:phone", "phone",
    "source:mobile", "mobile",
    "source:contact_number", "contact_number"
  );
  const customer_email = extractString(rv,
    "source:email", "email",
    "source:email_address", "email_address"
  );
  const days_past_due = extractNumeric(rv,
    "source:days_past_due", "days_past_due",
    "source:DPD", "DPD", "source:dpd", "dpd"
  );
  const amount_due = extractNumeric(rv,
    "source:amount_due", "amount_due",
    "source:total_arrears", "total_arrears",
    "source:outstanding_balance", "outstanding_balance"
  );
  const minimum_due = extractNumeric(rv,
    "source:minimum_amount_due", "minimum_amount_due",
    "source:mad", "mad",
    "source:min_payment", "min_payment"
  );

  // ── Additional customer context ──────────────────────────────────────────
  const fixedKeys = new Set([
    "customer_guid", "customer_name", "full_name", "name",
    "phone", "mobile", "contact_number",
    "email", "email_address",
    "days_past_due", "dpd", "DPD",
    "amount_due", "total_arrears", "outstanding_balance",
    "minimum_amount_due", "mad", "min_payment",
  ]);
  const additional_customer_context: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(rv)) {
    const shortKey = k.startsWith("source:") ? k.slice(7) : k;
    if (fixedKeys.has(shortKey)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number") {
      additional_customer_context[shortKey] = v;
    }
  }

  // ── Communication ────────────────────────────────────────────────────────
  const communication = compileCommunicationFromPolicy(sopText, treatments);

  // ── Derived / business field values (non-null) ───────────────────────────
  const derivedFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(derivedFieldResult.values)) {
    if (v !== null && v !== undefined) derivedFields[k] = v;
  }

  const businessFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bv)) {
    if (v !== null && v !== undefined) businessFields[k] = v;
  }

  // ── Decision basis summary ───────────────────────────────────────────────
  const sourceFieldCount = Object.keys(rv).filter(k => !k.startsWith("_")).length;
  const sourceFieldNullCount = Object.values(rv).filter(v => v === null || v === undefined).length;

  const dtCounts = derivedFieldResult.stageMetrics?.counts ?? {};
  const bfTraces = businessFieldResult?.traces ?? {};
  const bfInferred = Object.values(bfTraces).filter(t => t.value !== null && t.value !== undefined).length;
  const bfNull = Object.values(bfTraces).filter(t => t.value === null && !t.nullReason?.includes("cap") && !t.nullReason?.includes("timeout")).length;
  const bfFailed = Object.values(bfTraces).filter(t => t.value === null && (t.nullReason?.includes("cap") || t.nullReason?.includes("timeout") || t.nullReason?.includes("invalid after retry"))).length;

  const decisionBasisSummary: DecisionBasisSummary = {
    sourceFieldCount,
    sourceFieldNullCount,
    derivedComputed: dtCounts["computed"] ?? 0,
    derivedNull: dtCounts["null"] ?? 0,
    derivedError: dtCounts["error"] ?? 0,
    derivedSkipped: dtCounts["skipped"] ?? 0,
    businessInferred: bfInferred,
    businessNull: bfNull,
    businessFailed: bfFailed,
    eligibleTreatmentCount: ruleEvalResult.eligibleTreatments.length,
    blockedTreatmentCount: ruleEvalResult.blockedTreatments.length,
    preferredTreatmentCount: ruleEvalResult.preferredTreatments.length,
    missingCriticalInfoCount: ruleEvalResult.missingCriticalInformation.length,
  };

  // ── Field availability ───────────────────────────────────────────────────
  const fieldAvailabilitySummary = buildFieldAvailabilitySummary(rv, rawCustomerData);

  // ── Payment / conversation raw data for prompt context ───────────────────
  const payments = rawCustomerData._payments ?? rawCustomerData.payments;
  const conversations = rawCustomerData._conversations ?? rawCustomerData.conversations;
  const rawPaymentData = Array.isArray(payments) ? payments : [];
  const rawConversationData = Array.isArray(conversations) ? conversations : [];

  return {
    runId,
    engineVersion: "decision-layer-v2.1",
    policyVersion: policyPack?.updatedAt?.toISOString() ?? "unknown",
    timestamp: new Date().toISOString(),

    customer_guid,
    customer_name,
    customer_phone,
    customer_email,
    days_past_due,
    amount_due,
    minimum_due,
    additional_customer_context,

    rankedEligibleTreatments: ruleEvalResult.rankedEligibleTreatments,
    preferredTreatments: ruleEvalResult.preferredTreatments,
    blockedTreatments: ruleEvalResult.blockedTreatments,
    escalationFlags: ruleEvalResult.escalationFlags,
    guardrailFlags: ruleEvalResult.guardrailFlags,
    reviewTriggers: ruleEvalResult.reviewTriggers,
    missingCriticalInformation: ruleEvalResult.missingCriticalInformation,

    sourceFields: rv,
    derivedFields,
    businessFields,

    communication,

    decisionBasisSummary,
    fieldAvailabilitySummary,

    rawPaymentData: rawPaymentData.slice(0, 20),
    rawConversationData: rawConversationData.slice(0, 10),
  };
}
