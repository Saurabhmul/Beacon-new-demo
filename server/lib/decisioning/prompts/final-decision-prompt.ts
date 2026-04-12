import type { DecisionPacket } from "../decision-packet";

export function buildFinalDecisionSystemPrompt(): string {
  return `You are a financial services decisioning engine for a collections and customer support team.

RULES:
1. Use only the information provided in the prompt.
2. Use the full customer data, configured treatments and rules, structured policy configuration, compliance rules, guidance content, and SOP guidance if provided.
3. Do not use outside knowledge.
4. Do not invent facts.
5. Do not invent treatments.
6. You may choose only one configured treatment, AGENT_REVIEW, or NO_ACTION.
7. Never recommend a treatment that is clearly blocked by the provided rules or guardrails.
8. Prefer the highest-priority treatment when policy and case context support it, but use judgment when multiple treatments may apply.
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

Return this exact JSON schema:
{
  "customer_guid": "string",
  "customer_name": "string or null",
  "customer_phone": "string or null",
  "customer_email": "string or null",
  "recent_payment_history_summary": "string or null",
  "conversation_summary": "string or null",
  "customer_situation": "string",
  "customer_situation_confidence_score": "integer 1 to 10",
  "customer_situation_evidence": "string",
  "used_fields": ["string"],
  "used_rules": ["string"],
  "missing_information": ["string"],
  "key_factors_considered": ["string"],
  "structured_assessments": [{ "name": "string", "value": "string or null", "reason": "string" }],
  "recommended_treatment_name": "string",
  "recommended_treatment_code": "string",
  "proposed_next_best_action": "string",
  "treatment_eligibility_explanation": "string",
  "blocked_conditions": ["string"],
  "proposed_next_best_confidence_score": "integer 1 to 10",
  "proposed_next_best_evidence": "string",
  "requires_agent_review": "boolean",
  "internal_action": "string",
  "proposed_email_to_customer": "NO_ACTION or Subject: <subject> Body: <body>"
}`;
}

export function buildFinalDecisionUserPrompt(packet: DecisionPacket): string {
  const sections: string[] = [];

  sections.push(`== ALL CUSTOMER DATA ==
${JSON.stringify({
    customerId: packet.customer.customerId,
    ...packet.customer.groupedSourceData,
  }, null, 2)}`);

  sections.push(`== BUSINESS FIELDS ==
${JSON.stringify(packet.customer.businessFields, null, 2)}`);

  sections.push(`== DERIVED FIELDS ==
${JSON.stringify(packet.customer.derivedFields, null, 2)}`);

  sections.push(`== CONFIGURED TREATMENTS ==
${JSON.stringify(packet.policy.treatments, null, 2)}`);

  sections.push(`== WHEN TO OFFER RULES ==
${JSON.stringify(packet.policy.treatmentRules.whenToOffer, null, 2)}`);

  sections.push(`== BLOCKED IF RULES ==
${JSON.stringify(packet.policy.treatmentRules.blockedIf, null, 2)}`);

  sections.push(`== ESCALATION RULES ==
${JSON.stringify(packet.policy.escalationRules, null, 2)}`);

  sections.push(`== REVIEW TRIGGERS AND GUARDRAILS ==
${JSON.stringify({
    reviewTriggers: packet.policy.reviewTriggers,
    guardrails: packet.policy.guardrails,
  }, null, 2)}`);

  sections.push(`== COMPLIANCE POLICY INTERNAL RULES ==
${JSON.stringify(packet.policy.compliancePolicyInternalRules, null, 2)}`);

  sections.push(`== KNOWLEDGE BASE AGENT GUIDANCE ==
${JSON.stringify(packet.guidance.knowledgeBaseAgentGuidance, null, 2)}`);

  sections.push(`== POLICY CONFIGURATION ==
${JSON.stringify({
    compliancePolicyInternalRules: packet.policy.compliancePolicyInternalRules,
    reviewTriggers: packet.policy.reviewTriggers,
    guardrails: packet.policy.guardrails,
    escalationRules: packet.policy.escalationRules,
  }, null, 2)}`);

  sections.push(`== COMMUNICATION CONFIGURATION ==
${JSON.stringify({
    tonePrinciples: packet.communication.tonePrinciples,
    emailTemplates: packet.communication.emailTemplates,
    contactPreferences: packet.communication.contactPreferences,
    outreachCooldownDays: packet.communication.outreachCooldownDays,
    lookbackDays: packet.communication.lookbackDays,
    communicationToneGuidance: packet.guidance.communicationToneGuidance,
  }, null, 2)}`);

  sections.push(`== SOP TEXT AND SECTIONS ==
${packet.sop.text || "(none)"}
${packet.sop.sections.length > 0 ? JSON.stringify(packet.sop.sections, null, 2) : ""}`);

  sections.push(`Now analyze this customer case and return valid JSON only matching the required schema.`);

  return sections.join("\n\n");
}

export function buildFinalDecisionRetryPrompt(validationError: string): string {
  return `Your previous response failed validation: ${validationError}

Please retry. Remember:
- All required keys must be present.
- recommended_treatment_code must be one of the configured treatment codes, AGENT_REVIEW, or NO_ACTION.
- structured_assessments items must each have: name (string), value (string or null), reason (string).
- proposed_email_to_customer must be exactly "NO_ACTION" or contain both "Subject:" and "Body:".
- Return valid JSON only. No markdown. No commentary.`;
}
