import type { DecisionPacket } from "./decision-packet";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const REQUIRED_KEYS = [
  "customer_guid",
  "customer_situation",
  "customer_situation_confidence_score",
  "customer_situation_evidence",
  "used_fields",
  "used_rules",
  "missing_information",
  "key_factors_considered",
  "structured_assessments",
  "recommended_treatment_name",
  "recommended_treatment_code",
  "proposed_next_best_action",
  "treatment_eligibility_explanation",
  "blocked_conditions",
  "proposed_next_best_confidence_score",
  "proposed_next_best_evidence",
  "requires_agent_review",
  "internal_action",
  "proposed_email_to_customer",
] as const;

export function validateFinalDecisionOutput(
  parsed: Record<string, unknown> | null,
  packet: DecisionPacket
): ValidationResult {
  if (!parsed) {
    return { valid: false, errors: ["Response could not be parsed as JSON"] };
  }

  const errors: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) {
      errors.push(`Missing required key: ${key}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  if (typeof parsed.customer_guid !== "string") {
    errors.push("customer_guid must be a string");
  }
  if (typeof parsed.customer_situation !== "string") {
    errors.push("customer_situation must be a string");
  }

  const situationScore = parsed.customer_situation_confidence_score;
  if (typeof situationScore !== "number" || !Number.isInteger(situationScore) || situationScore < 1 || situationScore > 10) {
    errors.push("customer_situation_confidence_score must be an integer 1–10");
  }

  const nbsScore = parsed.proposed_next_best_confidence_score;
  if (typeof nbsScore !== "number" || !Number.isInteger(nbsScore) || nbsScore < 1 || nbsScore > 10) {
    errors.push("proposed_next_best_confidence_score must be an integer 1–10");
  }

  if (typeof parsed.requires_agent_review !== "boolean") {
    errors.push("requires_agent_review must be a boolean");
  }

  if (!Array.isArray(parsed.used_fields)) errors.push("used_fields must be an array");
  if (!Array.isArray(parsed.used_rules)) errors.push("used_rules must be an array");
  if (!Array.isArray(parsed.missing_information)) errors.push("missing_information must be an array");
  if (!Array.isArray(parsed.key_factors_considered)) errors.push("key_factors_considered must be an array");
  if (!Array.isArray(parsed.blocked_conditions)) errors.push("blocked_conditions must be an array");

  if (!Array.isArray(parsed.structured_assessments)) {
    errors.push("structured_assessments must be an array");
  } else {
    const validItems: unknown[] = [];
    for (const item of parsed.structured_assessments as unknown[]) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (
          "name" in obj &&
          "value" in obj &&
          "reason" in obj &&
          typeof obj["name"] === "string" &&
          (typeof obj["value"] === "string" || obj["value"] === null) &&
          typeof obj["reason"] === "string"
        ) {
          validItems.push(item);
        }
      }
    }
    parsed.structured_assessments = validItems;
  }

  const treatmentCode = parsed.recommended_treatment_code;
  if (typeof treatmentCode !== "string") {
    errors.push("recommended_treatment_code must be a string");
  } else {
    const validCodes = new Set([
      ...packet.policy.treatments.map(t => t.code),
      "AGENT_REVIEW",
      "NO_ACTION",
    ]);
    if (!validCodes.has(treatmentCode)) {
      errors.push(
        `recommended_treatment_code "${treatmentCode}" is not a valid configured treatment code, AGENT_REVIEW, or NO_ACTION`
      );
    }
  }

  const email = parsed.proposed_email_to_customer;
  if (typeof email !== "string") {
    errors.push("proposed_email_to_customer must be a string");
  } else if (email !== "NO_ACTION" && !(email.includes("Subject:") && email.includes("Body:"))) {
    errors.push('proposed_email_to_customer must be "NO_ACTION" or contain both "Subject:" and "Body:"');
  }

  return { valid: errors.length === 0, errors };
}

export function tryParseDecisionJson(text: string): Record<string, unknown> | null {
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
