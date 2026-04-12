# Task 44 — Improvement Notes

## Goal
Keep Task 44 deterministic and make the implementation clearer, safer, and easier to maintain.

We are **not** adding a generic AI fallback into the derived-field engine.

Derived fields should remain:
- explainable
- formula-based
- traceable
- stable

If a field cannot be safely computed deterministically, it likely should not be a derived field. It should instead be:
- a business field inferred in Task 38
- or a deterministic formula built on top of a business field

---

## 1. Keep Task 44 deterministic

Please make this explicit in the plan:

- Task 44 remains a deterministic derived-field engine
- if evaluation is unsafe or impossible, return `null`
- log warning in trace
- do not silently call AI from inside Task 44

Reason:
Derived fields should remain simple to explain:
- inputs
- formula
- output

---

## 2. Add deterministic dependency order

Because derived fields may depend on:
- source fields
- business fields
- previously computed derived fields

the engine must compute them in dependency order.

### Required behavior
- build a dependency graph
- evaluate in topological order
- if a required dependency is null or unresolved, evaluate conservatively

Reason:
This is necessary for predictable results.

---

## 3. Add cycle detection explicitly

If derived fields form a cycle, for example:
- Field A depends on Field B
- Field B depends on Field A

then the engine must:
- detect the cycle
- return `null` for affected fields
- log a cycle warning in trace
- continue without crashing

Reason:
Cycle handling is important enough to be explicitly stated in the plan.

---

## 4. Treat income/employment and bureau as source-field categories

Do not build a separate dependency system for these.

### Required behavior
Derived field formulas should resolve dependencies from:
- resolved source fields
- business fields
- previously computed derived fields

Income/employment data and bureau data should be treated as source-field categories inside the resolved source model.

Reason:
This keeps the engine simpler and avoids unnecessary branching.

---

## 5. Use one standard UI warning label

The current plan proposes warning labels like:
- "Type mismatch risk"
- "Formula may not evaluate safely"

Please simplify this.

### Required behavior
Use one standard warning label in the Data Config UI:

- `Type mismatch risk`

Store the detailed reason in the trace / warning message, not as multiple UI labels.

Reason:
This keeps the UI simpler and avoids extra design ambiguity.

---

## 6. Strengthen derived-field trace structure

Please make the trace output more explicit.

### Per-derived-field trace should include
- `field_id`
- `formula`
- `inputs_used`
- `output_value`
- `output_type`
- `configured_type`
- `deduced_type`
- `typeMismatchWarning`
- `nullReason`
- `warningMessage`

Reason:
This will make debugging much easier when a formula returns null or behaves unexpectedly.

---

## 7. Keep compliance / guidance out of raw formulas unless structured

The current plan says:
- compliance policy / internal rules are not numeric inputs unless explicitly configured

Please tighten that.

### Required behavior
For MVP:
- compliance policy text
- internal rule text
- knowledge-base text
should not be used directly as raw formula operands unless already converted into structured fields.

Reason:
Derived-field formulas should operate on structured values, not narrative guidance text.

---

## 8. Clarify simple runtime type classification

When comparing actual result type vs configured or deduced type, keep it simple.

### Use only these practical runtime result categories
- `number`
- `boolean`
- `string`
- `date-like`
- `null`

Do not build a more complex runtime type engine inside Task 44.

Reason:
We want safety, not a large type subsystem.

---

## 9. Keep unsafe evaluation behavior consistent

### Required behavior
If any of these happen:
- unsafe coercion
- invalid arithmetic input
- incompatible formula/type combination
- missing required dependency
- cycle detected

then:
- return `null`
- log warning in trace
- continue

Reason:
Warn + null is the right MVP behavior. Do not throw and do not guess.

---

## Suggested additions to the Task 44 plan

### Add under "What & Why"
Task 44 remains a deterministic engine. It does not use AI fallback. If a field cannot be safely computed deterministically, it should be redesigned as a business field or as a deterministic formula built on top of a business field.

### Add under "Done looks like"
Derived fields are evaluated in dependency order. Cycles are detected and affected fields return null with a cycle warning in trace.

### Add under "Tasks"
- Build dependency graph and evaluate in topological order
- Detect dependency cycles and null out affected fields with warning
- Treat income/employment and bureau as source-field categories
- Use a single UI warning label: `Type mismatch risk`
- Extend trace to include formula, output type, configured type, deduced type, warning message
- Return null consistently on unsafe evaluation; do not call AI from Task 44

---

## Final recommendation

Task 44 should stay deterministic.

The system can still be hybrid overall:
- Task 38 = AI for business/judgment fields
- Task 44 = deterministic for true formula/calculation fields

That is the cleanest and safest architecture.
