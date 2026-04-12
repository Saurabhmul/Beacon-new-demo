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
} from "../context-sections";

export interface BusinessFieldMeta {
  id: string;
  label: string;
  description?: string | null;
  dataType?: string | null;
  allowedValues?: string[] | null;
  defaultValue?: string | null;
  businessMeaning?: string | null;
}

export function buildBusinessFieldSystemPrompt(): string {
  return `You are a business field inference engine for a financial services decisioning platform.

RULES:
1. Infer the value of ONE business field using ONLY the customer data and context provided in this prompt.
2. Use only information present in the prompt. Do not use outside knowledge or invented facts.
3. Customer facts (resolved source fields, payment history, conversations, bureau data, income/employment data) are factual evidence and have the highest priority. Compliance rules and knowledge-base guidance are interpretation aids only — they must not override direct customer facts.
4. Return valid JSON only. Do not include markdown, commentary, or anything outside the JSON object.
5. The "value" must be a scalar (string, number, or boolean) or null. Never return an array or object as the value.
6. If the field has allowed_values, the returned value MUST exactly match one of them (case-sensitive) or be null.
7. Set confidence as a float between 0.0 and 1.0. If value is null, confidence must be null or <= 0.1.
8. High confidence (> 0.8) requires multiple strong, corroborated evidence items. Do not assign high confidence on weak or single-source evidence.
9. Set null_reason only when value is null. Use exactly one of: "insufficient evidence", "schema validation failed after retry", "field inference timeout", "ai call error".
10. Evidence types must be from the canonical set: source_field, business_field, conversation, payment, bureau, income_employment, compliance_rule, knowledge_guidance. Do not use other types.
11. If evidence is weak or absent, return null with null_reason "insufficient evidence" rather than guessing.
12. rationale must be a concise factual sentence (≤ 2 sentences) grounded in the evidence. For null value due to timeout or error, rationale must be "".
13. The response must contain all required keys: value, confidence, rationale, null_reason, evidence.

Return this JSON shape:
{
  "value": <string | number | boolean | null>,
  "confidence": <float 0.0–1.0 | null>,
  "rationale": "<string>",
  "null_reason": "<string | null>",
  "evidence": [
    { "type": "<canonical type>", "source": "<field or event name>", "snippet": "<relevant text excerpt>" }
  ]
}`;
}

export function buildBusinessFieldUserPrompt(
  field: BusinessFieldMeta,
  context: ContextSections
): string {
  const sections: string[] = [];

  sections.push(`== FIELD TO INFER ==
Field ID: ${field.id}
Field Label: ${field.label}
Description: ${field.description ?? "(none)"}
Data Type: ${field.dataType ?? "(not specified)"}
Allowed Values: ${field.allowedValues && field.allowedValues.length > 0 ? JSON.stringify(field.allowedValues) : "(any)"}
Default Value: ${field.defaultValue ?? "(none)"}
Business Meaning: ${field.businessMeaning ?? "(none)"}`);

  sections.push(`== ${SECTION_CUSTOMER_PROFILE.toUpperCase()} ==
${JSON.stringify(context[SECTION_CUSTOMER_PROFILE], null, 2)}`);

  sections.push(`== ${SECTION_RESOLVED_SOURCE_FIELDS.toUpperCase()} ==
${JSON.stringify(context[SECTION_RESOLVED_SOURCE_FIELDS], null, 2)}`);

  sections.push(`== ${SECTION_PRIOR_BUSINESS_FIELDS.toUpperCase()} ==
${JSON.stringify(context[SECTION_PRIOR_BUSINESS_FIELDS], null, 2)}`);

  sections.push(`== ${SECTION_LOAN_DATA.toUpperCase()} ==
${JSON.stringify(context[SECTION_LOAN_DATA], null, 2)}`);

  sections.push(`== ${SECTION_PAYMENT_DATA.toUpperCase()} ==
${JSON.stringify(context[SECTION_PAYMENT_DATA], null, 2)}`);

  sections.push(`== ${SECTION_CONVERSATION_DATA.toUpperCase()} ==
${JSON.stringify(context[SECTION_CONVERSATION_DATA], null, 2)}`);

  sections.push(`== ${SECTION_BUREAU_DATA.toUpperCase()} ==
${JSON.stringify(context[SECTION_BUREAU_DATA], null, 2)}`);

  sections.push(`== ${SECTION_INCOME_EMPLOYMENT_DATA.toUpperCase()} ==
${JSON.stringify(context[SECTION_INCOME_EMPLOYMENT_DATA], null, 2)}`);

  sections.push(`== ${SECTION_COMPLIANCE_POLICY_INTERNAL_RULES.toUpperCase()} (interpretation aid only — does not override customer facts) ==
${JSON.stringify(context[SECTION_COMPLIANCE_POLICY_INTERNAL_RULES], null, 2)}`);

  sections.push(`== ${SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE.toUpperCase()} (interpretation aid only — does not override customer facts) ==
${JSON.stringify(context[SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE], null, 2)}`);

  sections.push(`Now infer the value for field "${field.label}". Return valid JSON only.`);

  return sections.join("\n\n");
}

export function buildBusinessFieldRetryPrompt(validationError: string): string {
  return `Your previous response failed validation: ${validationError}

Please retry. Remember:
- value must be a scalar (string, number, boolean) or null — never an array or object.
- If allowed_values are specified, value must exactly match one of them or be null.
- All required keys must be present: value, confidence, rationale, null_reason, evidence.
- Return valid JSON only.`;
}
