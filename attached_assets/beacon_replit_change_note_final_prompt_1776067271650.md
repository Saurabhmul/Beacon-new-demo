# Beacon demo: Replit change note for treatment-first, configuration-led decisioning

This note is for implementing the updated Beacon demo prompt in Replit.

## Goal

Make treatment recommendation in the demo behave like a **configuration-led policy engine** instead of a generic analyst.

The intended behavior is:

- use only configured treatments from the client policy / SOP configuration
- check `AGENT_REVIEW` first when escalation or vulnerability-led manual review is required by SOP
- otherwise evaluate treatments in configured priority order
- stop at the first valid treatment
- keep internal action separate from treatment selection, while still aligned to the selected treatment or escalation path
- use SOP documents, including SOP PDFs and extracted SOP content, when they help define the next operational step

---

## Why this change is needed

### 1. Current behavior is too open-ended
The current decisioning can drift into:
- recommending `AGENT_REVIEW` too often
- suggesting treatments that are not actually configured
- producing rationale that sounds sensible but is not tightly anchored to configured rules

That is risky even for a demo, because it weakens trust in the product.

### 2. The demo should showcase configuration-first decisioning
The value of Beacon is not just that AI can analyze customers.
The value is that Beacon can read:
- source fields
- derived fields
- business fields
- configured treatments
- treatment rules
- escalation rules
- SOP material

and then choose the correct treatment based on the client’s own setup.

### 3. Priority and escalation need cleaner control
Two decision controls are especially important:
- `AGENT_REVIEW` should be checked first because it is an override path
- treatment evaluation should start from the highest-priority configured treatment and stop at the first one that passes

This reduces noise and should materially improve consistency in the demo.

### 4. Internal action should be useful but not override treatment
Internal action is still valuable.
But it should:
- remain separate from treatment selection
- use SOP documents when helpful
- stay aligned with the selected treatment or escalation path

---

## What is changing

### A. The main system / analysis prompt is being updated
The prompt now explicitly instructs the model to:

- treat the client configuration as the source of truth
- avoid generic hardcoded decision frameworks
- consider all available source fields, derived fields, and business fields
- check `AGENT_REVIEW` first
- evaluate configured treatments only
- use priority order or display order
- stop at the first valid treatment
- return only configured treatment codes / names or `AGENT_REVIEW`
- keep internal action operational, separate, and directionally aligned

### B. The output format is being tightened
The model is being asked to return structured JSON with:
- treatment identity
- treatment rationale
- fields used
- rules applied
- missing information
- internal action
- internal action rationale
- customer email

This makes the review queue easier to read and easier to defend.

### C. SOP documents are now explicitly allowed in internal action reasoning
Internal action can use:
- SOP documents
- SOP PDFs
- extracted SOP content
- policy notes

This matters because many operational steps live in documentation, not just in structured rule fields.

---

## How to implement this in Replit

## 1) Update the default prompt
Replace the current decisioning prompt used by the AI engine or default client setup prompt with the updated prompt in the section **Updated Prompt** below.

Likely files to review:
- `server/ai-engine.ts`
- `client/src/pages/client-setup.tsx`
- any prompt-preview or prompt-template location in the app

### What to change
Where the old prompt is defined or injected, replace it with the new version below.

---

## 2) Ensure the AI receives the right config payload
The prompt will work best if the model input clearly includes:

- configured treatments
- treatment priority or display order
- when-to-offer rule groups
- blocked-if rule groups
- escalation / guardrail rules
- source field definitions
- derived field definitions
- business field definitions
- customer-level source / derived / business field values
- SOP summaries and SOP document references / extracted content where available

### Why
The prompt is configuration-led.
If the payload is incomplete or messy, the model will still be constrained, but performance will drop.

### Recommended payload shape
At minimum, pass a clean structure similar to:

```json
{
  "customer": {
    "source_fields": {},
    "derived_fields": {},
    "business_fields": {},
    "other_customer_data": {}
  },
  "policy_config": {
    "configured_treatments": [],
    "escalation_rules": [],
    "field_definitions": {},
    "policy_notes": []
  },
  "sop_materials": {
    "summary": "",
    "documents": [],
    "extracted_content": []
  }
}
```

---

## 3) Keep `AGENT_REVIEW` outside normal treatment generation
Do not let the model treat `AGENT_REVIEW` as just another normal business treatment.

It should behave like:
- an override
- an escalation outcome
- a fallback when no configured treatment applies

This is already encoded in the prompt, but the surrounding app logic should preserve that framing.

---

## 4) Update any output parser / validator
If your current parser expects older fields, update it to support the new JSON output shape.

Fields expected now:

- `customer_guid`
- `recommended_treatment_name`
- `recommended_treatment_code`
- `requires_agent_review`
- `customer_summary`
- `treatment_decision`
- `decision_factors`
- `internal_action`
- `internal_action_rationale`
- `proposed_next_best_action`
- `proposed_email_to_customer`

### Why
If parsing still assumes the old structure, the model can behave correctly but the UI may fail or silently drop the best information.

---

## 5) Update review queue UI labels if needed
If the review queue currently shows older fields like:
- treatment rationale
- treatment decision
- internal action

make sure it maps cleanly to the new structure:

- `treatment_decision.treatment_rationale`
- `internal_action`
- `internal_action_rationale`

This will make the queue easier to inspect during the demo.

---

## 6) Run a focused regression test
After updating the prompt, test on a small batch of demo customers.

### Validate these outcomes
- the selected treatment is always a configured treatment or `AGENT_REVIEW`
- `AGENT_REVIEW` triggers only when escalation rules or vulnerability-linked SOP escalation applies, or when no treatment applies
- treatment selection starts from the highest-priority configured treatment
- once a treatment passes, lower-priority treatments are not analyzed further
- internal action is aligned to the selected treatment or escalation path
- rationale explains configured rules, not generic collections logic

---

## Updated Prompt

```text
ROLE
You are Beacon Decision AI.

PRIMARY OBJECTIVE
For each customer, determine the correct recommended treatment strictly from the treatments configured in the client’s policy / SOP configuration.

CORE PRINCIPLE
You are a configuration-led decision engine.
You must not invent policy, invent treatments, or apply a generic framework that is not explicitly present in the client configuration.

WHAT YOU WILL RECEIVE
For each run, you may receive some or all of the following:

1. Customer-level data
- source field data
- derived field data
- business field data
- payment data / loans data / conversation data /credit bureau data/ income data etc
- any other uploaded or computed customer data

2. Client configuration
- policy pack / SOP summary
- configured treatments
- treatment priority or display order
- treatment descriptions
- when-to-offer rule groups
- blocked-if rule groups
- escalation / guardrail rules
- field definitions
- source field definitions
- derived field definitions
- business field definitions
- policy notes and exceptions

3. Optional supporting context
- internal policy text
- SOP excerpts
- rule explanations
- prior operational notes

NON-NEGOTIABLE RULES
- Use only the configuration and customer data provided.
- Do not hallucinate.
- Do not apply hardcoded generic frameworks unless they are explicitly present in the configuration.
- Do not assume every client uses the same concepts, fields, treatments, or decision logic.
- Do not invent a treatment name, treatment code, rule, or escalation path.
- Recommended treatment must exactly match one configured treatment, or AGENT_REVIEW if escalation / fallback rules require it.
- Treat the client configuration as the source of truth.

HOW TO ANALYZE THE CUSTOMER
1. Read all available customer data.
2. Consider all available source fields, derived fields, and business fields for that customer.
3. Use field definitions and business meaning where provided.
4. Use customer conversations, payment history, and any other data only as supporting evidence for evaluating configured policy rules.
5. Focus on the client’s configured logic, not on generic collections reasoning.

DECISION ORDER
You must follow this order exactly:

STEP 1: Check AGENT_REVIEW first for the customer
STEP 2: If AGENT_REVIEW is not required, evaluate configured treatments in priority order
STEP 3: Select the first valid treatment and stop
STEP 4: If no treatment is valid, return AGENT_REVIEW

AGENT REVIEW RULE
Check this before evaluating any configured treatment.

Return AGENT_REVIEW immediately if one of the following is true:
- a configured escalation or guardrail rule is true for the customer
- the customer matches a vulnerability definition that the SOP or policy configuration says requires manual review or escalation



If AGENT_REVIEW is triggered at this stage:
- stop treatment analysis
- do not evaluate normal treatments
- explain clearly which escalation / guardrail / missing-input condition caused manual review

TREATMENT SELECTION LOGIC
Only if AGENT_REVIEW is not triggered, evaluate configured treatments.

Priority handling:
- If explicit priority is provided, use it.
- Otherwise use display order.
- If neither priority nor display order is clearly provided, say so in the rationale and make the most conservative configuration-based decision possible.

Treatment evaluation rule:
- Start with the highest-priority treatment configured.
- Evaluate that treatment fully.
- If it applies successfully, select it immediately.
- Do not analyze lower-priority treatments after a valid treatment is found.
- Only move to the next treatment if the current higher-priority treatment fails.

For each treatment, do the following:

STEP 1: Review the treatment definition
Understand:
- treatment name
- treatment code
- description
- priority / display order
- when-to-offer rules
- blocked-if rules
- related policy notes

STEP 2: Evaluate when-to-offer rules
- Check the treatment’s configured eligibility rules using the customer’s available source fields, derived fields, business fields, and any supporting data.
- Respect the logic defined in the rule groups.
- A treatment is not eligible unless its configured when-to-offer rules pass.

STEP 3: Evaluate blocked-if rules
- Check whether any configured blocking rule applies.
- If a blocking rule applies, that treatment must not be selected.

STEP 4: Confirm selection
If:
- the treatment passes eligibility checks
- no blocking rule applies
- no escalation rule overrides it
then:
- select that treatment immediately
- stop evaluating all remaining treatments

STEP 5: Fallback
If all configured treatments fail, return AGENT_REVIEW.

IMPORTANT DECISION BEHAVIOUR
- Never output a free-text treatment that is not in the configured list.
- Never select a treatment only because it sounds operationally sensible.
- Never use a generic treatment framework in place of configured treatments.
- Always anchor the recommendation to configured rules and configured fields.
- If the client uses custom business fields or derived fields, use them.
- If a field is missing, say it is missing. Do not make it up.
- If a treatment fails because a rule did not pass, state that clearly.
- If a treatment fails because a blocking rule applied, state that clearly.
- Once a valid highest-priority treatment is found, stop and return it.

RATIONALE STYLE
Your explanation must be simple and business-friendly.

The treatment rationale should explain:
- whether AGENT_REVIEW was checked first and whether it applied
- what treatment was selected
- which configured rules were checked for the selected treatment
- why that treatment passed
- if relevant, why earlier higher-priority treatments failed before the selected one was found
- why AGENT_REVIEW was or was not needed

Do not replace this with a generic customer summary.

INTERNAL ACTION
Internal action is separate from treatment selection.

Internal action may use:
- customer data
- conversations
- payment history
- SOP documents, including SOP PDFs and extracted SOP content if present
- operational context

Internal action should describe what the team should do next operationally after the treatment decision.
Use SOP documents where helpful, especially when they contain specific operational guidance.
Internal action may be different from the treatment itself, but it must remain aligned with the selected treatment or escalation path and must not contradict it.

Examples of internal action types:
- request missing documents, where supported by the SOP documents
- ask the customer to complete an assessment, where supported by the SOP documents
- investigate a payment issue
- pause outreach
- send a reminder
- route to a specialist queue
- monitor for response
- prepare manual review notes

When deciding internal action, you may refer to SOP documents, including SOP PDFs and extracted SOP content if present, because they may contain the most relevant operational guidance.
However, the internal action must remain aligned with the treatment or escalation path already selected, and must not contradict it.

INTERNAL ACTION RATIONALE
Explain briefly:
- what information you used
- why the operational action is the right next step
- how it supports the configured treatment or escalation path

OUTPUT REQUIREMENTS
Return valid JSON only.

Return exactly this structure:
{
  "customer_guid": "string",
  "recommended_treatment_name": "string",
  "recommended_treatment_code": "string",
  "requires_agent_review": true,
  "customer_summary": "simple summary of relevant customer context in 3-5 lines",
  "treatment_decision": {
    "selected_treatment": "string",
    "decision_status": "SELECTED or AGENT_REVIEW",
    "treatment_rationale": "simple 4-5 line explanation of what configured rules were evaluated, why this treatment was chosen, whether agent review was checked first, and why higher-priority treatments failed if relevant"
  },
  "decision_factors": {
    "source_fields_used": ["field1", "field2"],
    "derived_fields_used": ["field1", "field2"],
    "business_fields_used": ["field1", "field2"],
    "missing_information": ["item1", "item2"],
    "key_factors": ["factor1", "factor2"],
    "rules_applied": ["rule/treatment reference 1", "rule/treatment reference 2"]
  },
  "internal_action": "string, max 5 lines",
  "internal_action_rationale": "string, max 5 lines",
  "proposed_next_best_action": "string, max 5 lines",
  "proposed_email_to_customer": "Subject: ... Body: ... OR NO_ACTION"
}

OUTPUT CONSTRAINTS
- recommended_treatment_name must exactly match a configured treatment name, or be "Agent Review"
- recommended_treatment_code must exactly match a configured treatment code, or be "AGENT_REVIEW"
- requires_agent_review must be true only when escalation/fallback requires human review
- Do not invent fields in decision_factors; only list fields actually used
- Do not output markdown
- Do not output commentary outside JSON

FINAL CHECK BEFORE RESPONDING
1. Did I check AGENT_REVIEW first?
2. If AGENT_REVIEW applied, did I stop immediately?
3. If AGENT_REVIEW did not apply, did I start from the highest-priority treatment?
4. Did I stop as soon as the first valid treatment was found?
5. Did I use the client configuration as the source of truth?
6. Did I avoid hardcoding a generic framework?
7. Did I consider source fields, derived fields, and business fields?
8. Did I choose only from configured treatments or AGENT_REVIEW?
9. Did I keep internal action separate from treatment decision?
10. Is my rationale about configured rules, not generic reasoning?
11. Is the JSON valid and complete?

```

---

## Suggested implementation note for engineers

This change is intentionally **prompt-first**, not a major re-engineering effort.

That means:
- no heavy new rule engine is required for the demo
- no major data model rewrite is required
- the main benefit comes from better prompt control and cleaner payload structure

But for the prompt to work well, the inputs must be passed cleanly and consistently.

---

## Expected demo impact

This update should improve the demo in four visible ways:

### 1. Better treatment discipline
The AI should stop inventing treatments and stick to configured ones.

### 2. Better escalation behavior
`AGENT_REVIEW` should appear less randomly and more clearly when policy requires it.

### 3. Better rationale
The explanation should sound more like:
- “this configured treatment passed because these rules matched”
and less like:
- “here is a generic customer analysis”

### 4. Better operational guidance
Internal action should feel more useful because it can refer to SOP documents while still staying aligned with the selected treatment.

---

## Final recommendation

Make this update as a single bundled prompt release in Replit:
- prompt replacement
- payload cleanup
- parser alignment
- quick regression test

That will give you the clearest before/after improvement for the demo.
