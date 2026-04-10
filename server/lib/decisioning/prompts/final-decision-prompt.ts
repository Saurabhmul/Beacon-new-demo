import type { DecisionPacket } from "../decision-packet";
import type { RuleEvaluationResult } from "../types";

// ─── Prompt versions ──────────────────────────────────────────────────────────

export const FINAL_DECISION_PROMPT_VERSION = "v1.0";

// ─── System prompt (verbatim, non-negotiable) ─────────────────────────────────

export function buildFinalDecisionSystemPrompt(): string {
  return `You are Beacon's final decision engine for customer review queue recommendations.
Your job is to review one structured customer case and recommend the next best treatment.
You must follow these rules exactly:
1. Use only the information in the decision packet.
2. Do not use outside knowledge.
3. Do not invent facts.
4. Do not invent treatments.
5. You may choose only: one treatment from ranked_eligible_treatments, AGENT_REVIEW, or NO_ACTION.
6. Never recommend a blocked treatment.
7. Respect all escalation flags and guardrail flags.
8. You must prefer the highest-priority treatment from preferred_treatments. A lower number means higher priority (1 is highest). If multiple treatments share the top priority (tied preferred treatments), you may choose among those tied treatments only if the decision packet provides a clear, traceable reason for your choice. Only recommend a lower-ranked eligible treatment (outside preferred_treatments) if the decision packet clearly justifies it based on review triggers, guardrails, or missing critical information. If no clear justification exists for deviating from preferred treatments, use AGENT_REVIEW.
9. If the case is unsafe, ambiguous, blocked by policy, or missing critical information, prefer AGENT_REVIEW.
10. Use treatment language, not solution language.
11. Explain the customer situation clearly and operationally for an agent.
12. EMAIL DECISION RULES: You must decide whether a customer email is needed. Return "NO_ACTION" if no email should be sent. Return "Subject: ... Body: ..." if an email would meaningfully advance the recommended treatment or customer handling. Only draft an email when it helps achieve one of these purposes: request missing information or documents; answer a customer's open question clearly; acknowledge hardship and explain support or next steps; inform the customer of the next step and what is needed from them; reinforce positive repayment behaviour; re-engage a silent customer respectfully when appropriate. Do not draft an email for internal-only actions, monitoring-only actions, or escalation-only actions unless the decision packet clearly supports customer outreach. Use the communicationGuidelines, emailWhenToUse, emailWhenNotToUse, and toneGuidance from the decision packet. Keep the email concise and operational. Do not invent facts not present in the decision packet.
13. Return valid JSON only. Do not include markdown. Do not include commentary outside the JSON object.`;
}

// ─── Retry suffix ─────────────────────────────────────────────────────────────

export function buildFinalDecisionRetryPrompt(previousError: string): string {
  return `Your previous response had a structural issue: ${previousError}

Please respond again with valid JSON only. No markdown, no commentary. Follow the exact output schema provided. Pay careful attention to:
- All required keys must be present
- confidence scores must be integers 1-10
- proposed_email_to_customer must be exactly "NO_ACTION" or "Subject: ... Body: ..."
- requires_agent_review must be a boolean`;
}

// ─── User prompt ──────────────────────────────────────────────────────────────

export function buildFinalDecisionUserPrompt(
  decisionPacket: DecisionPacket,
  _ruleEvalResult: RuleEvaluationResult
): string {
  const dp = decisionPacket;

  const sections: string[] = [];

  // ── Decision Packet ──────────────────────────────────────────────────────
  sections.push("=== DECISION PACKET ===");
  sections.push(JSON.stringify({
    customer_guid: dp.customer_guid,
    customer_name: dp.customer_name,
    customer_phone: dp.customer_phone,
    customer_email: dp.customer_email,
    days_past_due: dp.days_past_due,
    amount_due: dp.amount_due,
    minimum_due: dp.minimum_due,
    additional_customer_context: dp.additional_customer_context,
    source_fields: dp.sourceFields,
    derived_fields: dp.derivedFields,
    business_fields: dp.businessFields,
    recent_payment_history: dp.rawPaymentData.slice(0, 5),
    recent_conversations: dp.rawConversationData.slice(0, 3),
    decision_basis_summary: dp.decisionBasisSummary,
    field_availability_summary: dp.fieldAvailabilitySummary,
  }, null, 2));

  // ── Ranked Eligible Treatments ───────────────────────────────────────────
  sections.push("\n=== RANKED ELIGIBLE TREATMENTS ===");
  if (dp.rankedEligibleTreatments.length === 0) {
    sections.push("No eligible treatments found.");
  } else {
    sections.push(dp.rankedEligibleTreatments.map(t =>
      `- ${t.name} (code: ${t.code}, priority: ${t.priority ?? "unset"}, rank: ${t.rank}, preferred: ${t.isPreferred}, source: ${t.prioritySource})`
    ).join("\n"));
  }

  // ── Preferred Treatments ─────────────────────────────────────────────────
  sections.push("\n=== PREFERRED TREATMENTS (top-ranked subset) ===");
  if (dp.preferredTreatments.length === 0) {
    sections.push("No preferred treatments (no eligible treatments with configured priority).");
  } else {
    sections.push(dp.preferredTreatments.map(t =>
      `- ${t.name} (code: ${t.code}, priority: ${t.priority ?? "unset"}, rank: ${t.rank})`
    ).join("\n"));
  }

  // ── Blocked Treatments ───────────────────────────────────────────────────
  sections.push("\n=== BLOCKED TREATMENTS (do NOT recommend these) ===");
  if (dp.blockedTreatments.length === 0) {
    sections.push("No blocked treatments.");
  } else {
    sections.push(dp.blockedTreatments.map(t =>
      `- ${t.name} (code: ${t.code}, type: ${t.blockerType}): ${t.reasons.join("; ")}`
    ).join("\n"));
  }

  // ── Escalation Flags ─────────────────────────────────────────────────────
  sections.push("\n=== ESCALATION FLAGS ===");
  if (dp.escalationFlags.length === 0) {
    sections.push("No escalation flags.");
  } else {
    sections.push(dp.escalationFlags.map(f => `- [${f.type}] ${f.description}`).join("\n"));
  }

  // ── Guardrail Flags ──────────────────────────────────────────────────────
  sections.push("\n=== GUARDRAIL FLAGS ===");
  if (dp.guardrailFlags.length === 0) {
    sections.push("No guardrail flags.");
  } else {
    sections.push(dp.guardrailFlags.map(f => `- [${f.type}] ${f.description}`).join("\n"));
  }

  // ── Missing Critical Information ─────────────────────────────────────────
  sections.push("\n=== MISSING CRITICAL INFORMATION ===");
  if (dp.missingCriticalInformation.length === 0) {
    sections.push("No missing critical information.");
  } else {
    sections.push(dp.missingCriticalInformation.map(m =>
      `- ${m.label} (field: ${m.fieldId}, required by: ${m.requiredBy})`
    ).join("\n"));
  }

  // ── Communication Guidelines ─────────────────────────────────────────────
  sections.push("\n=== COMMUNICATION GUIDELINES ===");
  const cg = dp.communication.guidelines;
  const hasCommGuidelines =
    cg.communicationGuidelines.length > 0 ||
    cg.emailGuidelines.length > 0 ||
    cg.emailWhenToUse.length > 0 ||
    cg.emailWhenNotToUse.length > 0 ||
    cg.toneGuidance.length > 0;

  if (!hasCommGuidelines) {
    sections.push("No specific communication guidelines configured. Use professional, empathetic tone.");
    sections.push("emailWhenToUse: Send email when it meaningfully advances the treatment or customer handling.");
    sections.push("emailWhenNotToUse: Do not send email for internal-only or escalation-only actions.");
    sections.push("toneGuidance: Be respectful, clear, and concise.");
  } else {
    if (cg.communicationGuidelines.length > 0) {
      sections.push("General guidelines:");
      cg.communicationGuidelines.forEach(g => sections.push(`  - ${g}`));
    }
    if (cg.emailGuidelines.length > 0) {
      sections.push("Email guidelines:");
      cg.emailGuidelines.forEach(g => sections.push(`  - ${g}`));
    }
    if (cg.emailWhenToUse.length > 0) {
      sections.push("emailWhenToUse:");
      cg.emailWhenToUse.forEach(g => sections.push(`  - ${g}`));
    }
    if (cg.emailWhenNotToUse.length > 0) {
      sections.push("emailWhenNotToUse:");
      cg.emailWhenNotToUse.forEach(g => sections.push(`  - ${g}`));
    }
    if (cg.toneGuidance.length > 0) {
      sections.push("toneGuidance:");
      cg.toneGuidance.forEach(g => sections.push(`  - ${g}`));
    }
  }

  // ── Treatment Priority Rule ──────────────────────────────────────────────
  sections.push(`
=== TREATMENT PRIORITY RULE ===
You MUST prefer the highest-priority treatment from preferred_treatments.
Lower priority number = higher preference (priority 1 is best).
Only deviate from preferred_treatments if:
  a) An active escalation flag, guardrail flag, or review trigger clearly justifies it, OR
  b) Missing critical information makes the preferred treatment unsafe to recommend, OR
  c) The treatment_eligibility_explanation provides an explicit, case-specific traceable reason.
If tied preferred treatments exist and no clear reason exists to choose one over another, use AGENT_REVIEW.
If no eligible treatments exist at all, use AGENT_REVIEW.`);

  // ── Deterministic Fallback Rule ──────────────────────────────────────────
  sections.push(`
=== DETERMINISTIC FALLBACK RULE ===
Always use AGENT_REVIEW if:
  - No eligible treatments exist
  - Critical guardrails or hard blockers make any treatment unsafe
  - The case is ambiguous and no preferred treatment can be clearly chosen
  - Tied preferred treatments with no traceable reason to prefer one
AGENT_REVIEW must have requires_agent_review = true.
NO_ACTION is only valid when a contact cooling-off period applies, a wait-state rule is active,
recent outreach occurred within a defined policy window, or no treatment is needed and no review is required.
NO_ACTION without traceable justification in treatment_eligibility_explanation will be rejected.`);

  // ── Output Schema ────────────────────────────────────────────────────────
  sections.push(`
=== OUTPUT SCHEMA (return exactly this JSON structure, no extra keys at top level) ===
{
  "customer_guid": "string",
  "customer_name": "string or null",
  "customer_phone": "string or null",
  "customer_email": "string or null",
  "days_past_due": "number or null",
  "amount_due": "number or null",
  "minimum_due": "number or null",
  "additional_customer_context": { "key": "string|number|null" },

  "recent_payment_history_summary": "string — concise narrative of payment patterns",
  "conversation_summary": "string — concise narrative of customer interactions",
  "customer_situation": "string — clear operational description for an agent",
  "customer_situation_confidence_score": "integer 1-10",
  "customer_situation_evidence": ["string array of evidence items"],

  "used_fields": ["list of field IDs or names actually used in reasoning"],
  "used_rules": ["list of rule IDs or descriptions that influenced the decision"],
  "missing_information": ["list of information gaps that limit confidence"],
  "key_factors_considered": ["list of key factors"],

  "structured_assessments": [
    { "name": "string", "value": "string", "reason": "string" }
  ],

  "recommended_treatment_name": "string — treatment name or AGENT_REVIEW or NO_ACTION",
  "recommended_treatment_code": "string — treatment code or AGENT_REVIEW or NO_ACTION",
  "proposed_next_best_action": "string — specific action for the agent",
  "treatment_eligibility_explanation": "string — explain why this treatment was chosen",
  "blocked_conditions": ["string array — any conditions that blocked other treatments"],
  "proposed_next_best_confidence_score": "integer 1-10",
  "proposed_next_best_evidence": "string — evidence supporting the recommendation",

  "requires_agent_review": "boolean",
  "internal_action": "string — internal system action",
  "proposed_email_to_customer": "exactly 'NO_ACTION' or 'Subject: <subject>\\nBody: <body>'"
}`);

  return sections.join("\n");
}
