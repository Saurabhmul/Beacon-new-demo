import type { DecisionPacket } from "./decision-packet";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const REQUIRED_KEYS = [
  "customer_guid",
  "recommended_treatment_name",
  "recommended_treatment_code",
  "requires_agent_review",
  "customer_summary",
  "treatment_decision",
  "decision_factors",
  "internal_action",
  "internal_action_rationale",
  "proposed_next_best_action",
  "proposed_email_to_customer",
] as const;

const DECISION_FACTORS_ARRAY_KEYS = [
  "source_fields_used",
  "derived_fields_used",
  "business_fields_used",
  "missing_information",
  "key_factors",
  "rules_applied",
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

  if (typeof parsed.customer_summary !== "string") {
    errors.push("customer_summary must be a string");
  }

  if (typeof parsed.requires_agent_review !== "boolean") {
    errors.push("requires_agent_review must be a boolean");
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
    } else {
      const treatmentName = parsed.recommended_treatment_name;
      if (typeof treatmentName !== "string") {
        errors.push("recommended_treatment_name must be a string");
      } else {
        if (treatmentCode === "AGENT_REVIEW" || treatmentCode === "NO_ACTION") {
          const expectedName = treatmentCode === "AGENT_REVIEW" ? "Agent Review" : "No Action";
          if (treatmentName !== expectedName) {
            errors.push(
              `recommended_treatment_name must be "${expectedName}" when code is "${treatmentCode}", got "${treatmentName}"`
            );
          }
        } else {
          const matchedTreatment = packet.policy.treatments.find(t => t.code === treatmentCode);
          if (matchedTreatment && treatmentName !== matchedTreatment.name) {
            errors.push(
              `recommended_treatment_name "${treatmentName}" does not match configured name "${matchedTreatment.name}" for code "${treatmentCode}"`
            );
          }
        }
      }
    }
  }

  if (typeof parsed.treatment_decision !== "object" || parsed.treatment_decision === null || Array.isArray(parsed.treatment_decision)) {
    errors.push("treatment_decision must be an object");
  } else {
    const td = parsed.treatment_decision as Record<string, unknown>;
    if (typeof td["selected_treatment"] !== "string") errors.push("treatment_decision.selected_treatment must be a string");
    if (typeof td["decision_status"] !== "string") errors.push("treatment_decision.decision_status must be a string");
    if (typeof td["treatment_rationale"] !== "string") errors.push("treatment_decision.treatment_rationale must be a string");
  }

  if (typeof parsed.decision_factors !== "object" || parsed.decision_factors === null || Array.isArray(parsed.decision_factors)) {
    errors.push("decision_factors must be an object");
  } else {
    const df = parsed.decision_factors as Record<string, unknown>;
    for (const key of DECISION_FACTORS_ARRAY_KEYS) {
      if (!(key in df)) {
        (df as Record<string, unknown>)[key] = [];
      } else if (!Array.isArray(df[key])) {
        errors.push(`decision_factors.${key} must be an array`);
      }
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
