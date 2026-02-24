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
  combined_cmd: number | null;
  problem_description: string;
  problem_confidence_score: number;
  problem_evidence: string;
  proposed_solution: string;
  solution_confidence_score: number;
  solution_evidence: string;
  internal_action: string;
  ability_to_pay: number | null;
  reason_for_ability_to_pay: string;
  no_of_latest_payments_failed: number;
  proposed_email_to_customer: string;
}

export async function analyzeCustomer(
  customerData: Record<string, unknown>,
  sopText: string,
  promptTemplate?: string
): Promise<AIDecisionOutput> {
  const systemPrompt = `You are an AI decision engine for early delinquency management. You must analyze customer data against the provided Standard Operating Procedure (SOP) rules.

SOP / RULEBOOK:
${sopText}

${promptTemplate || ""}

IMPORTANT: You MUST respond with valid JSON only. No markdown, no code blocks, no explanation outside the JSON.

Required JSON output format:
{
  "customer_guid": "the customer ID from the input data",
  "combined_cmd": <number or null>,
  "problem_description": "<max 5 lines describing the problem>",
  "problem_confidence_score": <integer 1-10>,
  "problem_evidence": "<max 5 lines citing specific data>",
  "proposed_solution": "<max 5 lines>",
  "solution_confidence_score": <integer 1-10>,
  "solution_evidence": "<max 5 lines>",
  "internal_action": "<max 5 lines>",
  "ability_to_pay": <number or null>,
  "reason_for_ability_to_pay": "<max 5 lines justification>",
  "no_of_latest_payments_failed": <integer>,
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
      combined_cmd: parsed.combined_cmd ?? null,
      problem_description: parsed.problem_description || "",
      problem_confidence_score: Math.min(10, Math.max(1, parseInt(parsed.problem_confidence_score) || 5)),
      problem_evidence: parsed.problem_evidence || "",
      proposed_solution: parsed.proposed_solution || "",
      solution_confidence_score: Math.min(10, Math.max(1, parseInt(parsed.solution_confidence_score) || 5)),
      solution_evidence: parsed.solution_evidence || "",
      internal_action: parsed.internal_action || "",
      ability_to_pay: parsed.ability_to_pay ?? null,
      reason_for_ability_to_pay: parsed.reason_for_ability_to_pay || "",
      no_of_latest_payments_failed: parseInt(parsed.no_of_latest_payments_failed) || 0,
      proposed_email_to_customer: parsed.proposed_email_to_customer || "NO_ACTION",
    };
  } catch (e) {
    return {
      customer_guid: String(customerData["customer / account / loan id"] || customerData.customer_id || customerData.account_id || "unknown"),
      combined_cmd: null,
      problem_description: "AI analysis could not be parsed. Raw response stored.",
      problem_confidence_score: 1,
      problem_evidence: text.substring(0, 500),
      proposed_solution: "Manual review required.",
      solution_confidence_score: 1,
      solution_evidence: "",
      internal_action: "Escalate for manual review due to AI parsing failure.",
      ability_to_pay: null,
      reason_for_ability_to_pay: "",
      no_of_latest_payments_failed: 0,
      proposed_email_to_customer: "NO_ACTION",
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
