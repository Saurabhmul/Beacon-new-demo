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
}

export async function analyzeCustomer(
  customerData: Record<string, unknown>,
  sopText: string,
  promptTemplate?: string
): Promise<AIDecisionOutput> {
  const systemPrompt = `You are an AI decision engine for early delinquency management. You must analyze customer data against the provided Standard Operating Procedure (SOP) rules.

${sopText ? `SOP / RULEBOOK:\n${sopText}\n\n` : ""}${promptTemplate || ""}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code blocks, no explanation outside the JSON.

Required JSON output format:
{
  "customer_guid": "the customer ID from the input data",
  "payment_history": "<last 3 months payment history summarized in <=3 lines>",
  "conversation": "<last 6 months conversation summarized in <=3 lines relevant for the next best action in collections>",
  "vulnerability": <true or false>,
  "reason_for_vulnerability": "<if vulnerable, string max 5 lines explaining why, otherwise empty string>",
  "affordability": "<high/medium/low/very low/not sure>",
  "reason_for_affordability": "<string max 5 lines>",
  "willingness": "<high/medium/low/very low/not sure>",
  "reason_for_willingness": "<string max 5 lines>",
  "ability_to_pay": <number or null>,
  "reason_for_ability_to_pay": "<string max 5 lines justification>",
  "problem_description": "<max 5 lines describing the problem customer is facing>",
  "problem_confidence_score": <integer 1-10>,
  "problem_evidence": "<max 5 lines citing specific data>",
  "proposed_solution": "<max 5 lines>",
  "solution_confidence_score": <integer 1-10>,
  "solution_evidence": "<max 5 lines>",
  "internal_action": "<max 5 lines>",
  "proposed_email_to_customer": "<full email text with Subject: and Body: OR 'NO_ACTION'>"
}`;

  const userMessage = `Analyze this customer data and provide your decision:\n\n${JSON.stringify(customerData, null, 2)}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "I understand. I will analyze customer data against the SOP and respond with valid JSON only." }] },
      { role: "user", parts: [{ text: userMessage }] },
    ],
    config: { maxOutputTokens: 8192 },
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

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      customer_guid: parsed.customer_guid || String(customerData["customer / account / loan id"] || customerData.customer_id || customerData.account_id || "unknown"),
      payment_history: parsed.payment_history || "",
      conversation: parsed.conversation || "",
      vulnerability: parsed.vulnerability === true || parsed.vulnerability === "true",
      reason_for_vulnerability: parsed.reason_for_vulnerability || "",
      affordability: parsed.affordability || "not sure",
      reason_for_affordability: parsed.reason_for_affordability || "",
      willingness: parsed.willingness || "not sure",
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
    };
  } catch (e) {
    return {
      customer_guid: String(customerData["customer / account / loan id"] || customerData.customer_id || customerData.account_id || "unknown"),
      payment_history: "",
      conversation: "",
      vulnerability: false,
      reason_for_vulnerability: "",
      affordability: "not sure",
      reason_for_affordability: "",
      willingness: "not sure",
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
    };
  }
}

export async function extractTextFromImage(base64Data: string, mimeType: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
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
