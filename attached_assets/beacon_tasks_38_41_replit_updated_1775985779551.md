# Beacon v2.1 — Replit Instruction Block (Updated for Additional Data Categories)

## Task 38 — Business Field Inference

### Goal
Infer **all business fields configured by the client**, one by one, using AI.

This task runs **after source field resolution** and **before derived field computation**, because some derived fields depend on business fields.

### Important update
Beacon must support additional source/context categories beyond just loans, payments, conversations, and bureau.

These may include:
- income and employment data
- credit bureau data
- compliance policy / internal rules
- knowledge base / agent guidance

These categories should be treated as valid inputs across the pipeline wherever relevant.

### What Task 38 should do
For each customer:

1. Load **all client-configured business fields**
2. Infer each business field **one at a time**
3. Use **Gemini 2.5 Pro**
4. Use structured context for every field:
   - `customerProfile`
   - `loanData`
   - `paymentData`
   - `conversationData`
   - `bureauData`
   - `incomeEmploymentData`
   - `resolvedSourceFields`
   - `priorBusinessFields`
   - relevant `compliancePolicyInternalRules` if configured
   - relevant `knowledgeBaseAgentGuidance` if configured
5. Use field metadata if available:
   - `data_type`
   - `allowed_values`
   - `default_value`
   - `business_meaning`
6. Store full trace for every field:
   - inferred value
   - confidence
   - rationale
   - evidence
   - retry count
   - null reason
   - raw AI response

### Important rules
- Infer **all** client-configured business fields, not just a subset
- One AI call per business field
- If evidence is weak or contradictory, return `null`
- If `data_type` is missing:
  - use `allowed_values` if present
  - else use description / business meaning
  - else fallback to `string` unless clearly boolean-like
- If payment or conversation history is long:
  - keep the most recent items
  - keep the most significant items
  - summarize older items
  - log truncation in trace
- Use one confidence per field only
- Keep runtime safe and conservative
- Compliance / internal rules and knowledge-base guidance are context inputs, not direct truth overrides. They should help interpretation, not silently replace customer facts.

### Model settings
- Model: `gemini-2.5-pro`
- Max output tokens: `2000`

### Prompt requirement
Create prompt functions in:

- `server/lib/decisioning/prompts/business-field-prompt.ts`

Required functions:
- `buildBusinessFieldSystemPrompt()`
- `buildBusinessFieldUserPrompt(field, context)`

### Task 38 system prompt
```text
You are Beacon's business-field inference engine.

Your job is to infer exactly ONE business field for ONE customer using only the evidence provided.

You must follow these rules exactly:
1. Use only the provided evidence.
2. Do not use outside knowledge.
3. Do not use generic collections assumptions.
4. Do not use stereotypes.
5. Do not guess.
6. If the evidence is insufficient, contradictory, or too weak, return value = null.
7. If allowed_values are provided, you must return only one of those values or null.
8. If the field is effectively boolean, return only true, false, or null.
9. Your rationale must be short, factual, and based on the evidence.
10. Your evidence array must contain only evidence actually used in your reasoning.
11. Never return arrays or objects as the field value. The value must be a scalar (string, number, boolean) or null.
12. If the field type is ambiguous and cannot be safely inferred, prefer null over guessing.
13. Compliance policy, internal rules, and knowledge-base guidance help interpret the case, but do not replace customer facts.

Return valid JSON only. Do not include markdown. Do not include commentary outside the JSON object.
```

### Task 38 user prompt template
```text
Infer the following business field for this customer.

FIELD METADATA
field_id: {{field_id}}
field_label: {{field_label}}
display_name: {{display_name}}
description: {{description}}
business_meaning: {{business_meaning}}
allowed_values: {{allowed_values_json}}
default_value: {{default_value}}
data_type: {{data_type_or_null}}

IMPORTANT DATA-TYPE RULE
If data_type is missing, do not fail.
Use allowed_values if present.
If allowed_values are not present, use the field description and business meaning.
If the field still cannot be safely typed, return a string value or null only unless it is clearly boolean-like.

CUSTOMER CONTEXT

customerProfile:
{{customer_profile_json}}

loanData:
{{loan_data_json}}

paymentData:
{{payment_data_json}}

conversationData:
{{conversation_data_json}}

bureauData:
{{bureau_data_json}}

incomeEmploymentData:
{{income_employment_data_json}}

resolvedSourceFields:
{{resolved_source_fields_json}}

priorBusinessFields:
{{prior_business_fields_json}}

compliancePolicyInternalRules:
{{compliance_policy_internal_rules_json}}

knowledgeBaseAgentGuidance:
{{knowledge_base_agent_guidance_json}}

OUTPUT REQUIREMENTS
Return exactly one JSON object with this schema:

{
  "field_id": "string",
  "field_label": "string",
  "value": "string | number | boolean | null",
  "confidence": 0.0,
  "rationale": "string",
  "null_reason": "string | null",
  "evidence": [
    {
      "type": "source_field | business_field | conversation | payment | bureau | income_employment | compliance_rule | knowledge_guidance",
      "key": "string",
      "value": "string"
    }
  ]
}

CONFIDENCE RULES
- confidence must be between 0 and 1
- if value is null, confidence must be null or <= 0.1
- confidence > 0.8 requires multiple strong corroborated evidence items
- if evidence is weak, prefer lower confidence

FINAL REMINDER
Use only the evidence above.
If evidence is insufficient, return null.
Return JSON only.
```

### Retry suffix
```text
Your previous response did not match the required schema.

VALIDATION FEEDBACK:
{{validation_error_message}}

Please try again and return exactly one valid JSON object matching the required schema.
Do not add any text before or after the JSON.
```

---

## Task 39 — Derived Field Computation

### Goal
Compute **all derived fields deterministically** using:
- resolved source fields
- business fields from Task 38
- previously computed derived fields where needed

### Important update
Derived fields may now depend on a wider set of data categories, not just core loan/payment/customer fields.

Possible dependencies may include:
- income and employment data
- bureau data
- business fields inferred using policy/guidance context
- previously computed derived fields

### What Task 39 should do
For each customer:

1. Read:
   - `resolvedSourceFields`
   - `businessFields`
2. Compute all configured derived fields deterministically
3. Support dependencies on:
   - source fields
   - business fields
   - other derived fields
4. Use field metadata and safe coercion
5. Store:
   - derived field values
   - derived field trace
   - stage metrics

### Important rules
- Do not evaluate treatments here
- Do not rank treatments here
- Do not decide final recommendation here
- Use strict safe coercion:
  - `"251"` -> `251` is okay
  - `"Yes"` -> `true` is okay
  - `"HIGH"` -> number is not okay
- If evaluation is unsafe, return `null` and log warning
- Derived field type deduction is best-effort only:
  - arithmetic -> `number`
  - logical/comparison -> `boolean`
  - text concatenation -> `string`
  - unclear/mixed -> `string` with warning
- Always allow user override of derived-field type
- Show visible warning labels when formula/type mismatch exists, such as:
  - `"Type mismatch risk"`
  - `"Formula may not evaluate safely"`
- Compliance policy / internal rules / knowledge guidance should not themselves be treated as numeric formula inputs unless a field is explicitly configured that way.

### Relevant files
- `server/lib/derivation-config.ts`
- `server/lib/decisioning/derived-field-engine.ts`
- `server/lib/decisioning/types.ts`

---

## Task 40 — Final AI-Driven Customer Analysis

### Goal
Run **one strong final AI analysis per customer**.

This task should be **prompt-driven**, not a heavy deterministic stitching engine.

### Important update
The final analysis must support all major categories of customer and policy context, including:

- loan/account data
- payment data
- conversation/contact data
- credit bureau data
- income and employment data
- compliance policy / internal rules
- knowledge base / agent guidance
- SOP / treatment policy content

### What Task 40 should do
For each customer, build one final AI prompt containing:

#### Customer data
- all resolved source fields
- all business fields
- all derived fields
- all grouped raw/structured data by source:
  - loans
  - payments
  - conversations
  - bureau
  - income and employment
  - other data if available

#### Treatment and rule configuration
- all configured treatments
- treatment descriptions
- treatment priority if configured
- all treatment rules:
  - `when_to_offer`
  - `blocked_if`

#### Other structured policy config
- escalation rules
- review triggers
- guardrails
- compliance policy / internal rules
- any structured policy settings configured in Beacon

#### Guidance content
- knowledge base / agent guidance
- SOP text or extracted SOP sections if available

#### Communication guidance
- `communicationGuidelines`
- `emailGuidelines`
- `emailWhenToUse`
- `emailWhenNotToUse`
- `toneGuidance`

Then ask AI to:
- analyze the customer case
- understand which treatment best fits
- explain why
- decide if email is needed
- return final JSON output

### What Task 40 should still do deterministically

#### Before AI
Do a basic policy completeness check:
- if policy is broken:
  - admin/config context -> fail fast
  - analysis context -> create system-hold / `AGENT_REVIEW` record

#### After AI
Do lightweight validation only:
- valid JSON
- required keys present
- correct value types
- treatment code is valid
- email format is valid if drafted

Do **not** rebuild the entire recommendation logic deterministically after AI.

### Model settings
- Model: `gemini-2.5-pro`
- Max output tokens: `6000`

### Relevant files
- `server/lib/decisioning/decision-packet.ts`
- `server/lib/decisioning/decision-engine.ts`
- `server/lib/decisioning/decision-validator.ts`
- `server/lib/decisioning/prompts/final-decision-prompt.ts`
- `server/routes.ts`
- `server/storage.ts`
- `shared/schema.ts`

### Decision packet shape
```ts
type DecisionPacket = {
  customer: {
    resolvedSourceFields: Record<string, unknown>;
    businessFields: Record<string, unknown>;
    derivedFields: Record<string, unknown>;
    groupedSourceData: {
      loanData?: unknown;
      paymentData?: unknown;
      conversationData?: unknown;
      bureauData?: unknown;
      incomeEmploymentData?: unknown;
      otherData?: unknown;
    };
  };
  policy: {
    treatments: unknown[];
    treatmentRules: {
      whenToOffer: unknown[];
      blockedIf: unknown[];
    };
    escalationRules: unknown[];
    reviewTriggers: unknown[];
    guardrails: unknown[];
    compliancePolicyInternalRules?: unknown[];
    structuredPolicyConfig: Record<string, unknown>;
  };
  guidance: {
    knowledgeBaseAgentGuidance?: unknown[];
  };
  communication: {
    communicationGuidelines: string[];
    emailGuidelines: string[];
    emailWhenToUse: string[];
    emailWhenNotToUse: string[];
    toneGuidance: string[];
  };
  sop: {
    text?: string;
    extractedSections?: unknown;
  };
};
```

### Final output schema
```json
{
  "customer_guid": "string",
  "customer_name": "string | null",
  "customer_phone": "string | null",
  "customer_email": "string | null",

  "recent_payment_history_summary": "string | null",
  "conversation_summary": "string | null",

  "customer_situation": "string",
  "customer_situation_confidence_score": 1,
  "customer_situation_evidence": "string",

  "used_fields": ["string"],
  "used_rules": ["string"],
  "missing_information": ["string"],
  "key_factors_considered": ["string"],

  "structured_assessments": [
    {
      "name": "string",
      "value": "string | null",
      "reason": "string"
    }
  ],

  "recommended_treatment_name": "string",
  "recommended_treatment_code": "string",
  "proposed_next_best_action": "string",
  "treatment_eligibility_explanation": "string",
  "blocked_conditions": ["string"],

  "proposed_next_best_confidence_score": 1,
  "proposed_next_best_evidence": "string",

  "requires_agent_review": true,
  "internal_action": "string",

  "proposed_email_to_customer": "Subject: <subject> Body: <body> OR NO_ACTION"
}
```

### Task 40 system prompt
```text
You are Beacon's final decision engine for customer review queue recommendations.

Your job is to review one structured customer case and recommend the next best treatment.

You must follow these rules exactly:
1. Use only the information provided in the prompt.
2. Use the full customer data, the full configured treatments and rules, the structured policy configuration, compliance rules, guidance content, and SOP guidance if provided.
3. Do not use outside knowledge.
4. Do not invent facts.
5. Do not invent treatments.
6. You may choose only:
   - one configured treatment,
   - AGENT_REVIEW,
   - or NO_ACTION.
7. Never recommend a treatment that is clearly blocked by the provided rules or guardrails.
8. Prefer the highest-priority treatment when the policy and case context support it, but use judgment when multiple treatments may apply.
9. If the case is unsafe, ambiguous, blocked by policy, or missing critical information, prefer AGENT_REVIEW.
10. Use treatment language, not solution language.
11. Explain the customer situation clearly and operationally for an agent.
12. You must decide whether a customer email is needed.
13. Return "NO_ACTION" for the email if no customer email should be sent.
14. Return "Subject: ... Body: ..." only if an email would meaningfully advance the recommended treatment or customer handling.
15. Use the provided communication guidelines and tone guidance if available.
16. Do not draft an email for internal-only, monitoring-only, or escalation-only actions unless the prompt clearly supports customer outreach.
17. Keep the email concise and operational.
18. Return valid JSON only. Do not include markdown. Do not include commentary outside the JSON object.
```

### Task 40 user prompt template
```text
Analyze this customer and return the final recommendation JSON.

CUSTOMER CASE DATA
{{all_customer_data_json}}

BUSINESS FIELDS
{{business_fields_json}}

DERIVED FIELDS
{{derived_fields_json}}

CONFIGURED TREATMENTS
{{configured_treatments_json}}

TREATMENT RULES
WHEN TO OFFER:
{{when_to_offer_rules_json}}

BLOCKED IF:
{{blocked_if_rules_json}}

ESCALATION RULES
{{escalation_rules_json}}

REVIEW TRIGGERS / GUARDRAILS
{{review_triggers_and_guardrails_json}}

COMPLIANCE POLICY / INTERNAL RULES
{{compliance_policy_internal_rules_json}}

KNOWLEDGE BASE / AGENT GUIDANCE
{{knowledge_base_agent_guidance_json}}

STRUCTURED POLICY CONFIGURATION
{{policy_configuration_json}}

COMMUNICATION GUIDELINES
{{communication_config_json}}

SOP TEXT OR EXTRACTED SOP GUIDANCE
{{sop_text_or_sections}}

OUTPUT REQUIREMENTS
Return exactly one JSON object matching this schema:

{
  "customer_guid": "string",
  "customer_name": "string | null",
  "customer_phone": "string | null",
  "customer_email": "string | null",

  "recent_payment_history_summary": "string | null",
  "conversation_summary": "string | null",

  "customer_situation": "string",
  "customer_situation_confidence_score": 1,
  "customer_situation_evidence": "string",

  "used_fields": ["string"],
  "used_rules": ["string"],
  "missing_information": ["string"],
  "key_factors_considered": ["string"],

  "structured_assessments": [
    {
      "name": "string",
      "value": "string | null",
      "reason": "string"
    }
  ],

  "recommended_treatment_name": "string",
  "recommended_treatment_code": "string",
  "proposed_next_best_action": "string",
  "treatment_eligibility_explanation": "string",
  "blocked_conditions": ["string"],

  "proposed_next_best_confidence_score": 1,
  "proposed_next_best_evidence": "string",

  "requires_agent_review": true,
  "internal_action": "string",

  "proposed_email_to_customer": "Subject: <subject> Body: <body> OR NO_ACTION"
}

OUTPUT RULES
- use only configured treatment names/codes, or AGENT_REVIEW, or NO_ACTION
- do not invent unsupported facts
- use the provided data and rules to explain the recommendation
- if multiple treatments could apply, choose the best-supported one and explain why
- if the case is too ambiguous or unsafe, use AGENT_REVIEW
- if no email is needed, return NO_ACTION
- if email is drafted, it must align with the chosen treatment and customer handling
- confidence scores must be 1–10 integers
- be concise, clear, and operational

FINAL REMINDER
Use the full case data, full treatment/rule configuration, escalation rules, review triggers, guardrails, compliance rules, knowledge guidance, structured policy configuration, communication guidance, and SOP guidance if provided.
Return JSON only.
```

### Retry suffix
```text
Your previous response did not match the required schema.

VALIDATION FEEDBACK:
{{validation_error_message}}

Please return exactly one valid JSON object matching the required schema.
Do not add text before or after the JSON.
```

---

## Task 41 — UI

### Goal
Keep the review queue simple and the detail page richer.

### Review queue should show only
- customer ID
- last AI run date
- recommended treatment
- Review CTA button

### Decision detail page should show
1. top summary
2. source data
3. business fields
4. derived fields
5. treatment decision / validation / email

### Important note
Validation details, warnings, and reasoning can remain inside the detail page. The queue should stay lean.

### Important update
Where relevant, the detail page should be able to surface additional categories used in the decision, such as:
- income and employment data
- bureau data
- compliance policy / internal rules used
- knowledge base / agent guidance used

These do not need separate queue columns, but they should be visible in the detail experience if they influenced the recommendation.

### Relevant files
- `client/src/pages/review-queue.tsx`
- `client/src/pages/decision-detail.tsx`
