# Task 43 — Final Improvement Notes

## Goal
Task 43 is already strong. These notes are small refinements to make implementation clearer and more consistent.

---

## 1. Define what counts as a flagged item in truncation logic

The current plan says:
- keep latest N items
- keep flagged items
- summarize the remainder

Please make **flagged items** explicit so implementation is consistent.

### Suggested rule
For payment history, flagged items can include:
- missed payment
- failed payment
- returned payment
- delinquent payment
- arrangement / promise-related payment event

For conversation history, flagged items can include:
- hardship mention
- vulnerability mention
- complaint
- escalation
- legal/compliance concern
- explicit refusal / promise / dispute

Reason:
Without this, different implementations may interpret "flagged" differently.

---

## 2. Store truncation counts in a per-section structure

The current plan says:
- `original_count / retained_count — for each truncated section`

Please make this structure explicit.

### Suggested structure
```ts
truncationMetrics: {
  paymentData?: { originalCount: number; retainedCount: number };
  conversationData?: { originalCount: number; retainedCount: number };
}
```

Keep:
- `truncated_sections`
- `summarization_used`

But store counts per section rather than as loose generic fields.

Reason:
This is clearer and easier to debug.

---

## 3. Clarify evidence normalization behavior

The current plan says:
- evidence types outside the allowed set are rejected or normalized

Please make this more precise:

### Suggested rule
- if an evidence type can be safely mapped to one of the allowed types, normalize it
- otherwise drop that evidence item
- do not fail the whole field unless the entire response becomes unusable

Allowed evidence types remain:
- `source_field`
- `business_field`
- `conversation`
- `payment`
- `bureau`
- `income_employment`
- `compliance_rule`
- `knowledge_guidance`

Reason:
This is more practical than failing whole field inference because of one bad evidence label.

---

## 4. Repeat missing metadata fallback in the Tasks section

The "Done looks like" section already says inference continues when metadata is missing.

Please also state this explicitly inside the implementation tasks:

If any of these are missing:
- `data_type`
- `allowed_values`
- `default_value`
- `business_meaning`

the field must still be inferred using whatever metadata exists.

Do not fail or skip the field because metadata is incomplete.

Reason:
This is important enough to repeat in the action items.

---

## 5. Normalize confidence consistently

Please make confidence behavior explicit:

- confidence should always be normalized to `0–1`
- if the inferred value is `null`, confidence should be `null` or low (for example `<= 0.1`)
- do not allow high confidence on very weak evidence

Reason:
This keeps the field traces consistent and easier to interpret later.

---

## 6. Define context section names as shared constants

Task 43 now depends on named sections such as:
- `customerProfile`
- `loanData`
- `paymentData`
- `conversationData`
- `bureauData`
- `incomeEmploymentData`
- `resolvedSourceFields`
- `priorBusinessFields`
- `compliancePolicyInternalRules`
- `knowledgeBaseAgentGuidance`

Please define these section names centrally as shared constants rather than using ad hoc strings across files.

Reason:
This avoids string drift, typos, and inconsistent trace values.

---

## Suggested additions to the plan

### Add under deterministic history truncation
Define flagged items explicitly for payment history and conversation history so truncation behavior is consistent.

### Add under trace
Store truncation counts in a per-section structure, for example:
- `truncationMetrics.paymentData`
- `truncationMetrics.conversationData`

### Add under output validation
If an evidence type is outside the allowed set:
- normalize when safely mappable
- otherwise drop that evidence item
- do not fail the whole field unless necessary

### Add under task steps
Repeat explicitly that missing metadata must not fail inference.

### Add under trace / confidence
Confidence must remain normalized to `0–1`, and null values must carry null/low confidence.

### Add under implementation detail
Define context section names as shared constants.

---

## Final recommendation

Task 43 is now in very good shape.

The most important remaining refinements are:

1. explicitly define flagged items for truncation
2. make truncation metrics per-section
3. tighten evidence normalization behavior
4. repeat missing metadata fallback in the task steps
5. normalize confidence consistently
6. define context section names centrally

With these refinements, Task 43 should be ready for implementation.
