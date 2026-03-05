import { GoogleGenAI } from "@google/genai";

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

export async function analyzeCustomer(
  customerData: Record<string, unknown>,
  assembledPrompt: string
): Promise<AIDecisionOutput> {
  const systemPrompt = assembledPrompt;

  const userMessage = `Analyze this customer data and provide your decision:\n\n${JSON.stringify(customerData, null, 2)}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "I understand. I will analyze customer data against the SOP and respond with valid JSON only." }] },
      { role: "user", parts: [{ text: userMessage }] },
    ],
    config: { maxOutputTokens: 65536 },
  });

  const text = response.text || "";

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

  const parsed = repairAndParse(jsonStr);

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

  try {
    if (!parsed) throw new Error("Could not parse AI response");
    return {
      customer_guid: parsed.customer_guid || String(customerData["customer / account / loan id"] || customerData.customer_id || customerData.account_id || "unknown"),
      payment_history: parsed.payment_history || "",
      conversation: parsed.conversation || "",
      vulnerability: parsed.vulnerability === true || parsed.vulnerability === "true",
      reason_for_vulnerability: parsed.reason_for_vulnerability || "",
      affordability: normalizeLabel(parsed.affordability),
      reason_for_affordability: parsed.reason_for_affordability || "",
      willingness: normalizeLabel(parsed.willingness),
      reason_for_willingness: parsed.reason_for_willingness || "",
      ability_to_pay: parsed.ability_to_pay ?? null,
      reason_for_ability_to_pay: parsed.reason_for_ability_to_pay || "",
      problem_description: parsed.problem_description || parsed["problem_customer is facing"] || parsed.problem_customer_is_facing || "",
      problem_confidence_score: Math.min(10, Math.max(1, parseInt(parsed.problem_confidence_score) || 5)),
      problem_evidence: parsed.problem_evidence || "",
      proposed_solution: parsed.proposed_solution || "",
      solution_confidence_score: Math.min(10, Math.max(1, parseInt(parsed.solution_confidence_score) || 5)),
      solution_evidence: parsed.solution_evidence || "",
      internal_action: parsed.internal_action || "",
      proposed_email_to_customer: parsed.proposed_email_to_customer || "NO_ACTION",
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
      affordability: "NOT SURE",
      reason_for_affordability: "",
      willingness: "NOT SURE",
      reason_for_willingness: "",
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
