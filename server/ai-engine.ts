import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

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

export async function analyzeCategoryFields(
  categoryId: string,
  headers: string[],
  sampleRows: Record<string, string>[]
): Promise<Array<{ fieldName: string; beaconsUnderstanding: string; confidence: 'High' | 'Medium' | 'Low' }>> {
  const categoryLabel = categoryId.replace(/_/g, ' ');
  const sampleStr = sampleRows.length > 0
    ? `\nSample data rows:\n${sampleRows.map((r, i) => `Row ${i + 1}: ${JSON.stringify(r)}`).join('\n')}`
    : '';

  const prompt = `You are a data analyst for a financial collections software called Beacon.
A client has uploaded a sample file for the "${categoryLabel}" data category.
Analyze these column headers and describe what each field likely means in a loan collections context.

Column headers: ${headers.join(', ')}${sampleStr}

For each column, provide:
- fieldName: the exact column name as given
- beaconsUnderstanding: a clear, plain-English description (1-2 sentences) of what this field likely represents in a collections context
- confidence: "High" if the field name is self-explanatory, "Medium" if you can reasonably infer the meaning, "Low" if the name is ambiguous

Respond ONLY with a valid JSON array. Example:
[{"fieldName": "dpd_bucket", "beaconsUnderstanding": "Number of days the account is past due, grouped into buckets (e.g. 1-30, 31-60).", "confidence": "High"}]`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 4096 },
  });

  const text = response.text || "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // fall through to fallback
    }
  }
  return headers.map(h => ({
    fieldName: h,
    beaconsUnderstanding: `Field named "${h.replace(/_/g, ' ')}" — please describe what this field represents.`,
    confidence: 'Low' as const,
  }));
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

const RuleItemSchema = z.object({
  field_name: z.string(),
  field_type: z.enum(["source", "derived", "business"]).optional(),
  operator: z.string(),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
  reason: z.string().optional(),
});

const DraftTreatmentItemSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  when_to_offer: z.array(RuleItemSchema).default([]),
  blocked_if: z.array(RuleItemSchema).default([]),
  source_fields: z.array(z.object({
    field_name: z.string(),
    description: z.string().default(""),
    matched_existing_field: z.boolean().default(false),
  })).default([]),
  derived_fields: z.array(z.object({
    field_name: z.string(),
    description: z.string().default(""),
    formula_hint: z.string().default(""),
    depends_on: z.array(z.string()).default([]),
  })).default([]),
  business_fields: z.array(z.object({
    field_name: z.string(),
    description: z.string().default(""),
    allowed_values: z.array(z.string()).default([]),
  })).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});

const GlobalSourceFieldSchema = z.object({
  field_name: z.string(),
  description: z.string().default(""),
});

const GlobalDerivedFieldSchema = z.object({
  field_name: z.string(),
  description: z.string().default(""),
  formula_hint: z.string().default(""),
  depends_on: z.array(z.string()).default([]),
});

const GlobalBusinessFieldSchema = z.object({
  field_name: z.string(),
  description: z.string().default(""),
  allowed_values: z.array(z.string()).default([]),
});

const DraftResponseSchema = z.object({
  summary: z.string().default(""),
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

Your task is to read one or more uploaded SOP / policy documents and generate a draft Beacon treatment configuration.

Beacon already has a configured field catalog for this client.
You must use that field catalog when mapping policy logic.

Your goal is to generate a ready-to-fill treatment draft with:
- Treatment
- When to Offer
- Blocked If
- Source Fields
- Derived Fields
- Business Fields

IMPORTANT RULES
1. Only create treatments that are clearly supported by the SOP documents.
2. Use configured Beacon source fields wherever possible.
3. Do NOT invent a new source field that is not present in the provided Beacon field catalog.
4. If the SOP refers to a concept that is not present as a configured source field:
  - classify it as a Derived Field if it can be calculated from existing fields
  - classify it as a Business Field if it is user-entered, policy-defined, or judgement-based
5. Reuse existing business fields or derived fields if they are already present in the Beacon field catalog.
6. Keep rules structured and implementation-friendly.
7. If the SOP is ambiguous, add the uncertainty to open_questions instead of guessing.
8. You MUST always generate a complete draft — never leave treatments empty because of ambiguity. Put ambiguities in open_questions.
9. Return JSON only. No markdown formatting, no code blocks, just raw JSON.

FIELD TYPE DEFINITIONS
- Source Field: already configured in Beacon and directly usable in rules
- Derived Field: calculated from one or more Beacon fields
- Business Field: manually captured or judgement-based field

RULE FORMAT
{
 "field_name": "string",
 "field_type": "source|derived|business",
 "operator": "=|!=|>|>=|<|<=|contains|in|not_in|is_true|is_false",
 "value": "string or number or array",
 "reason": "short explanation"
}

OUTPUT JSON SCHEMA
{
 "summary": "short summary of the SOP treatment framework",
 "treatments": [
   {
     "name": "string",
     "description": "string",
     "when_to_offer": [RULE],
     "blocked_if": [RULE],
     "source_fields": [
       {
         "field_name": "string",
         "description": "string",
         "matched_existing_field": true
       }
     ],
     "derived_fields": [
       {
         "field_name": "string",
         "description": "string",
         "formula_hint": "plain english calculation logic",
         "depends_on": ["field_a", "field_b"]
       }
     ],
     "business_fields": [
       {
         "field_name": "string",
         "description": "string",
         "allowed_values": ["optional", "list"]
       }
     ],
     "confidence": "high|medium|low"
   }
 ],
 "global_source_fields": [],
 "global_derived_fields": [],
 "global_business_fields": [],
 "open_questions": ["string"]
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
