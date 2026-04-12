# Task 45 — Improvement Notes

## Goal
Tighten Task 45 while keeping it simple. The final AI decision layer should stay prompt-driven, use the DecisionPacket as the source of truth, validate lightly, and avoid unnecessary schema or storage complexity.

The prompt should remain part of the Task 45 plan because it is part of the actual decisioning logic, not just an implementation detail.

---

## 1. Keep operational fields as direct columns, but store rich trace in one JSONB blob

The current plan adds many new columns to the decisions table, including trace-style fields such as:
- `business_fields_trace`
- `derived_fields_trace`
- `resolved_source_fields`

Please simplify this.

### Recommended approach
Keep the most operational, UI-useful fields as direct columns, such as:
- `recommended_treatment_name`
- `recommended_treatment_code`
- `customer_situation`
- `treatment_eligibility_explanation`
- `structured_assessments`
- `proposed_email_to_customer` if helpful

Store richer trace information inside one structured JSONB trace column, for example:
- `decision_trace_json`
or reuse an existing raw-output/trace column if available

That trace blob should hold:
- full DecisionPacket
- business field trace
- derived field trace
- resolved source fields
- validation details
- raw final AI output

### Why
This keeps the database cleaner and avoids exploding the schema with too many trace-specific columns.

---

## 2. DecisionPacket must always have stable section shapes

Please make this explicit.

### Required behavior
When a section is missing, still include it in the packet with a stable empty fallback:
- object-like sections -> `{}`
- list-like sections -> `[]`

Examples:
- missing income/employment -> `{}`
- missing bureau -> `{}`
- missing knowledge guidance -> `[]`
- missing compliance rules -> `[]`
- missing SOP content -> empty string or empty object, but stable

### Why
Stable packet shape improves prompt consistency and reduces brittle logic in the prompt builder.

---

## 3. Validate treatment codes only against DecisionPacket.policy.treatments

Please make this explicit in the validator.

### Required behavior
The final AI output must validate `recommended_treatment_code` only against:
- the configured treatment codes found inside `DecisionPacket.policy.treatments`
- plus the allowed special values:
  - `AGENT_REVIEW`
  - `NO_ACTION`

Do not validate treatment codes against multiple sources or legacy structures.

### Why
The DecisionPacket should be the single source of truth for what the model is allowed to recommend.

---

## 4. Keep email validation simple

Please keep email validation lightweight.

### Required behavior
Validate only that `proposed_email_to_customer` is either:
- exactly `NO_ACTION`
- or a string containing both:
  - `Subject:`
  - `Body:`

Do not overengineer semantic email validation in Task 45.

### Why
Task 45 should stay focused on the final decision prompt and schema, not become a full communication-quality engine.

---

## 5. Use one retry only

The current plan mentions retry suffix with configured max retries.

Please simplify this.

### Required behavior
- if final AI output fails schema/format validation, append retry suffix
- retry exactly once
- if still invalid, return validation failure and move to fallback handling

### Why
This keeps behavior consistent with Task 43 and avoids retry loops becoming unpredictable.

---

## 6. Make the new decisioning path the source of truth

Please make this explicit.

### Required behavior
Do not continue extending the old final prompt path in:
- `server/lib/prompt/assemble-prompt.ts`

The new final decision path should be:
- `server/lib/decisioning/decision-packet.ts`
- `server/lib/decisioning/prompts/final-decision-prompt.ts`
- `server/lib/decisioning/decision-validator.ts`

### Why
This avoids having two competing final prompt systems in the codebase.

---

## 7. Keep old decisions readable

Please make this explicit in the route/storage update work.

### Required behavior
- existing historical decisions must remain readable
- new decisions use the new pipeline
- `/api/analyze` should not mix old final prompt logic into the new path
- new columns should remain nullable where needed for backward compatibility

### Why
The migration should not break previously stored approved/rejected decisions.

---

## 8. Keep prompt structure in the Task 45 plan

Please keep the following in the plan itself:
- prompt file location
- required prompt builder functions
- system prompt rules
- user prompt structure
- retry suffix
- expected output schema

### Why
In Task 45, the prompt is part of the actual decisioning logic. It should remain part of the implementation contract, not be treated as an unimportant detail.

---

## Suggested additions to the plan

### Add under storage/schema work
Keep operational decision fields as direct columns, but store richer pipeline trace in one JSONB trace blob.

### Add under DecisionPacket
All packet sections must use stable shapes with empty fallbacks when data is absent.

### Add under validator
Validate treatment codes only against `DecisionPacket.policy.treatments` plus `AGENT_REVIEW` and `NO_ACTION`.

### Add under retry behavior
Use one retry only.

### Add under routing
The new decisioning path becomes the source of truth; do not continue extending the old final prompt assembly flow.

---

## Final recommendation

Task 45 is strong.

The key improvements are:
1. simplify storage of trace data
2. keep DecisionPacket shape stable
3. validate treatment codes against DecisionPacket only
4. keep email validation simple
5. use one retry only
6. make the new decisioning path the only source of truth
7. preserve readability of old decisions

With these refinements, Task 45 should be much cleaner and easier to maintain.
