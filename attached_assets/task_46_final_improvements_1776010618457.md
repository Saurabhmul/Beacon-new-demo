# Task 46 — Improvement Notes

## Goal
Keep the review queue very slim and make the decision detail page the main place for depth, traceability, and supporting context.

The current Task 46 plan is already strong. These notes are small refinements to make implementation cleaner and more predictable.

---

## 1. Define Customer ID fallback explicitly

The queue uses `customerGuid`, which is good for new decisions.

Please define fallback behavior for older decisions too.

### Recommended fallback order
1. `customerGuid`
2. `customer_guid`
3. legacy customer identifier if available
4. `"Unknown"`

### Why
Older records may not use the exact same field shape.

---

## 2. Define the status badge source explicitly

Section 1 says to show a status badge.

Please make it explicit which field drives that badge.

### Recommended behavior
Use the decision record status field consistently, for example:
- pending
- approved
- rejected
- needs_review

Do not invent a different badge source between queue and detail.

### Why
This avoids inconsistent UI state.

---

## 3. Only render Source Data cards when there is meaningful data

Section 2 card order is now well defined, which is good.

Please also define “has data” clearly.

### Required behavior
Do **not** render a card when the category is:
- `null`
- `{}`
- `[]`
- empty string

Only render the card when it contains meaningful non-empty content.

### Why
This prevents empty-looking cards from cluttering the detail page.

---

## 4. Clarify `used_rules` cross-reference logic

The “Policy & Guidance Used” sub-section is a strong idea.

Please make matching logic more explicit.

### Recommended matching order
1. direct ID match
2. exact label/title match
3. otherwise do not show the item

### Why
Real data may contain a mix of IDs, codes, and human-readable names. This keeps matching practical without overengineering.

---

## 5. Use one stable legacy fallback message

Sections 3 and 4 already say to show a legacy fallback message for old decisions.

Please keep the wording identical everywhere.

### Recommended message
`This decision was generated before v2.1 detail tracing was available.`

### Why
Consistent wording makes the fallback feel intentional and polished.

---

## 6. Clarify `structured_assessments` rendering when value is null

The shape is fixed, which is good:
- `name`
- `value`
- `reason`

Please define rendering for `value = null`.

### Recommended behavior
- show the `name`
- render `value` as `—` or `None`
- still show the `reason`

### Why
The reason may still be useful even when the value is null.

---

## Suggested additions to the Task 46 plan

### Add under Review Queue
Customer ID should fall back in order:
- `customerGuid`
- `customer_guid`
- legacy identifier
- `"Unknown"`

### Add under Top Summary
Define exactly which field drives the status badge and use it consistently.

### Add under Section 2
Only render a Source Data card if the category contains meaningful non-empty content.

### Add under Policy & Guidance Used
Cross-reference `used_rules` to policy/guidance items by:
1. ID first
2. exact label/title second

### Add under legacy fallback
Use the same fallback message wording across Sections 3 and 4:
`This decision was generated before v2.1 detail tracing was available.`

### Add under structured assessments
When `value` is null, render a simple placeholder but still show the `reason`.

---

## Final recommendation

Task 46 is already very good.

The main remaining refinements are:
1. explicit Customer ID fallback
2. explicit status badge source
3. only render source cards with real content
4. practical `used_rules` cross-reference logic
5. one stable legacy fallback message
6. clear null rendering for `structured_assessments`

With these refinements, Task 46 should be ready for implementation.
