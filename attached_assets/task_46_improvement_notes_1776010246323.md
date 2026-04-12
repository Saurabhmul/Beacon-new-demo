# Task 46 — Improvement Notes

## Goal
Keep the review queue very slim and make the decision detail page the main place for depth, traceability, and supporting context.

The current Task 46 plan is strong. These notes are small refinements to make implementation cleaner and more predictable.

---

## 1. Add explicit legacy fallback behavior on the detail page

The queue already mentions graceful fallback for older decisions.  
Please make this explicit for the detail page too.

### Required behavior
If a decision was generated before the new v2.1 trace/output fields existed:

- show whatever legacy fields are available
- hide unavailable new sections gracefully
- show a small message such as:
  - `"This decision was generated before v2.1 detail tracing was available."`

### Why
This prevents blank or broken sections for historical records.

---

## 2. Use `decision_trace_json` as the primary source for new decisions

The plan currently says the page may read from `aiRawOutput` or `customerData`.

Please tighten this.

### Required behavior
For new decisions:
- primary detail source = `decision_trace_json`
- direct columns = summary/supporting fields

For old decisions:
- fallback = legacy columns / old trace fields / customer data

### Why
This avoids mixed-source logic and keeps the new UI tied cleanly to the new pipeline output.

---

## 3. Keep Source Data card order fixed

The Source Data section is a good idea, but the card order should stay consistent.

### Recommended order
1. Loan Data
2. Payment History
3. Conversations
4. Income & Employment
5. Bureau

Only render a card if that category has data.

### Why
Stable ordering makes the UI easier to scan and easier to maintain.

---

## 4. Keep Business Fields and Derived Fields collapsible

Sections 3 and 4 can become long.

### Required behavior
- both sections should be collapsible
- default collapsed when the section is large
- default open only if the content is very small or if current UX already depends on that

### Why
This keeps the page readable and avoids overwhelming the agent.

---

## 5. Keep “Policy & Guidance Used” focused

This is a good feature, but it can get noisy if it dumps too much.

### Required behavior
Show only:
- the specific compliance rules referenced
- the specific knowledge-base / guidance items referenced

Do not show the entire policy dump or entire knowledge-base dump in this section.

### Why
Agents need to see what influenced the recommendation, not every possible rule in the system.

---

## 6. Add explicit empty states for each section

Please do not leave sections visually blank.

### Suggested empty states
- `"No source data available"`
- `"No business fields available"`
- `"No derived fields available"`
- `"No policy or guidance items were used"`
- `"No email draft generated"`

### Why
Clear empty states are better than missing UI.

---

## 7. Use one consistent source for “Last AI Run Date”

Please make this explicit.

### Required behavior
Choose one source and use it consistently in both queue and detail:
- either the decision record creation timestamp
- or an explicit run timestamp stored in the trace

Do not mix multiple date sources in different places.

### Why
This avoids confusing differences between queue and detail views.

---

## 8. Add explicit Recommended Treatment fallback for old decisions

The queue already says recommended treatment should fall back gracefully.

Please define the exact fallback order.

### Required behavior
For old decisions, Recommended Treatment should resolve in this order:
1. `recommended_treatment_name`
2. legacy `proposed_solution`
3. `"Unknown"`

### Why
This avoids blank treatment labels for historical decisions.

---

## Suggested additions to the Task 46 plan

### Add under Review Queue
Recommended Treatment should fall back in order:
- `recommended_treatment_name`
- legacy `proposed_solution`
- `"Unknown"`

### Add under Decision Detail Page
For new decisions, use `decision_trace_json` as the primary source.
For old decisions, use legacy fields and show a small v2.1-unavailable message where relevant.

### Add under Section 2 (Source Data)
Keep card order fixed:
- Loan Data
- Payment History
- Conversations
- Income & Employment
- Bureau

### Add under Sections 3 & 4
Both sections should be collapsible and should use clear empty states.

### Add under Policy & Guidance Used
Show only the specific rules/guidance items referenced by the recommendation, not the full source dump.

### Add under dates
Use one consistent source for “Last AI Run Date” across queue and detail.

---

## Final recommendation

Task 46 is already strong.

The key refinements are:
1. explicit legacy fallback on detail page
2. `decision_trace_json` as primary source for new decisions
3. fixed Source Data card order
4. collapsible Business/Derived sections
5. focused Policy & Guidance Used section
6. clear empty states
7. consistent Last AI Run Date source
8. explicit Recommended Treatment fallback for old decisions

With these refinements, Task 46 should be clean and ready for implementation.
