# Task 43 — Improvement Notes for Replit

## Goal
Tighten Task 43 so the business-field inference step is reliable, consistent, and aligned with the agreed design.

The current Task 43 plan is directionally good, but it should be improved in the following ways.

---

## 1. Explicitly infer all client-configured business fields

Please state clearly in Task 43 that for each customer, Beacon should:

- load **all business fields configured by the client**
- infer them **one by one**
- not use tiering
- not use "required only" filtering
- not skip fields because they seem less important

Reason:
We already simplified the design. If the client created the business field, Beacon should try to infer it.

---

## 2. Clarify context hierarchy

Please make the context priority explicit.

### Highest priority = customer facts
These are factual customer-case inputs:
- resolved source fields
- payment data
- conversation data
- bureau data
- income and employment data

### Lower priority = interpretation guidance
These are guidance inputs:
- compliance policy / internal rules
- knowledge base / agent guidance

Reason:
Guidance should help interpretation, but it must not silently override direct customer facts.

---

## 3. Use stable inclusion rules for extra context

The plan currently says extra context is passed "where configured". Please make this more concrete.

### Required behavior
If these sections are absent, pass them consistently as empty arrays/objects:

- `incomeEmploymentData`
- `compliancePolicyInternalRules`
- `knowledgeBaseAgentGuidance`

Do not omit them unpredictably.

Reason:
Stable prompt shape makes the system easier to debug and less fragile.

---

## 4. Expand trace metadata

The current trace requirements are good, but still incomplete.

Please add to the per-field trace:

- which context sections were included
- whether any section was truncated
- original item count vs retained item count where truncation happened
- whether summarization was used

Reason:
This will make it much easier to debug bad field inference later.

---

## 5. Make history truncation deterministic

The current wording says:
- keep most recent
- keep most significant
- summarize older items

Please define a simple deterministic truncation policy, for example:

- keep latest N items
- keep significant / flagged items
- summarize the remainder
- log original count and retained count in trace

Reason:
Without a concrete policy, different implementations may behave inconsistently.

---

## 6. Strengthen output validation

Please make these rules explicit after every business-field AI call:

- `value` must be scalar or `null`
- arrays and objects are invalid
- if `allowed_values` exists, returned value must match one of them or `null`
- if validation fails after one retry, store `null` and continue

Reason:
This is one of the main areas where drift and instability can happen.

---

## 7. Missing metadata must not fail inference

Please explicitly state:

If any of these are missing:
- `data_type`
- `allowed_values`
- `default_value`
- `business_meaning`

the field should still be inferred using whatever metadata is available.

Do not fail the business field because metadata is incomplete.

Reason:
Real configurations will still be imperfect for some time.

---

## 8. Normalize evidence types

Please restrict evidence type values to this exact set:

- `source_field`
- `business_field`
- `conversation`
- `payment`
- `bureau`
- `income_employment`
- `compliance_rule`
- `knowledge_guidance`

Reason:
This avoids evidence typing drift and keeps traces consistent.

---

## 9. Restate timeout behavior in Task 43

Please explicitly include timeout behavior in this task:

- per-field timeout still applies
- if timeout occurs, store `null`
- set `null_reason = "field inference timeout"`
- continue to the next field

Reason:
This is important enough to be stated directly in Task 43.

---

## 10. Use canonical source fields only

Please state clearly that the prompt must use:

- `resolvedSourceFields`

and not raw upload column names.

Reason:
The business-field prompt should use clean canonical inputs, not noisy raw source names.

---

## Suggested tightened wording for Task 43

### Add this near the top
For each customer, load **all client-configured business fields** and infer them one by one. Do not use tiering or required-only selection logic.

### Add this under context handling
Customer facts have priority over guidance. Source data, payments, conversations, bureau data, and income/employment data are factual evidence. Compliance rules and knowledge-base guidance are interpretation aids only and must not override direct customer facts.

### Add this under validation
After each model call, validate that:
- `value` is scalar or null
- arrays/objects are rejected
- enum values match `allowed_values` when present
- one retry only on schema/format failure
- after retry failure, set null and continue

### Add this under tracing
Per-field trace must also record:
- included context sections
- truncation/summarization flags
- original vs retained counts for long histories

---

## Final recommendation

Task 43 is good in direction, but it should be tightened in these areas before implementation.

The most important fixes are:

1. explicitly infer **all** client-configured business fields
2. clarify that customer facts outrank guidance
3. make truncation deterministic
4. strengthen output validation
5. enrich trace metadata

With these changes, Task 43 will be much more reliable.
