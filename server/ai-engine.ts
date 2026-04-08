import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LogicalDerivationConfigSchema } from "./lib/derivation-config";

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

export interface AIDecisionOutput {
  customer_guid: string;
  payment_history: string;
  conversation: string;
  vulnerability: boolean;
  reason_for_vulnerability: string;
  affordability: string;
  reason_for_affordability: string;
  willingness: string;
  reason_for_willingness: string;
  ability_to_pay: number | null;
  reason_for_ability_to_pay: string;
  problem_description: string;
  problem_confidence_score: number;
  problem_evidence: string;
  proposed_solution: string;
  solution_confidence_score: number;
  solution_evidence: string;
  internal_action: string;
  proposed_email_to_customer: string;
  combined_cmd: number | null;
  no_of_latest_payments_failed: number;
  arrears_clearance_plan: {
    monthly_payment_recommended: number;
    surplus_above_mad: number;
    total_arrears: number;
    months_to_clear: number;
    projected_timeline: Array<{ month: number; payment: number; remaining_arrears: number }>;
  } | null;
}

function summarizePayments(payments: Array<Record<string, any>>): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return dateStr;
    }
  };

  const timeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    const months = Math.round((now.getTime() - d.getTime()) / (30.44 * 24 * 60 * 60 * 1000));
    if (months < 1) return "this month";
    if (months === 1) return "1 month ago";
    if (months < 12) return `${months} months ago`;
    const years = Math.floor(months / 12);
    const rem = months % 12;
    if (rem === 0) return `${years} year${years > 1 ? "s" : ""} ago`;
    return `over ${years} year${years > 1 ? "s" : ""} ago`;
  };

  const sorted = [...payments].sort((a, b) => {
    const da = new Date(a.date_of_payment || 0).getTime();
    const db = new Date(b.date_of_payment || 0).getTime();
    return db - da;
  });

  const recent = sorted.filter(p => new Date(p.date_of_payment || 0) >= sixMonthsAgo);
  const older = sorted.filter(p => new Date(p.date_of_payment || 0) < sixMonthsAgo);

  const sumAmounts = (list: Array<Record<string, any>>) =>
    list.reduce((sum, p) => sum + (parseFloat(p.amount_paid) || 0), 0);

  const countByStatus = (list: Array<Record<string, any>>) => {
    const received = list.filter(p => String(p.payment_status || "").toLowerCase() === "received");
    const failed = list.filter(p => String(p.payment_status || "").toLowerCase() === "failed");
    const cancelled = list.filter(p => String(p.payment_status || "").toLowerCase() === "cancelled");
    return { received, failed, cancelled };
  };

  const parts: string[] = [];

  if (recent.length > 0) {
    const { received, failed, cancelled } = countByStatus(recent);
    const segments: string[] = [];
    if (received.length > 0) {
      segments.push(`${received.length} successful ($${sumAmounts(received).toFixed(2)})`);
    }
    if (failed.length > 0) {
      segments.push(`${failed.length} failed ($${sumAmounts(failed).toFixed(2)})`);
    }
    if (cancelled.length > 0) {
      segments.push(`${cancelled.length} cancelled ($${sumAmounts(cancelled).toFixed(2)})`);
    }
    parts.push(`Last 6 months: ${segments.join(", ")}.`);

    if (received.length > 0) {
      parts.push(`Most recent successful: $${parseFloat(received[0].amount_paid).toFixed(2)} on ${formatDate(received[0].date_of_payment)}.`);
    } else {
      parts.push("No successful payments in this period.");
    }
  } else {
    parts.push("No payment activity in the last 6 months.");
    if (older.length > 0) {
      const { received } = countByStatus(older);
      if (received.length > 0) {
        parts.push(`Last successful payment: $${parseFloat(received[0].amount_paid).toFixed(2)} on ${formatDate(received[0].date_of_payment)} (${timeAgo(received[0].date_of_payment)}).`);
      } else {
        parts.push(`Last recorded activity: ${formatDate(older[0].date_of_payment)} (${timeAgo(older[0].date_of_payment)}) — ${String(older[0].payment_status || "unknown").toLowerCase()}.`);
      }
    }
  }

  return parts.slice(0, 3).join(" ");
}

export async function analyzeCustomer(
  customerData: Record<string, unknown>,
  assembledPrompt: string
): Promise<AIDecisionOutput> {
  const userMessage = `Now analyze the customer data provided in the instructions above and respond with valid JSON only.

REMINDER before you respond:
- The affordability label MUST match the conclusion in reason_for_affordability
- The willingness label MUST match the conclusion in reason_for_willingness
- If your calculation shows a specific label (e.g., VERY LOW, MEDIUM), use that label — do NOT default to NOT SURE
- reason_for_affordability and reason_for_willingness must NOT be empty`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      { role: "user", parts: [{ text: assembledPrompt }] },
      { role: "model", parts: [{ text: "Understood. I will analyze the customer data, calculate affordability and willingness labels following the step-by-step process, and ensure the labels match my calculated conclusions. I will respond with valid JSON only." }] },
      { role: "user", parts: [{ text: userMessage }] },
    ],
    config: { maxOutputTokens: 65536 },
  });

  const text = response.text || "";

  console.log("[AI DEBUG] Raw response length:", text.length);
  console.log("[AI DEBUG] Raw response (first 2000 chars):", text.substring(0, 2000));

  let jsonStr = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  } else {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      jsonStr = braceMatch[0];
    }
  }

  function tryParse(str: string): Record<string, unknown> | null {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function repairAndParse(str: string): Record<string, unknown> | null {
    let result = tryParse(str);
    if (result) return result;

    let repaired = str.replace(/,\s*$/, "");
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    const missing = openBraces - closeBraces;

    if (missing > 0) {
      const lastQuote = repaired.lastIndexOf('"');
      const lastColon = repaired.lastIndexOf(":");
      if (lastColon > lastQuote) {
        repaired = repaired.substring(0, lastColon) + '": ""';
      }
      repaired = repaired.replace(/,\s*$/, "");
      for (let i = 0; i < missing; i++) repaired += "}";
      result = tryParse(repaired);
      if (result) return result;
    }

    return null;
  }

  const parsed = repairAndParse(jsonStr) as Record<string, any> | null;

  console.log("[AI DEBUG] Parsed affordability:", parsed?.affordability);
  console.log("[AI DEBUG] Parsed reason_for_affordability:", parsed?.reason_for_affordability);
  console.log("[AI DEBUG] Parsed willingness:", parsed?.willingness);
  console.log("[AI DEBUG] Parsed reason_for_willingness:", parsed?.reason_for_willingness);
  console.log("[AI DEBUG] Parsed payment_history:", parsed?.payment_history);

  function normalizeEmail(raw: unknown): string {
    if (!raw) return "NO_ACTION";
    if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      const desc = obj.description || obj.text || obj.body || obj.content || "";
      if (typeof desc === "string" && desc.length > 0) return desc;
      return JSON.stringify(raw);
    }
    if (typeof raw !== "string") return "NO_ACTION";
    let str = raw.trim();
    if (str.startsWith("{")) {
      try {
        const obj = JSON.parse(str);
        const desc = obj.description || obj.text || obj.body || obj.content || "";
        if (typeof desc === "string" && desc.length > 0) return desc;
      } catch {}
    }
    return str || "NO_ACTION";
  }

  const VALID_LABELS = new Set(["HIGH", "MEDIUM", "LOW", "VERY LOW", "NOT SURE"]);

  function normalizeLabel(raw: unknown): string {
    if (!raw || typeof raw !== "string") return "NOT SURE";
    let val = raw.trim().toUpperCase();
    val = val.replace(/_/g, " ");
    if (val === "NOTSURE" || val === "N/A" || val === "UNKNOWN") val = "NOT SURE";
    if (val === "VERYLOW") val = "VERY LOW";
    if (VALID_LABELS.has(val)) return val;
    return "NOT SURE";
  }

  function extractLabelFromText(text: string): string | null {
    if (!text) return null;
    const arrowMatch = text.match(/→\s*(HIGH|MEDIUM|LOW|VERY LOW)/i);
    if (arrowMatch) return arrowMatch[1].toUpperCase();
    const labelMatch = text.match(/(?:resulting in|rating of|rated as|classified as|is)\s+(?:a\s+)?(VERY LOW|HIGH|MEDIUM|LOW)\b/i);
    if (labelMatch) return labelMatch[1].toUpperCase();
    const lower = text.toLowerCase();
    if (lower.includes("all payments failed") || lower.includes("zero successful payments") ||
        lower.includes("no successful payments") || lower.includes("capacity = $0") ||
        lower.includes("capacity is $0") || lower.includes("no payments in the last") ||
        lower.includes("no payments received") || lower.includes("absence of payments") ||
        lower.includes("nmpc is $0") || lower.includes("nmpc=$0") || lower.includes("nmpc = $0")) {
      return "VERY LOW";
    }
    return null;
  }

  function extractLabelFromEvidence(evidenceText: string, fieldName: "affordability" | "willingness"): string | null {
    if (!evidenceText) return null;
    const patterns = [
      new RegExp(`${fieldName}\\s*(?:=|is|:)\\s*['"]?(VERY LOW|HIGH|MEDIUM|LOW)['"]?`, "i"),
      new RegExp(`(VERY LOW|HIGH|MEDIUM|LOW)\\s+${fieldName}`, "i"),
    ];
    for (const pattern of patterns) {
      const match = evidenceText.match(pattern);
      if (match) return match[1].toUpperCase();
    }
    return null;
  }

  function humanizeReasonText(text: string): string {
    if (!text) return text;
    return text
      .replace(/\bNMPC\b/gi, "estimated monthly payment capacity")
      .replace(/\bMAD\b/g, "minimum amount due");
  }

  try {
    if (!parsed) throw new Error("Could not parse AI response");

    const rawAffordability = normalizeLabel(parsed.affordability);
    const rawWillingness = normalizeLabel(parsed.willingness);
    let reasonAffordability = String(parsed.reason_for_affordability ?? "");
    let reasonWillingness = String(parsed.reason_for_willingness ?? "");
    const reasonAbilityToPay = String(parsed.reason_for_ability_to_pay ?? "");
    const solutionEvidence = String(parsed.solution_evidence ?? "");

    let finalAffordability = rawAffordability;
    let finalWillingness = rawWillingness;

    if (finalAffordability === "NOT SURE") {
      const fromReason = extractLabelFromText(reasonAffordability);
      if (fromReason) finalAffordability = fromReason;
    }
    if (finalAffordability === "NOT SURE") {
      const fromEvidence = extractLabelFromEvidence(solutionEvidence, "affordability");
      if (fromEvidence) {
        finalAffordability = fromEvidence;
        console.log("[AI FIX] Extracted affordability from solution_evidence:", fromEvidence);
      }
    }
    if (finalAffordability === "NOT SURE") {
      const fromAbility = String(parsed.reason_for_ability_to_pay ?? "");
      const fromText = extractLabelFromText(fromAbility);
      if (fromText) finalAffordability = fromText;
    }

    if (finalAffordability === "NOT SURE") {
      const payments = (customerData._payments || customerData.payments || []) as Array<Record<string, any>>;
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const recentReceived = payments.filter(p => {
        const status = String(p.payment_status || "").toLowerCase();
        const date = new Date(p.date_of_payment || 0);
        return status === "received" && date >= threeMonthsAgo;
      });
      if (recentReceived.length === 0) {
        finalAffordability = "VERY LOW";
        if (!reasonAffordability) {
          reasonAffordability = "No successful payments received in the last 3 months. Affordability defaults to VERY LOW per business rules.";
        }
        console.log("[AI FIX] Affordability defaulted to VERY LOW — no recent successful payments");
      }
    }

    if (finalWillingness === "NOT SURE") {
      const fromReason = extractLabelFromText(reasonWillingness);
      if (fromReason) finalWillingness = fromReason;
    }
    if (finalWillingness === "NOT SURE") {
      const fromEvidence = extractLabelFromEvidence(solutionEvidence, "willingness");
      if (fromEvidence) {
        finalWillingness = fromEvidence;
        console.log("[AI FIX] Extracted willingness from solution_evidence:", fromEvidence);
      }
    }

    if (finalWillingness === "NOT SURE") {
      const conversations = (customerData._conversations || customerData.conversations || []) as Array<Record<string, any>>;
      const payments = (customerData._payments || customerData.payments || []) as Array<Record<string, any>>;
      const hasConversations = conversations.length > 0;
      const hasPaymentAttempts = payments.length > 0;

      if (!hasConversations && !hasPaymentAttempts) {
        finalWillingness = "VERY LOW";
        if (!reasonWillingness) {
          reasonWillingness = "No conversations or payment attempts on record. Willingness defaults to VERY LOW per business rules.";
        }
        console.log("[AI FIX] Willingness defaulted to VERY LOW — no conversations or payment attempts");
      } else if (hasPaymentAttempts && !hasConversations) {
        finalWillingness = "LOW";
        if (!reasonWillingness) {
          reasonWillingness = "Payment attempts exist but no customer-initiated conversations on record. No engagement beyond automated payments.";
        }
        console.log("[AI FIX] Willingness defaulted to LOW — payments but no conversations");
      } else {
        finalWillingness = "VERY LOW";
        if (!reasonWillingness) {
          reasonWillingness = "Insufficient engagement signals to determine willingness. Defaults to VERY LOW per business rules.";
        }
        console.log("[AI FIX] Willingness defaulted to VERY LOW — fallback");
      }
    }

    if (!reasonAffordability && finalAffordability !== "NOT SURE") {
      const abilityReason = String(parsed.reason_for_ability_to_pay ?? "");
      if (abilityReason) {
        reasonAffordability = `${abilityReason} → ${finalAffordability}`;
        console.log("[AI FIX] Generated reason_for_affordability from ability_to_pay reason");
      }
    }

    if (!reasonWillingness && finalWillingness !== "NOT SURE") {
      const conversation = String(parsed.conversation ?? "");
      if (conversation) {
        reasonWillingness = `${conversation} → ${finalWillingness}`;
        console.log("[AI FIX] Generated reason_for_willingness from conversation summary");
      }
    }

    console.log("[AI FINAL] affordability:", finalAffordability, "willingness:", finalWillingness);

    let paymentHistory = String(parsed.payment_history ?? "");
    if (!paymentHistory) {
      const payments = (customerData._payments || customerData.payments || []) as Array<Record<string, any>>;
      if (payments.length > 0) {
        paymentHistory = summarizePayments(payments);
        console.log("[AI FIX] Generated payment_history from customer data");
      }
    }

    return {
      customer_guid: parsed.customer_guid || String(customerData["customer / account / loan id"] || customerData.customer_id || customerData.account_id || "unknown"),
      payment_history: paymentHistory,
      conversation: parsed.conversation || "",
      vulnerability: parsed.vulnerability === true || parsed.vulnerability === "true",
      reason_for_vulnerability: parsed.reason_for_vulnerability || "",
      affordability: finalAffordability,
      reason_for_affordability: humanizeReasonText(reasonAffordability),
      willingness: finalWillingness,
      reason_for_willingness: humanizeReasonText(reasonWillingness),
      ability_to_pay: parsed.ability_to_pay ?? null,
      reason_for_ability_to_pay: humanizeReasonText(reasonAbilityToPay),
      problem_description: parsed.problem_description || parsed["problem_customer is facing"] || parsed.problem_customer_is_facing || "",
      problem_confidence_score: Math.min(10, Math.max(1, parseInt(parsed.problem_confidence_score) || 5)),
      problem_evidence: parsed.problem_evidence || "",
      proposed_solution: parsed.proposed_solution || "",
      solution_confidence_score: Math.min(10, Math.max(1, parseInt(parsed.solution_confidence_score) || 5)),
      solution_evidence: parsed.solution_evidence || "",
      internal_action: parsed.internal_action || "",
      proposed_email_to_customer: normalizeEmail(parsed.proposed_email_to_customer),
      combined_cmd: parsed.combined_cmd ?? null,
      no_of_latest_payments_failed: parseInt(parsed.no_of_latest_payments_failed) || 0,
      arrears_clearance_plan: parsed.arrears_clearance_plan && typeof parsed.arrears_clearance_plan === 'object' ? {
        monthly_payment_recommended: Number(parsed.arrears_clearance_plan.monthly_payment_recommended) || 0,
        surplus_above_mad: Number(parsed.arrears_clearance_plan.surplus_above_mad) || 0,
        total_arrears: Number(parsed.arrears_clearance_plan.total_arrears) || 0,
        months_to_clear: Number(parsed.arrears_clearance_plan.months_to_clear) || 0,
        projected_timeline: Array.isArray(parsed.arrears_clearance_plan.projected_timeline)
          ? parsed.arrears_clearance_plan.projected_timeline.map((r: any) => ({
              month: Number(r.month) || 0,
              payment: Number(r.payment) || 0,
              remaining_arrears: Number(r.remaining_arrears) || 0,
            }))
          : [],
      } : null,
    };
  } catch (e) {
    return {
      customer_guid: String(customerData["customer / account / loan id"] || customerData.customer_id || customerData.account_id || "unknown"),
      payment_history: "",
      conversation: "",
      vulnerability: false,
      reason_for_vulnerability: "",
      affordability: "VERY LOW",
      reason_for_affordability: "AI analysis could not be parsed. Affordability defaults to VERY LOW per business rules.",
      willingness: "VERY LOW",
      reason_for_willingness: "AI analysis could not be parsed. Willingness defaults to VERY LOW per business rules.",
      ability_to_pay: null,
      reason_for_ability_to_pay: "",
      problem_description: "AI analysis could not be parsed. Raw response stored.",
      problem_confidence_score: 1,
      problem_evidence: text.substring(0, 500),
      proposed_solution: "Manual review required.",
      solution_confidence_score: 1,
      solution_evidence: "",
      internal_action: "Escalate for manual review due to AI parsing failure.",
      proposed_email_to_customer: "NO_ACTION",
      combined_cmd: null,
      no_of_latest_payments_failed: 0,
      arrears_clearance_plan: null,
    };
  }
}

export async function extractTextFromImage(base64Data: string, mimeType: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract all text from this document image. Return only the extracted text, nothing else." },
          { inlineData: { data: base64Data, mimeType } },
        ],
      },
    ],
    config: { maxOutputTokens: 8192 },
  });

  return response.text || "";
}

// ─── Column evidence type (built in routes, consumed here) ───────────────────
export interface ColumnEvidence {
  fieldName: string;
  sampleValues: string[];
  inferredType: 'numeric' | 'boolean-like' | 'date-like' | 'categorical' | 'free-text';
  distinctValues?: string[];
}

// ─── Zod schema for a single field-analysis item ─────────────────────────────
const FieldAnalysisItemSchema = z.object({
  fieldName: z.string().min(1),
  beaconsUnderstanding: z.string(),
  confidence: z.enum(["High", "Medium", "Low"]),
});

type FieldAnalysisItem = z.infer<typeof FieldAnalysisItemSchema>;

/** Normalise a header/fieldName to lowercase alphanumeric only for fuzzy matching */
function normaliseKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Capitalise the first letter of a confidence string so "high" → "High" etc. */
function normaliseConfidence(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const lower = raw.toLowerCase();
  if (lower === "high") return "High";
  if (lower === "medium") return "Medium";
  if (lower === "low") return "Low";
  return raw;
}

// Patterns that match when the ENTIRE description is a pure datatype/generic label.
// These are tested against the full trimmed description — they do NOT trigger when
// the phrase appears as part of a longer, domain-specific sentence.
const PURE_DATATYPE_PATTERNS: RegExp[] = [
  /^date\s+field\.?$/i,
  /^boolean\s+flag\.?(\s+\(true\/false\))?\.?$/i,
  /^boolean\s+flag\s+\(true\/false\)\s+indicating\s+[\w\s]+?\.?$/i,
  /^boolean\s+flag\s+indicating\s+(whether\s+)?[\w\s]+?\.?$/i,
  /^reference\s+identifier\.?$/i,
  /^status\s+indicator\.?$/i,
  /^currency\s+amount\s+in\s+gbp\.?$/i,
  /^categorisation\s+or\s+type\s+field\.?$/i,
  /^graded\s+or\s+tiered\s+level\s+indicator\.?$/i,
  /^duration\s+expressed\s+in\s+months\.?$/i,
  /^unique\s+identifier\.?$/i,
  /^outstanding\s+balance\s+amount\.?$/i,
  /^duration\s+(or\s+time-span\s+)?field\.?$/i,
  /^count\s+or\s+flag\s+for\s+(inbound|outbound)\s+communications?\s+(sent|received)\.?$/i,
  /^field\s+named\s+".+"\s+[—-]\s+please\s+describe/i,
  /^.{1,80}\s+[—-]\s+please\s+describe\s+what\s+this\s+field\s+represents\.?$/i,
];

const BOILERPLATE_EXACT = new Set([
  "unknown", "field", "n/a", "na", "none", "null", "undefined", "tbd", "todo",
]);

/**
 * Returns true if the description is weak: too short, boilerplate, near-identical
 * to the header, or is a pure datatype label without domain/business meaning.
 * Does NOT reject descriptions that contain phrases like "count of" or "numerical
 * score" unless those phrases constitute the ENTIRE description with no domain context.
 */
function isWeakDescription(desc: string, headerNorm: string): boolean {
  const trimmed = desc.trim();
  const lower = trimmed.toLowerCase();

  if (trimmed.length < 20) return true;
  if (BOILERPLATE_EXACT.has(lower)) return true;
  if (normaliseKey(trimmed) === headerNorm) return true;

  for (const pattern of PURE_DATATYPE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

/** Three-tier header matching: exact → case-insensitive → alphanumeric-normalised */
function matchHeader(
  fieldName: string,
  headerExact: Map<string, string>,
  headerLower: Map<string, string>,
  headerNormMap: Map<string, string>,
): string | undefined {
  if (headerExact.has(fieldName)) return headerExact.get(fieldName);
  if (headerLower.has(fieldName.toLowerCase())) return headerLower.get(fieldName.toLowerCase());
  if (headerNormMap.has(normaliseKey(fieldName))) return headerNormMap.get(normaliseKey(fieldName));
  return undefined;
}

/** Parse, fence-strip, JSON-parse, and Zod-validate AI response items */
function parseAIResponse(
  rawText: string,
  categoryId: string,
  headerCount: number,
  stage: string,
): FieldAnalysisItem[] {
  let jsonText = rawText.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }

  let parsed: unknown[];
  try {
    const p = JSON.parse(jsonText);
    parsed = Array.isArray(p) ? p : [];
    if (!Array.isArray(p)) {
      console.warn(`[analyzeCategoryFields] stage=json_parse pass=${stage} category=${categoryId} headers=${headerCount} reason=non-array raw=${rawText.slice(0, 500)}`);
    }
  } catch {
    console.warn(`[analyzeCategoryFields] stage=json_parse pass=${stage} category=${categoryId} headers=${headerCount} reason=parse-error raw=${rawText.slice(0, 500)}`);
    return [];
  }

  const valid: FieldAnalysisItem[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object") {
      const patched = { ...(item as Record<string, unknown>) };
      patched.confidence = normaliseConfidence(patched.confidence);
      const result = FieldAnalysisItemSchema.safeParse(patched);
      if (result.success) {
        valid.push(result.data);
      } else {
        console.warn(`[analyzeCategoryFields] stage=zod_validation pass=${stage} category=${categoryId} headers=${headerCount} item=${JSON.stringify(item).slice(0, 200)}`);
      }
    }
  }
  return valid;
}

/** Format column evidence into a compact string for the prompt */
function buildEvidenceStr(columnEvidence: ColumnEvidence[]): string {
  return columnEvidence.map((col, i) => {
    const parts: string[] = [`${i + 1}. ${col.fieldName} [${col.inferredType}]`];
    if (col.distinctValues && col.distinctValues.length > 0) {
      parts.push(`distinct: ${col.distinctValues.join(", ")}`);
    } else if (col.sampleValues.length > 0) {
      parts.push(`samples: ${col.sampleValues.join(", ")}`);
    }
    return parts.join(" | ");
  }).join("\n");
}

/** Build the first-pass domain-specific prompt */
function buildFirstPassPrompt(categoryLabel: string, evidenceStr: string): string {
  return `You are a senior data analyst for Beacon, a software platform used in lending, servicing, arrears management, collections strategy, recoveries, payment operations, affordability assessment, customer engagement, vulnerability handling, and support operations.

A client has uploaded a sample CSV for the "${categoryLabel}" data category in Beacon's Data Configuration area.

Your task is to infer what each column most likely means in the business context most relevant to that category.

Category interpretation guidance:
- Loan / Account Data: interpret fields in the context of lending, balances, delinquency, arrears, recoveries, status, forbearance, insolvency, and account treatment
- Payment Data: interpret fields in the context of payments, scheduled vs received amounts, payment dates, reversals, failed payments, allocations, repayment behaviour, and arrears progression
- Conversation / Contact / Communication Data: interpret fields in the context of customer interactions, outreach attempts, channels, outcomes, promises to pay, complaints, engagement, and collections contact strategy
- Customer Data: interpret fields in the context of identity, demographics, contactability, affordability, vulnerability, and customer servicing
- Other categories: infer the most likely operational meaning based on headers, sample values, and Beacon's collections/servicing use case

Domain glossary — expand these in descriptions where appropriate:
DCA = Debt Collection Agency | CAIS = Credit Account Information Sharing (bureau reporting) | RAG = Red/Amber/Green status indicator | IE = Income and Expenditure assessment | PTP = Promise to Pay | RPC = Right Party Contact | IVA = Individual Voluntary Arrangement | DRO = Debt Relief Order | DMP = Debt Management Plan | Breathing Space = FCA-mandated protection period that restricts collections contact and enforcement activity | Forbearance = flexible repayment support arrangement applied to an account (includes payment plans, deferrals, interest concessions)

Column evidence (fieldName [inferredType] | sample or distinct values):
${evidenceStr}

For each column, return one JSON object with exactly these keys:
- fieldName: the exact column name as listed above — copy it character-for-character, do not rename or reformat
- beaconsUnderstanding: a concise but specific plain-English description (1–2 sentences)
  Sentence 1: what the field most likely represents in the relevant business context
  Sentence 2 if needed: how it is used or why it matters operationally
  Use "likely", "appears to", or "probably" when certainty is limited
- confidence: exactly one of "High", "Medium", or "Low"
  High = column name and/or sample values make the meaning very clear
  Medium = meaning is reasonably inferable but there is some ambiguity
  Low = meaning is genuinely uncertain even after considering name and values

Good description examples:
- "Current amount overdue on the account, expressed in GBP. This is a core arrears severity measure used to prioritise collections treatment."
- "Amount received from the customer for a payment transaction, likely used to track repayment behaviour and reconcile account performance."
- "Outcome of a customer contact attempt, such as right party contact, voicemail, or no answer. This helps determine next-step collections strategy."
- "Indicator showing whether the customer is currently in an approved Breathing Space protection period. This would affect collections activity and contact restrictions."

Bad description examples — never produce these or similar:
- "Currency amount in GBP"
- "Date field"
- "Reference identifier"
- "Boolean flag"
- "Status indicator"
- "Field named X — please describe what this field represents"
- "Categorisation or type field"

Rules:
- Return ONLY a raw JSON array — no markdown, no code fences, no explanation, no commentary
- Every input column must appear exactly once in your output
- Do not rename, normalise, or reformat field names — copy each one exactly as listed above
- Do not invent columns not in the list
- Do not use placeholder or generic descriptions — if uncertain, give the best likely category-relevant interpretation`;
}

/** Build the repair prompt for weak/missing fields */
function buildRepairPrompt(categoryLabel: string, weakEvidence: ColumnEvidence[]): string {
  const weakEvidenceStr = buildEvidenceStr(weakEvidence);
  return `You previously generated field descriptions that were too generic or lacked business context for the "${categoryLabel}" data category in Beacon.

Rewrite the descriptions for the fields below so they are more specific and useful in the operational context of ${categoryLabel}.

Requirements:
- Use the column name and sample/distinct values provided
- Infer likely business meaning relevant to ${categoryLabel} operations
- Avoid generic phrases like "date field", "boolean flag", "reference identifier", "status indicator", "currency amount", "categorisation or type"
- Give the best likely interpretation even if confidence is Medium or Low
- Use "likely", "appears to", or "probably" when certainty is limited
- Keep each description to 1 or 2 sentences

Fields to rewrite (fieldName [inferredType] | sample or distinct values):
${weakEvidenceStr}

Return ONLY a raw JSON array with keys: fieldName (exact original name, character-for-character), beaconsUnderstanding, confidence ("High", "Medium", or "Low").
No markdown, no code fences, no explanation.`;
}

/** Domain-aware fallback when both AI passes fail — always includes business meaning */
function buildDomainFallback(header: string, categoryLabel: string): { beaconsUnderstanding: string; confidence: 'Low' } {
  const lower = header.toLowerCase();
  const parts = lower.split(/[_\-\s]+/);
  const cat = categoryLabel.toLowerCase();

  const has = (...terms: string[]) => terms.some(t => parts.includes(t) || lower.includes(t));

  if (has("breathing") && has("space")) {
    return { beaconsUnderstanding: `Likely relates to a Breathing Space protection registration, which would restrict collections contact and activity for the affected customer.`, confidence: "Low" };
  }
  if (has("insolvency") || has("iva") || has("dro") || has("bankruptcy")) {
    return { beaconsUnderstanding: `Likely indicates whether an insolvency event (such as IVA, DRO, or bankruptcy) applies to this customer, which would significantly affect collections strategy and permissible activity.`, confidence: "Low" };
  }
  if (has("vulnerability", "vulnerable") && has("rag")) {
    return { beaconsUnderstanding: `Likely a Red / Amber / Green (RAG) indicator of the customer's vulnerability status, used to adjust the collections approach and ensure compliant, sensitive handling.`, confidence: "Low" };
  }
  if (has("vulnerability", "vulnerable")) {
    return { beaconsUnderstanding: `Likely relates to the customer's vulnerability status or type, used to ensure appropriate and compliant collections treatment and engagement.`, confidence: "Low" };
  }
  if (has("forbearance", "arrangement", "deferral", "dmp")) {
    return { beaconsUnderstanding: `Likely relates to a forbearance or repayment arrangement applied to the account, such as a payment plan, deferral, or support intervention used in collections treatment.`, confidence: "Low" };
  }
  if (has("dca")) {
    return { beaconsUnderstanding: `Likely relates to placement of the account with a Debt Collection Agency (DCA), indicating the account may have been escalated beyond internal collections activity.`, confidence: "Low" };
  }
  if (has("cais", "bureau")) {
    return { beaconsUnderstanding: `Likely relates to the account's credit bureau (CAIS) status or reporting, used in credit risk assessment and regulatory compliance.`, confidence: "Low" };
  }
  if (has("disposable", "affordability", "expenditure") || (has("income") && !has("arrears"))) {
    return { beaconsUnderstanding: `Likely relates to the customer's income, expenditure, or disposable income assessment, used to determine payment affordability and appropriate collections treatment.`, confidence: "Low" };
  }
  if (lower.includes("_rag") || lower.startsWith("rag_") || lower === "rag") {
    return { beaconsUnderstanding: `Likely a Red / Amber / Green (RAG) status indicator used to classify the account, customer, or risk level for operational prioritisation.`, confidence: "Low" };
  }
  if (has("ptp", "promise")) {
    return { beaconsUnderstanding: `Likely relates to a Promise to Pay (PTP) commitment made by the customer, used to track expected payments and determine follow-up collections actions.`, confidence: "Low" };
  }
  if (has("outcome", "disposition", "rpc", "result")) {
    return { beaconsUnderstanding: `Likely the outcome of a customer contact attempt — such as right party contact, voicemail, or no answer — used to guide next-step collections strategy.`, confidence: "Low" };
  }
  if (has("contact", "comms", "communication", "outbound", "inbound", "sms", "email", "call")) {
    return { beaconsUnderstanding: `Likely relates to customer contact activity — such as channel, attempt count, or last contact date — used to inform engagement strategy in collections.`, confidence: "Low" };
  }
  if (has("settlement")) {
    return { beaconsUnderstanding: `Likely relates to a settlement offer or agreed settlement amount for resolving the outstanding debt, used in late-stage collections and recoveries.`, confidence: "Low" };
  }
  if (has("arrears") && has("balance", "amount", "gbp")) {
    return { beaconsUnderstanding: `Likely the amount currently overdue on the account, expressed as a monetary value. Used as a primary arrears severity measure in collections prioritisation.`, confidence: "Low" };
  }
  if (has("arrears") && has("duration", "months", "days", "period")) {
    return { beaconsUnderstanding: `Likely the duration of the current arrears episode. Used to assess arrears severity and inform collections treatment decisions.`, confidence: "Low" };
  }
  if (has("arrears", "overdue", "delinquency", "missed")) {
    return { beaconsUnderstanding: `Likely relates to the account's arrears position — such as arrears balance, duration, or category — used in collections prioritisation and treatment selection.`, confidence: "Low" };
  }
  if ((has("balance", "amount", "gbp", "value") || lower.includes("_gbp")) && (cat.includes("payment") || has("payment", "paid", "received", "scheduled", "due"))) {
    return { beaconsUnderstanding: `Likely a monetary amount related to a payment transaction, scheduled amount, or repayment balance, used in payment reconciliation and arrears progression tracking.`, confidence: "Low" };
  }
  if (has("balance", "amount", "gbp", "outstanding") || lower.includes("_gbp")) {
    return { beaconsUnderstanding: `Likely a monetary value — such as outstanding balance, payment amount, or repayment figure — potentially recorded in GBP and used in arrears assessment or account management.`, confidence: "Low" };
  }
  if (has("payment", "paid", "reversal", "transaction", "allocation", "failed") && has("date", "at", "when")) {
    return { beaconsUnderstanding: `Likely the date associated with a payment event — such as payment received date or due date — used in repayment tracking and delinquency assessment.`, confidence: "Low" };
  }
  if (has("payment", "paid", "reversal", "transaction", "allocation", "failed")) {
    return { beaconsUnderstanding: `Likely relates to a payment transaction, repayment status, or payment behaviour metric, used in arrears management and collections strategy.`, confidence: "Low" };
  }
  if (has("active") || has("enabled", "current")) {
    return { beaconsUnderstanding: `Likely indicates whether this account, treatment, or status is currently active, which may affect applicable servicing rules and collections handling.`, confidence: "Low" };
  }
  if (has("date", "timestamp") || lower.endsWith("_at") || lower.endsWith("_date")) {
    return { beaconsUnderstanding: `Likely a date associated with a key account or customer event — such as last contact date, payment date, or status change — used in operational tracking and follow-up scheduling.`, confidence: "Low" };
  }
  if (has("agent", "advisor", "handler", "user")) {
    return { beaconsUnderstanding: `Likely identifies the agent or advisor responsible for handling this account or interaction, used in operational reporting and workload management.`, confidence: "Low" };
  }
  if (has("count", "num", "qty", "consecutive", "quantity") || lower.endsWith("_count")) {
    return { beaconsUnderstanding: `Likely a count of occurrences — such as contact attempts, missed payments, or plan instances — used in operational analysis and collections strategy.`, confidence: "Low" };
  }
  if (has("status", "state", "stage") || lower.endsWith("_status")) {
    const ctx = cat.includes("payment") ? "payment" : cat.includes("contact") || cat.includes("conversation") ? "contact or interaction" : "account or customer";
    return { beaconsUnderstanding: `Likely a coded or labelled status used to track the current state of the ${ctx}, informing operational workflow and treatment decisions.`, confidence: "Low" };
  }
  if (has("ref", "reference") || lower.endsWith("_ref") || lower.endsWith("_id")) {
    return { beaconsUnderstanding: `Likely a reference identifier linking this record to an associated account, customer, or operational event — used for traceability and record linkage.`, confidence: "Low" };
  }

  // Last resort — domain-aware, never a bare datatype label
  const domainContext = cat.includes("payment")
    ? "payment processing, repayment tracking, or arrears reconciliation"
    : cat.includes("contact") || cat.includes("conversation") || cat.includes("communication")
    ? "customer contact activity, engagement strategy, or collections outreach"
    : cat.includes("customer")
    ? "customer identity, affordability, or vulnerability assessment"
    : cat.includes("arrangement") || cat.includes("forbearance")
    ? "repayment arrangement or forbearance treatment"
    : "account management, collections strategy, or servicing operations";
  const humanReadable = header.replace(/[_-]/g, " ");
  return {
    beaconsUnderstanding: `Likely relates to ${domainContext}. The exact business meaning of "${humanReadable}" could not be confidently determined from the available evidence.`,
    confidence: "Low",
  };
}

export async function analyzeCategoryFields(
  categoryId: string,
  headers: string[],
  columnEvidence: ColumnEvidence[]
): Promise<Array<{ fieldName: string; beaconsUnderstanding: string; confidence: 'High' | 'Medium' | 'Low' }>> {
  const categoryLabel = categoryId.replace(/_/g, ' ');

  console.log(`[analyzeCategoryFields] entry category=${categoryId} fieldCount=${headers.length} evidenceCount=${columnEvidence.length}`);

  // ── Build header lookup maps (shared across both passes) ──────────────────
  const headerExact  = new Map<string, string>();
  const headerLower  = new Map<string, string>();
  const headerNormMap = new Map<string, string>();
  for (const h of headers) {
    headerExact.set(h, h);
    if (!headerLower.has(h.toLowerCase())) headerLower.set(h.toLowerCase(), h);
    const nk = normaliseKey(h);
    if (!headerNormMap.has(nk)) headerNormMap.set(nk, h);
  }

  const resolvedMap = new Map<string, FieldAnalysisItem>();

  // ── Helper: validate, filter weak, match to header, add to resolvedMap ────
  // Header matching runs first so the restatement check uses the resolved
  // original header's normalisation (stricter than the model-returned key).
  const mergeItems = (items: FieldAnalysisItem[], pass: string): void => {
    for (const item of items) {
      const orig = matchHeader(item.fieldName, headerExact, headerLower, headerNormMap);
      if (!orig) {
        console.warn(`[analyzeCategoryFields] stage=header_matching pass=${pass} category=${categoryId} headers=${headers.length} fieldName=${item.fieldName}`);
        continue;
      }
      if (isWeakDescription(item.beaconsUnderstanding, normaliseKey(orig))) {
        console.warn(`[analyzeCategoryFields] stage=weak_description pass=${pass} category=${categoryId} headers=${headers.length} fieldName=${item.fieldName} desc=${item.beaconsUnderstanding.slice(0, 80)}`);
        continue;
      }
      if (resolvedMap.has(orig)) {
        console.warn(`[analyzeCategoryFields] stage=duplicate pass=${pass} category=${categoryId} headers=${headers.length} fieldName=${item.fieldName} resolvedTo=${orig} (keeping first)`);
      } else {
        resolvedMap.set(orig, { ...item, fieldName: orig });
      }
    }
  };

  // ── FIRST PASS ────────────────────────────────────────────────────────────
  const evidenceStr = buildEvidenceStr(columnEvidence);
  const firstPassPrompt = buildFirstPassPrompt(categoryLabel, evidenceStr);

  const firstPassResponse = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: firstPassPrompt }] }],
    config: { maxOutputTokens: 16384, responseMimeType: "application/json" },
  });

  const firstPassRaw = firstPassResponse.text || "";
  const firstPassItems = parseAIResponse(firstPassRaw, categoryId, headers.length, "first_pass");
  mergeItems(firstPassItems, "first_pass");

  const firstPassWeakCount = headers.filter(h => !resolvedMap.has(h)).length;

  // ── REPAIR PASS — only for unresolved fields ──────────────────────────────
  const unresolvedAfterFirst = headers.filter(h => !resolvedMap.has(h));
  let repairRequestedCount = 0;
  let repairRecoveredCount = 0;

  if (unresolvedAfterFirst.length > 0) {
    repairRequestedCount = unresolvedAfterFirst.length;
    console.log(`[analyzeCategoryFields] stage=repair_triggered category=${categoryId} weakCount=${repairRequestedCount}`);

    const weakEvidence = unresolvedAfterFirst.map(h =>
      columnEvidence.find(c => c.fieldName === h) ??
      { fieldName: h, sampleValues: [], inferredType: 'categorical' as const }
    );

    const repairPrompt = buildRepairPrompt(categoryLabel, weakEvidence);
    const repairResponse = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: repairPrompt }] }],
      config: { maxOutputTokens: 16384, responseMimeType: "application/json" },
    });

    const repairRaw = repairResponse.text || "";
    const repairItems = parseAIResponse(repairRaw, categoryId, unresolvedAfterFirst.length, "repair");
    const beforeRepair = resolvedMap.size;
    mergeItems(repairItems, "repair");
    repairRecoveredCount = resolvedMap.size - beforeRepair;

    console.log(`[analyzeCategoryFields] stage=repair_result category=${categoryId} recoveredCount=${repairRecoveredCount}`);
  }

  // ── FALLBACK — only for fields still unresolved after repair ──────────────
  const unresolvedAfterRepair = headers.filter(h => !resolvedMap.has(h));
  const fallbackCount = unresolvedAfterRepair.length;

  for (const h of unresolvedAfterRepair) {
    const fb = buildDomainFallback(h, categoryLabel);
    resolvedMap.set(h, { fieldName: h, beaconsUnderstanding: fb.beaconsUnderstanding, confidence: fb.confidence });
  }

  // ── Assemble final results (preserving exact original header order) ────────
  const results = headers.map(h => {
    const item = resolvedMap.get(h)!;
    return { fieldName: h, beaconsUnderstanding: item.beaconsUnderstanding, confidence: item.confidence };
  });

  // ── Exit summary log (always emits all 7 fields) ──────────────────────────
  const fallbackPercent = Math.round((fallbackCount / headers.length) * 100);
  console.log(`[analyzeCategoryFields] summary category=${categoryId} fieldCount=${headers.length} firstPassWeakCount=${firstPassWeakCount} repairRequestedCount=${repairRequestedCount} repairRecoveredCount=${repairRecoveredCount} fallbackCount=${fallbackCount} fallbackPercent=${fallbackPercent}%`);

  return results;
}

export interface SOPExtractedRule {
  fieldName: string;
  operator: string;
  value: string;
}

export interface SOPExtractedTreatment {
  name: string;
  shortDescription: string;
  whenToOffer: SOPExtractedRule[];
  blockedIf: SOPExtractedRule[];
}

// ─── Zod schemas for AI-driven treatment draft generation ─────────────────────

// Symbol-to-word operator map — applied only in the SOP ingestion path
const SYMBOL_TO_WORD_OPERATOR: Record<string, string> = {
  "=": "equals",
  "!=": "not_equals",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

const UNARY_OPERATORS = new Set(["is_true", "is_false", "exists", "not_exists"]);

function normalizeRuleItem(rule: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...rule };
  if (typeof normalized.operator === "string" && SYMBOL_TO_WORD_OPERATOR[normalized.operator]) {
    normalized.operator = SYMBOL_TO_WORD_OPERATOR[normalized.operator];
  }
  if (typeof normalized.operator === "string" && UNARY_OPERATORS.has(normalized.operator)) {
    if (normalized.value == null) {
      delete normalized.value;
    }
  }
  return normalized;
}

const WORD_TO_SYMBOL_OPERATOR: Record<string, string> = {
  equals: "=",
  not_equals: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function normalizeDerivationCondition(cond: unknown): unknown {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return cond;
  const c = cond as Record<string, unknown>;
  if ("field" in c) {
    if (typeof c.operator === "string" && WORD_TO_SYMBOL_OPERATOR[c.operator]) {
      return { ...c, operator: WORD_TO_SYMBOL_OPERATOR[c.operator] };
    }
    return c;
  }
  if ("conditions" in c && Array.isArray(c.conditions)) {
    return { ...c, conditions: c.conditions.map(normalizeDerivationCondition) };
  }
  return c;
}

function normalizeDerivationConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const cfg = config as Record<string, unknown>;
  if (!Array.isArray(cfg.conditions)) return cfg;
  return { ...cfg, conditions: cfg.conditions.map(normalizeDerivationCondition) };
}

function normalizeDerivedField(obj: Record<string, unknown>): Record<string, unknown> {
  const n = { ...obj };
  if (n.depends_on === null) n.depends_on = [];
  if (n.derivation_config !== null && n.derivation_config !== undefined) {
    n.derivation_config = normalizeDerivationConfig(n.derivation_config);
  }
  return n;
}

function normalizeBusinessField(obj: Record<string, unknown>): Record<string, unknown> {
  const n = { ...obj };
  if (n.allowed_values === null) n.allowed_values = [];
  return n;
}

function normalizeTreatmentItem(obj: Record<string, unknown>): Record<string, unknown> {
  const n = { ...obj };
  if (Array.isArray(n.derived_fields)) {
    n.derived_fields = n.derived_fields.map((df: unknown) =>
      df && typeof df === "object" && !Array.isArray(df)
        ? normalizeDerivedField(df as Record<string, unknown>)
        : df
    );
  }
  if (Array.isArray(n.business_fields)) {
    n.business_fields = n.business_fields.map((bf: unknown) =>
      bf && typeof bf === "object" && !Array.isArray(bf)
        ? normalizeBusinessField(bf as Record<string, unknown>)
        : bf
    );
  }
  return n;
}

const coerceToString = z.preprocess(
  (v) => (v === null || v === undefined) ? "" : (typeof v === "boolean" || typeof v === "number") ? String(v) : v,
  z.string()
);

const _ruleCommon = {
  field_name: z.string(),
  field_type: z.enum(["source", "derived", "business"]).optional(),
  reason: z.string().optional(),
};

const UnaryRuleSchema = z.object({
  ..._ruleCommon,
  operator: z.enum(["is_true", "is_false", "exists", "not_exists"]),
}).strict();

const EqualityRuleSchema = z.object({
  ..._ruleCommon,
  operator: z.enum(["equals", "not_equals"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const SetRuleSchema = z.object({
  ..._ruleCommon,
  operator: z.enum(["in", "not_in"]),
  value: z.array(z.union([z.string(), z.number(), z.boolean()])),
});

const NumericRuleSchema = z.object({
  ..._ruleCommon,
  operator: z.enum(["gt", "gte", "lt", "lte"]),
  value: z.number(),
});

const RuleItemSchema = z.union([
  UnaryRuleSchema,
  EqualityRuleSchema,
  SetRuleSchema,
  NumericRuleSchema,
]);

const AIDerivedFieldSchema = z.object({
  field_name: z.string(),
  display_name: coerceToString,
  description: coerceToString,
  data_type: z.enum(["boolean", "number", "string", "enum"]).default("boolean"),
  depends_on: z.array(z.string()).default([]),
  derivation_config: LogicalDerivationConfigSchema.nullable().default(null),
  derivation_summary: coerceToString,
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});

const AIBusinessFieldSchema = z.object({
  field_name: z.string(),
  display_name: coerceToString,
  description: coerceToString,
  data_type: z.enum(["boolean", "number", "string", "enum"]).default("string"),
  allowed_values: z.array(z.string()).default([]),
  default_value: coerceToString,
  business_meaning: coerceToString,
});

export const DraftTreatmentItemSchema = z.object({
  name: z.string(),
  description: coerceToString,
  when_to_offer_logic: z.enum(["ALL", "ANY"]).catch("ALL"),
  when_to_offer: z.array(RuleItemSchema).default([]),
  blocked_if_logic: z.enum(["ALL", "ANY"]).catch("ANY"),
  blocked_if: z.array(RuleItemSchema).default([]),
  source_fields: z.array(z.object({
    field_name: z.string(),
    description: coerceToString,
    matched_existing_field: z.boolean().default(false),
  })).default([]),
  derived_fields: z.array(AIDerivedFieldSchema).default([]),
  business_fields: z.array(AIBusinessFieldSchema).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});

const GlobalSourceFieldSchema = z.object({
  field_name: z.string(),
  description: coerceToString,
});

const GlobalDerivedFieldSchema = AIDerivedFieldSchema;
const GlobalBusinessFieldSchema = AIBusinessFieldSchema;

export type AIDerivedField = z.infer<typeof AIDerivedFieldSchema>;
export type AIBusinessField = z.infer<typeof AIBusinessFieldSchema>;

const DraftResponseSchema = z.object({
  summary: coerceToString,
  treatments: z.array(DraftTreatmentItemSchema).default([]),
  global_source_fields: z.array(GlobalSourceFieldSchema).default([]),
  global_derived_fields: z.array(GlobalDerivedFieldSchema).default([]),
  global_business_fields: z.array(GlobalBusinessFieldSchema).default([]),
  open_questions: z.array(z.string()).default([]),
});

export type ValidatedDraftResponse = z.infer<typeof DraftResponseSchema>;

export async function extractTextFromPdfWithVision(buffer: Buffer): Promise<string> {
  const base64 = buffer.toString("base64");
  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64,
          },
        },
        {
          text: "Extract all text content from this PDF document. Return the raw text only, preserving structure (headings, lists, paragraphs). Do not summarize or interpret — just extract the text as-is.",
        },
      ],
    }],
    config: { maxOutputTokens: 16384 },
  });
  return response.text?.trim() || "";
}

export async function generateTreatmentDraft(
  sopBundle: string,
  fieldCatalog: { label: string; sourceType: string; description: string | null; derivationSummary: string | null }[]
): Promise<ValidatedDraftResponse> {
  const fieldCatalogText = fieldCatalog.length === 0
    ? "No fields configured yet."
    : fieldCatalog.map(f => {
        const typeLabel = f.sourceType === "source_field" ? "Source Field"
          : f.sourceType === "derived_field" ? "Derived Field"
          : "Business Field";
        const desc = f.description ? ` — ${f.description}` : "";
        const derived = f.derivationSummary ? ` [Derived from: ${f.derivationSummary}]` : "";
        return `- ${f.label} (${typeLabel})${desc}${derived}`;
      }).join("\n");

  const prompt = `You are Beacon's SOP-to-treatment configuration engine.

Your task is to read one or more uploaded SOP / policy documents and generate a complete, executable Beacon treatment configuration.

Beacon already has a configured field catalog for this client.
You must use that field catalog when mapping policy logic.

Your goal is to generate a system-consumable treatment draft with:
- Treatment definitions
- When to Offer rules (eligibility)
- Blocked If rules (safety guards)
- Source fields (already in catalog)
- Derived fields (with EXECUTABLE derivation_config, not formula hints)
- Business fields (with allowed values and business meaning)

IMPORTANT RULES
1. Only create treatments that are clearly supported by the SOP documents.
2. Use configured Beacon source fields wherever possible.
3. Do NOT invent a new source field that is not present in the provided Beacon field catalog.
4. If the SOP refers to a concept not present as a configured source field:
  - classify it as a Derived Field if it can be computed from existing fields (must include a derivation_config)
  - classify it as a Business Field if it is user-entered, policy-defined, or judgement-based
5. Reuse existing business fields or derived fields already in the Beacon field catalog.
6. Keep rules structured and implementation-friendly.
7. If the SOP is ambiguous or you cannot determine the derivation logic with confidence, put the field in open_questions with a clear reason. Do NOT invent logic or guess.
8. You MUST always generate a complete draft — never leave treatments empty due to ambiguity. Put ambiguities in open_questions.
9. Return JSON only. No markdown formatting, no code blocks, just raw JSON.
10. For each treatment, you MUST also set:
  - "when_to_offer_logic": "ALL" if ALL listed conditions must be true (eligibility); "ANY" if any one is sufficient.
  - "blocked_if_logic": "ANY" if ANY single blocker should block the treatment (most common); "ALL" only if ALL must be true simultaneously.
  Default: when_to_offer = "ALL", blocked_if = "ANY". Override only when SOP wording clearly implies otherwise.
11. For derived fields, you MUST provide a structured derivation_config — not a formula hint. If you cannot determine the exact logic, set derivation_config to null and add the field to open_questions.
12. Derived field depends_on must only reference fields from the Beacon field catalog or other derived/business fields defined in the same output.

FIELD TYPE DEFINITIONS
- Source Field: already in the Beacon field catalog, directly usable in rules
- Derived Field: computed from existing fields using logical conditions
- Business Field: manually entered or policy-defined, not computed

RULE FORMAT
{
 "field_name": "string — must match a field in the catalog or a derived/business field defined in this output",
 "field_type": "source|derived|business",
 "operator": "one of the operators below — choose the correct class for the field type",
 "value": "see per-operator requirements below",
 "reason": "short explanation"
}

OPERATOR CLASSES (use exactly these operator strings):
- Unary (boolean flags — NO value field, omit value entirely):
    is_true, is_false, exists, not_exists
    Example: { "operator": "is_true" }  — do NOT include "value" at all
- Equality (scalar value required — string, number, or boolean):
    equals, not_equals
    Example: { "operator": "equals", "value": "High" }
- Set membership (array value required):
    in, not_in
    Example: { "operator": "in", "value": ["High", "Medium"] }
- Numeric comparison (number value required):
    gt, gte, lt, lte
    Example: { "operator": "gte", "value": 3 }

DERIVATION CONFIG FORMAT (for derived fields only)
{
 "type": "logical",
 "operator": "AND|OR",
 "conditions": [
   {
     "field": "source_field_name",
     "fieldType": "source|derived|business",
     "operator": "=|!=|>|>=|<|<=|in|not_in|contains|is_true|is_false",
     "value": "string or number or array — omit entirely for is_true/is_false"
   }
 ]
}

DERIVED FIELD FORMAT
{
 "field_name": "snake_case_name",
 "display_name": "Human Readable Name",
 "description": "what this field represents",
 "data_type": "boolean|number|string|enum",
 "depends_on": ["source_field_a", "source_field_b"],
 "derivation_config": { DERIVATION CONFIG or null if ambiguous },
 "derivation_summary": "plain english description of the logic",
 "confidence": "high|medium|low"
}

BUSINESS FIELD FORMAT
{
 "field_name": "snake_case_name",
 "display_name": "Human Readable Name",
 "description": "what this field captures",
 "data_type": "boolean|number|string|enum",
 "allowed_values": ["value1", "value2"] or [],
 "default_value": "default if applicable",
 "business_meaning": "why this field exists and how it is used"
}

OUTPUT JSON SCHEMA
{
 "summary": "short summary of the SOP treatment framework",
 "treatments": [
   {
     "name": "string",
     "description": "string",
     "when_to_offer_logic": "ALL",
     "when_to_offer": [RULE],
     "blocked_if_logic": "ANY",
     "blocked_if": [RULE],
     "source_fields": [{ "field_name": "string", "description": "string", "matched_existing_field": true }],
     "derived_fields": [DERIVED FIELD FORMAT],
     "business_fields": [BUSINESS FIELD FORMAT],
     "confidence": "high|medium|low"
   }
 ],
 "global_source_fields": [{ "field_name": "string", "description": "string" }],
 "global_derived_fields": [DERIVED FIELD FORMAT],
 "global_business_fields": [BUSINESS FIELD FORMAT],
 "open_questions": ["field_name: reason why this could not be resolved"]
}

BEACON FIELD CATALOG
${fieldCatalogText}

SOP DOCUMENTS
${sopBundle}

Now generate the Beacon treatment draft.
Return JSON only. Do not include any markdown formatting or code blocks.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 16384, temperature: 0.3 },
  });

  const rawText = response.text?.trim() || "{}";

  let jsonText = rawText;
  if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("AI returned invalid JSON — cannot parse treatment draft");
  }

  // Pre-parse normalization: coerce null arrays → [] so Zod .default([]) works
  // (string fields are handled by coerceToString at schema level)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;

    // Null arrays at top level
    if (raw.open_questions === null) raw.open_questions = [];
    if (raw.global_source_fields === null) raw.global_source_fields = [];
    if (raw.global_derived_fields === null) raw.global_derived_fields = [];
    if (raw.global_business_fields === null) raw.global_business_fields = [];

    // Global derived/business field arrays (depends_on, allowed_values, derivation_config)
    if (Array.isArray(raw.global_derived_fields)) {
      raw.global_derived_fields = raw.global_derived_fields.map((df: unknown) =>
        df && typeof df === "object" && !Array.isArray(df)
          ? normalizeDerivedField(df as Record<string, unknown>)
          : df
      );
    }
    if (Array.isArray(raw.global_business_fields)) {
      raw.global_business_fields = raw.global_business_fields.map((bf: unknown) =>
        bf && typeof bf === "object" && !Array.isArray(bf)
          ? normalizeBusinessField(bf as Record<string, unknown>)
          : bf
      );
    }

    // Treatments: normalize metadata fields + rule items
    if (Array.isArray(raw.treatments)) {
      raw.treatments = raw.treatments.map((t: unknown) => {
        if (!t || typeof t !== "object" || Array.isArray(t)) return t;
        const treatment = t as Record<string, unknown>;
        const normalizeRules = (rules: unknown) =>
          Array.isArray(rules)
            ? rules.map((r: unknown) =>
                r && typeof r === "object" && !Array.isArray(r)
                  ? normalizeRuleItem(r as Record<string, unknown>)
                  : r
              )
            : rules;
        return {
          ...normalizeTreatmentItem(treatment),
          when_to_offer: normalizeRules(treatment.when_to_offer),
          blocked_if: normalizeRules(treatment.blocked_if),
        };
      });
    }
  }

  const result = DraftResponseSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path?.join(".") || "unknown";
    throw Object.assign(
      new Error(`AI output did not match the expected treatment schema (field: ${path} — ${firstIssue?.message}). Try again or adjust your SOP document.`),
      { isValidationError: true, zodErrors: result.error.issues }
    );
  }
  return result.data;
}

export async function extractSOPTreatments(fileText: string): Promise<SOPExtractedTreatment[]> {
  const prompt = `You are an expert collections policy analyst. A client has provided a Standard Operating Procedure (SOP) or policy document for their debt collections process.

Analyze the document and extract each distinct treatment or action that can be offered to customers.

For each treatment extract:
- name: Short treatment name (e.g. "Payment Holiday", "Loan Restructure", "Clear Arrears Plan")
- shortDescription: 1-2 sentence description of the treatment
- whenToOffer: Array of conditions (as structured rules) for when this treatment should be recommended. Each condition has:
  - fieldName: the data field being evaluated (use realistic field names like "dpd_bucket", "affordability", "willingness", "balance_outstanding" etc.)
  - operator: one of: =, !=, >, >=, <, <=, contains
  - value: the value to compare against
- blockedIf: Array of conditions (same structure) that would block this treatment even if whenToOffer is met

Important rules:
- Focus on TREATMENTS only (forbearance, restructure, payment plans, write-offs, etc.)
- Do NOT extract vulnerability, escalation, or DPD stage definitions as treatments
- whenToOffer and blockedIf should have 1-4 conditions each based on what the document says
- If the document does not specify blocking conditions, return an empty array for blockedIf
- If the document is vague, make reasonable inferences based on standard collections practice
- Extract 2-8 treatments maximum

Document text:
"""
${fileText.slice(0, 12000)}
"""

Respond ONLY with a valid JSON array of treatment objects. Example:
[{
  "name": "Payment Holiday",
  "shortDescription": "Temporarily pause payments for customers facing short-term financial difficulty.",
  "whenToOffer": [
    {"fieldName": "affordability", "operator": "=", "value": "VERY LOW"},
    {"fieldName": "willingness", "operator": "!=", "value": "VERY LOW"}
  ],
  "blockedIf": [
    {"fieldName": "active_insolvency", "operator": "=", "value": "Yes"}
  ]
}]`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 8192 },
  });

  const text = response.text || "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as SOPExtractedTreatment[];
    } catch {
      // fall through
    }
  }
  return [];
}
