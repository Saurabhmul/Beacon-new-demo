// This engine is deterministic. Do not add AI calls here.

import type { PolicyFieldRecord } from "@shared/schema";
import { topologicalSort, type FieldNode } from "../derivation-config";

interface SourceMapMeta {
  sourceFields: Record<string, boolean>;
  businessFields: Record<string, boolean>;
  derivedFields: Record<string, boolean>;
  narrativeTextFields: Record<string, boolean>;
}

export interface DerivedFieldTrace {
  field_id: string;
  formula: string;
  inputs_used: Record<string, { value: unknown; sourceKind?: "source_field" | "business_field" | "derived_field" }>;
  output_value: unknown;
  output_type: "number" | "boolean" | "string" | "date-like" | "null";
  configured_type: string | null;
  deduced_type: string;
  typeMismatchWarning: boolean;
  nullReason: string | null;
  warningMessage: string | null;
}

const SAFE_BOOLEAN_STRINGS: Record<string, boolean> = {
  "true": true, "yes": true, "1": true,
  "false": false, "no": false, "0": false,
};

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

function classifyOutputType(val: unknown): "number" | "boolean" | "string" | "date-like" | "null" {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "number") return "number";
  if (typeof val === "string") {
    if (ISO_DATE_REGEX.test(val)) return "date-like";
    return "string";
  }
  return "string";
}

function safeNumericCoerce(val: unknown): { ok: boolean; value?: number; reason?: string } {
  if (typeof val === "number") return { ok: true, value: val };
  if (typeof val === "boolean") return { ok: false, reason: "boolean → number coercion is unsafe" };
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: true, value: parseFloat(trimmed) };
    return { ok: false, reason: `"${trimmed}" cannot be safely coerced to number` };
  }
  return { ok: false, reason: "unsupported type for numeric coercion" };
}

function safeBooleanCoerce(val: unknown): { ok: boolean; value?: boolean; reason?: string } {
  if (typeof val === "boolean") return { ok: true, value: val };
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase();
    if (lower in SAFE_BOOLEAN_STRINGS) return { ok: true, value: SAFE_BOOLEAN_STRINGS[lower] };
    return { ok: false, reason: `"${val}" cannot be safely coerced to boolean` };
  }
  return { ok: false, reason: "unsafe coercion to boolean" };
}

function getSourceMapMeta(sourceMap: Record<string, unknown>): SourceMapMeta | undefined {
  const raw = sourceMap["__meta"];
  if (raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as SourceMapMeta;
  }
  return undefined;
}

/**
 * Returns true only when the field is tagged as a narrative text source in the caller-supplied
 * provenance metadata. No heuristics are applied — callers are responsible for accurately
 * declaring which fields carry unstructured guidance text.
 */
function isNarrativeTextField(fieldId: string, sourceMap: Record<string, unknown>): boolean {
  const meta = getSourceMapMeta(sourceMap);
  if (!meta) return false;
  if (fieldId in meta.narrativeTextFields) return true;
  return Object.keys(meta.narrativeTextFields).some(k => k.toLowerCase() === fieldId.toLowerCase());
}

function evaluateArithmetic(
  config: Record<string, unknown>,
  sourceMap: Record<string, unknown>
): { value: number | null; nullReason: string | null; warningMessage: string | null; inputsUsed: DerivedFieldTrace["inputs_used"] } {
  const inputsUsed: DerivedFieldTrace["inputs_used"] = {};

  function resolveOperand(
    opType: string | undefined,
    opValue: string | undefined,
    opLabel: string | undefined,
  ): { ok: boolean; num?: number; reason?: string; nullReason?: string } {
    if (opType === "constant") {
      const n = parseFloat(String(opValue ?? ""));
      if (isNaN(n)) return { ok: false, reason: `constant "${opValue}" is not a valid number`, nullReason: "invalid arithmetic input" };
      return { ok: true, num: n };
    }
    if (opType === "field" && opValue) {
      if (isNarrativeTextField(opValue, sourceMap)) {
        return { ok: false, reason: `field "${opValue}" is a narrative text source and cannot be used as an arithmetic operand`, nullReason: "unstructured guidance operand" };
      }
      const rawVal = resolveFromMap(opValue, sourceMap);
      if (rawVal === null || rawVal === undefined) {
        return { ok: false, reason: `field "${opValue}" resolved to null (missing dependency)`, nullReason: "missing dependency" };
      }
      const coerced = safeNumericCoerce(rawVal);
      if (!coerced.ok) return { ok: false, reason: coerced.reason, nullReason: "unsafe coercion" };
      const sk = determineSourceKind(opValue, sourceMap);
      inputsUsed[opLabel || opValue] = { value: rawVal, sourceKind: sk };
      return { ok: true, num: coerced.value };
    }
    return { ok: false, reason: "unknown operand configuration", nullReason: "incompatible formula/type" };
  }

  const fieldA = config.fieldA as string | undefined;
  const fieldALabel = config.fieldALabel as string | undefined;
  const operator1 = config.operator1 as string | undefined;
  const operandBType = config.operandBType as string | undefined;
  const operandBValue = config.operandBValue as string | undefined;
  const operandBLabel = config.operandBLabel as string | undefined;
  const operator2 = config.operator2 as string | undefined;
  const operandCType = config.operandCType as string | undefined;
  const operandCValue = config.operandCValue as string | undefined;
  const operandCLabel = config.operandCLabel as string | undefined;

  if (!fieldA) return { value: null, nullReason: "incompatible formula/type", warningMessage: "fieldA not configured", inputsUsed };

  if (isNarrativeTextField(fieldA, sourceMap)) {
    return { value: null, nullReason: "unstructured guidance operand", warningMessage: `field "${fieldA}" is a narrative text source and cannot be used as an arithmetic operand`, inputsUsed };
  }

  const rawA = resolveFromMap(fieldA, sourceMap);
  if (rawA === null || rawA === undefined) {
    return { value: null, nullReason: "missing dependency", warningMessage: `field "${fieldA}" is null or unresolved`, inputsUsed };
  }
  const coercedA = safeNumericCoerce(rawA);
  if (!coercedA.ok) {
    return { value: null, nullReason: "unsafe coercion", warningMessage: coercedA.reason || "coercion failed", inputsUsed };
  }
  const skA = determineSourceKind(fieldA, sourceMap);
  inputsUsed[fieldALabel || fieldA] = { value: rawA, sourceKind: skA };

  const resolvedB = resolveOperand(operandBType, operandBValue, operandBLabel);
  if (!resolvedB.ok) {
    return { value: null, nullReason: resolvedB.nullReason || "invalid arithmetic input", warningMessage: resolvedB.reason || "operand B failed", inputsUsed };
  }

  let result = applyOperator(coercedA.value!, resolvedB.num!, operator1 || "+");
  if (result === null) {
    return { value: null, nullReason: "invalid arithmetic input", warningMessage: `unknown operator "${operator1}"`, inputsUsed };
  }

  if (operator2 && operandCType) {
    const resolvedC = resolveOperand(operandCType, operandCValue, operandCLabel);
    if (!resolvedC.ok) {
      return { value: null, nullReason: resolvedC.nullReason || "invalid arithmetic input", warningMessage: resolvedC.reason || "operand C failed", inputsUsed };
    }
    const r2 = applyOperator(result, resolvedC.num!, operator2);
    if (r2 === null) {
      return { value: null, nullReason: "invalid arithmetic input", warningMessage: `unknown operator "${operator2}"`, inputsUsed };
    }
    result = r2;
  }

  return { value: result, nullReason: null, warningMessage: null, inputsUsed };
}

function applyOperator(a: number, b: number, op: string): number | null {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? null : a / b;
    case "%": return b === 0 ? null : a % b;
    default: return null;
  }
}

type AnyCondition = Record<string, unknown>;

type LogicalEvalResult =
  | { kind: "value"; value: boolean }
  | { kind: "null"; nullReason: string; warningMessage: string }
  | { kind: "narrative" };

function evaluateLogicalCondition(
  condition: AnyCondition,
  sourceMap: Record<string, unknown>,
  inputsUsed: DerivedFieldTrace["inputs_used"]
): LogicalEvalResult {
  if ("conditions" in condition && Array.isArray(condition.conditions)) {
    const group = condition as { operator: string; conditions: AnyCondition[] };
    const results = group.conditions.map(c => evaluateLogicalCondition(c, sourceMap, inputsUsed));

    if (results.some(r => r.kind === "narrative")) return { kind: "narrative" };

    if (group.operator === "AND") {
      if (results.some(r => r.kind === "value" && !r.value)) return { kind: "value", value: false };
      const firstNull = results.find((r): r is Extract<LogicalEvalResult, { kind: "null" }> => r.kind === "null");
      if (firstNull) return firstNull;
      return { kind: "value", value: true };
    } else {
      if (results.some(r => r.kind === "value" && r.value)) return { kind: "value", value: true };
      const firstNull = results.find((r): r is Extract<LogicalEvalResult, { kind: "null" }> => r.kind === "null");
      if (firstNull) return firstNull;
      return { kind: "value", value: false };
    }
  }

  const leaf = condition as { field: string; operator: string; value?: unknown; fieldType?: string };
  const fieldKey = leaf.field;

  if (isNarrativeTextField(fieldKey, sourceMap)) {
    inputsUsed[fieldKey] = { value: null, sourceKind: undefined };
    return { kind: "narrative" };
  }

  const rawVal = resolveFromMap(fieldKey, sourceMap);
  const sk = determineSourceKind(fieldKey, sourceMap);
  inputsUsed[fieldKey] = { value: rawVal, sourceKind: sk };

  if (rawVal === null || rawVal === undefined) {
    return { kind: "null", nullReason: "missing dependency", warningMessage: `field "${fieldKey}" is null or missing` };
  }

  const op = leaf.operator;

  if (op === "is_true") {
    const c = safeBooleanCoerce(rawVal);
    if (!c.ok) return { kind: "null", nullReason: "unsafe coercion", warningMessage: c.reason || `cannot coerce "${fieldKey}" to boolean for is_true` };
    return { kind: "value", value: c.value! };
  }
  if (op === "is_false") {
    const c = safeBooleanCoerce(rawVal);
    if (!c.ok) return { kind: "null", nullReason: "unsafe coercion", warningMessage: c.reason || `cannot coerce "${fieldKey}" to boolean for is_false` };
    return { kind: "value", value: !c.value! };
  }
  if (op === "exists") return { kind: "value", value: rawVal !== null && rawVal !== undefined };
  if (op === "not_exists") return { kind: "value", value: rawVal === null || rawVal === undefined };

  const compareVal = leaf.value;

  if (op === "in") {
    const arr = Array.isArray(compareVal) ? compareVal : [compareVal];
    return { kind: "value", value: arr.includes(rawVal) || arr.map(String).includes(String(rawVal)) };
  }
  if (op === "not_in") {
    const arr = Array.isArray(compareVal) ? compareVal : [compareVal];
    return { kind: "value", value: !(arr.includes(rawVal) || arr.map(String).includes(String(rawVal))) };
  }
  if (op === "contains") {
    return { kind: "value", value: String(rawVal).toLowerCase().includes(String(compareVal).toLowerCase()) };
  }

  const numericOps = [">", ">=", "<", "<="];
  if (numericOps.includes(op)) {
    const leftNum = safeNumericCoerce(rawVal);
    const rightNum = safeNumericCoerce(compareVal);
    if (!leftNum.ok) return { kind: "null", nullReason: "unsafe coercion", warningMessage: leftNum.reason || `cannot coerce field "${fieldKey}" to number` };
    if (!rightNum.ok) return { kind: "null", nullReason: "unsafe coercion", warningMessage: rightNum.reason || `cannot coerce comparison value to number` };
    switch (op) {
      case ">": return { kind: "value", value: leftNum.value! > rightNum.value! };
      case ">=": return { kind: "value", value: leftNum.value! >= rightNum.value! };
      case "<": return { kind: "value", value: leftNum.value! < rightNum.value! };
      case "<=": return { kind: "value", value: leftNum.value! <= rightNum.value! };
    }
  }

  if (op === "=") return { kind: "value", value: String(rawVal) === String(compareVal) };
  if (op === "!=") return { kind: "value", value: String(rawVal) !== String(compareVal) };

  return { kind: "null", nullReason: "incompatible formula/type", warningMessage: `unknown logical operator "${op}"` };
}

function resolveFromMap(fieldId: string, sourceMap: Record<string, unknown>): unknown {
  if (fieldId in sourceMap) return sourceMap[fieldId];
  const lower = fieldId.toLowerCase();
  for (const [k, v] of Object.entries(sourceMap)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function determineSourceKind(
  fieldId: string,
  sourceMap: Record<string, unknown>
): "source_field" | "business_field" | "derived_field" | undefined {
  const meta = getSourceMapMeta(sourceMap);
  if (!meta) return undefined;
  const lower = fieldId.toLowerCase();
  if (Object.keys(meta.sourceFields).some(k => k.toLowerCase() === lower)) return "source_field";
  if (Object.keys(meta.businessFields).some(k => k.toLowerCase() === lower)) return "business_field";
  if (Object.keys(meta.derivedFields).some(k => k.toLowerCase() === lower)) return "derived_field";
  return undefined;
}

/**
 * Best-effort type deduction from config:
 *  - arithmetic (explicit or implicit default) → "number"
 *  - logical → "boolean"
 *  - anything else (unclear/mixed/unknown) → "string" as a safe fallback
 */
function deduceType(config: Record<string, unknown>): string {
  const type = config.type as string | undefined;
  if (!type || type === "arithmetic") return "number";
  if (type === "logical") return "boolean";
  return "string";
}

function makeSourceMapMeta(
  resolvedSourceFields: Record<string, unknown>,
  businessFields: Record<string, unknown>,
  computedValues: Record<string, unknown>,
  narrativeTextFields: Record<string, boolean>
): SourceMapMeta {
  return {
    sourceFields: Object.fromEntries(Object.keys(resolvedSourceFields).map(k => [k, true])),
    businessFields: Object.fromEntries(Object.keys(businessFields).map(k => [k, true])),
    derivedFields: Object.fromEntries(Object.keys(computedValues).map(k => [k, true])),
    narrativeTextFields,
  };
}

/**
 * Among the nodes that Kahn's algorithm could not sort (because their in-degree never
 * reaches 0), identify which ones are truly IN a cycle (i.e. can reach themselves via
 * a directed path within the unsorted subgraph). The remainder are merely downstream-
 * blocked: they depend on a cyclic node but are not themselves part of any cycle.
 */
function partitionCyclicNodes(unsortedNodes: FieldNode[]): {
  trulyCyclic: FieldNode[];
  downstreamBlocked: FieldNode[];
} {
  const unsortedSet = new Set(unsortedNodes.map(n => n.fieldName.toLowerCase()));

  const adj = new Map<string, string[]>();
  for (const node of unsortedNodes) {
    const key = node.fieldName.toLowerCase();
    adj.set(
      key,
      node.dependsOn.map(d => d.toLowerCase()).filter(d => unsortedSet.has(d))
    );
  }

  const trulyCyclicSet = new Set<string>();
  for (const node of unsortedNodes) {
    const start = node.fieldName.toLowerCase();
    if (trulyCyclicSet.has(start)) continue;
    const visited = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    outer: while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === start) {
        trulyCyclicSet.add(start);
        break outer;
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const next of (adj.get(cur) ?? [])) {
        stack.push(next);
      }
    }
  }

  return {
    trulyCyclic: unsortedNodes.filter(n => trulyCyclicSet.has(n.fieldName.toLowerCase())),
    downstreamBlocked: unsortedNodes.filter(n => !trulyCyclicSet.has(n.fieldName.toLowerCase())),
  };
}

/**
 * Compute all derived fields in dependency order.
 *
 * @param derivedFields       Derived PolicyFieldRecords from the policy configuration.
 * @param resolvedSourceFields Scalar values resolved from structured source fields.
 * @param businessFields       Scalar AI-inferred business field values.
 * @param narrativeTextFieldIds Optional map of field IDs/labels that carry raw narrative text
 *                              (compliance rulebook sections, knowledge-base guidance, etc.)
 *                              and must NOT be used as formula operands. The caller is responsible
 *                              for declaring these accurately. Any operand matching a key in this
 *                              map produces nullReason = "unstructured guidance operand".
 */
export function computeDerivedFields(
  derivedFields: PolicyFieldRecord[],
  resolvedSourceFields: Record<string, unknown>,
  businessFields: Record<string, unknown>,
  narrativeTextFieldIds: Record<string, boolean> = {}
): DerivedFieldTrace[] {
  const fieldNodes = derivedFields.map(f => ({
    fieldName: f.label,
    dependsOn: extractDependencies(f.derivationConfig as Record<string, unknown> | null),
  }));

  const { sorted: topoSorted, cyclic: topoUnsorted } = topologicalSort(fieldNodes);

  const { trulyCyclic, downstreamBlocked } = partitionCyclicNodes(topoUnsorted);
  const cyclicNames = new Set(trulyCyclic.map(c => c.fieldName.toLowerCase()));
  const cyclicGroup = trulyCyclic.map(c => c.fieldName).join(", ");

  const traces: DerivedFieldTrace[] = [];
  const computedValues: Record<string, unknown> = {};

  const fieldByName = new Map(derivedFields.map(f => [f.label.toLowerCase(), f]));

  for (const node of trulyCyclic) {
    const field = fieldByName.get(node.fieldName.toLowerCase());
    if (!field) continue;
    const config = (field.derivationConfig || {}) as Record<string, unknown>;
    traces.push({
      field_id: String(field.id),
      formula: field.derivationSummary || JSON.stringify(config),
      inputs_used: {},
      output_value: null,
      output_type: "null",
      configured_type: field.dataType || null,
      deduced_type: deduceType(config),
      typeMismatchWarning: false,
      nullReason: "cycle detected",
      warningMessage: cyclicGroup ? `Dependency cycle detected involving: ${cyclicGroup}` : "Dependency cycle detected",
    });
    computedValues[field.label] = null;
  }

  // Topologically sort downstream-blocked nodes among themselves so that any
  // inter-blocked dependencies are correctly ordered and null propagates with the most
  // precise provenance (upstream-null derived field) rather than "field not found".
  const { sorted: sortedBlocked } = topologicalSort(downstreamBlocked);
  const evalOrder = [...topoSorted, ...sortedBlocked];

  for (const node of evalOrder) {
    const field = fieldByName.get(node.fieldName.toLowerCase());
    if (!field) continue;

    const config = (field.derivationConfig || {}) as Record<string, unknown>;
    const formulaStr = field.derivationSummary || JSON.stringify(config);
    const configuredType = field.dataType || null;
    const deducedType = deduceType(config);

    const currentSourceMap: Record<string, unknown> = {
      ...resolvedSourceFields,
      ...businessFields,
      ...computedValues,
      __meta: makeSourceMapMeta(resolvedSourceFields, businessFields, computedValues, narrativeTextFieldIds),
    };

    const inputsUsed: DerivedFieldTrace["inputs_used"] = {};
    let outputValue: unknown = null;
    let nullReason: string | null = null;
    let warningMessage: string | null = null;

    const deps = extractDependencies(config);
    let hasMissingDep = false;
    for (const dep of deps) {
      const depLower = dep.toLowerCase();

      if (cyclicNames.has(depLower)) {
        hasMissingDep = true;
        warningMessage = `dependency "${dep}" is in a cycle and could not be computed`;
        break;
      }

      const computedDepKey = Object.keys(computedValues).find(k => k.toLowerCase() === depLower);
      if (computedDepKey !== undefined && computedValues[computedDepKey] === null) {
        hasMissingDep = true;
        warningMessage = `upstream derived field "${dep}" evaluated to null`;
        break;
      }

      const inSource = dep in resolvedSourceFields || Object.keys(resolvedSourceFields).some(k => k.toLowerCase() === depLower);
      const inBusiness = dep in businessFields || Object.keys(businessFields).some(k => k.toLowerCase() === depLower);
      const inComputed = computedDepKey !== undefined;
      if (!inSource && !inBusiness && !inComputed) {
        hasMissingDep = true;
        warningMessage = `field "${dep}" not found in any source, business, or computed fields`;
        break;
      }
    }

    if (hasMissingDep) {
      nullReason = "missing dependency";
      traces.push({
        field_id: String(field.id),
        formula: formulaStr,
        inputs_used: inputsUsed,
        output_value: null,
        output_type: "null",
        configured_type: configuredType,
        deduced_type: deducedType,
        typeMismatchWarning: false,
        nullReason,
        warningMessage,
      });
      computedValues[field.label] = null;
      continue;
    }

    const configType = config.type as string | undefined;

    if (!configType || configType === "arithmetic") {
      const arithResult = evaluateArithmetic(config, currentSourceMap);
      Object.assign(inputsUsed, arithResult.inputsUsed);
      if (arithResult.nullReason) {
        nullReason = arithResult.nullReason;
        warningMessage = arithResult.warningMessage;
      } else {
        outputValue = arithResult.value;
      }
    } else if (configType === "logical") {
      const logicalResult = evaluateLogicalCondition(config as AnyCondition, currentSourceMap, inputsUsed);
      if (logicalResult.kind === "narrative") {
        nullReason = "unstructured guidance operand";
        warningMessage = "logical condition references a narrative text field that cannot be used as an operand";
      } else if (logicalResult.kind === "null") {
        nullReason = logicalResult.nullReason;
        warningMessage = logicalResult.warningMessage;
      } else {
        outputValue = logicalResult.value;
      }
    } else {
      nullReason = "incompatible formula/type";
      warningMessage = `unknown derivation type "${configType}"; type deduction fell back to "string"`;
    }

    const outputType = classifyOutputType(outputValue);
    let typeMismatchWarning = false;

    // Compare against configured type first; fall back to deduced type.
    const effectiveType = configuredType ?? deducedType;
    if (outputValue !== null && effectiveType) {
      const typeMatch = checkTypeMatch(outputType, effectiveType);
      if (!typeMatch) {
        typeMismatchWarning = true;
        if (!warningMessage) {
          const src = configuredType ? "configured" : "deduced";
          warningMessage = `${src} type "${effectiveType}" does not match computed type "${outputType}"`;
        }
      }
    }

    computedValues[field.label] = outputValue;

    traces.push({
      field_id: String(field.id),
      formula: formulaStr,
      inputs_used: inputsUsed,
      output_value: outputValue !== null ? outputValue : null,
      output_type: outputValue !== null ? outputType : "null",
      configured_type: configuredType,
      deduced_type: deducedType,
      typeMismatchWarning,
      nullReason: nullReason,
      warningMessage,
    });
  }

  return traces;
}

function checkTypeMatch(outputType: string, configuredType: string): boolean {
  const c = configuredType.toLowerCase();
  if (c === "number" || c === "numeric" || c === "float" || c === "integer") return outputType === "number";
  if (c === "boolean" || c === "bool") return outputType === "boolean";
  if (c === "date" || c === "date-like") return outputType === "date-like";
  if (c === "string" || c === "text") return outputType === "string" || outputType === "date-like";
  return true;
}

function extractDependencies(config: Record<string, unknown> | null): string[] {
  if (!config) return [];
  const deps: string[] = [];
  const type = config.type as string | undefined;

  if (!type || type === "arithmetic") {
    if (config.fieldA) deps.push(String(config.fieldA));
    if (config.operandBType === "field" && config.operandBValue) deps.push(String(config.operandBValue));
    if (config.operandCType === "field" && config.operandCValue) deps.push(String(config.operandCValue));
  } else if (type === "logical") {
    const conditions = config.conditions as AnyCondition[] | undefined;
    if (conditions) extractConditionDeps(conditions, deps);
  }
  return Array.from(new Set(deps));
}

function extractConditionDeps(conditions: AnyCondition[], out: string[]): void {
  for (const c of conditions) {
    if ("conditions" in c && Array.isArray(c.conditions)) {
      extractConditionDeps(c.conditions as AnyCondition[], out);
    } else if ("field" in c && typeof c.field === "string") {
      out.push(c.field);
    }
  }
}

export function buildResolvedSourceFieldsMap(
  customerData: Record<string, unknown>,
  policyFields: PolicyFieldRecord[]
): Record<string, unknown> {
  const sourceFields = policyFields.filter(f => f.sourceType === "source_field");
  const result: Record<string, unknown> = {};
  for (const field of sourceFields) {
    const val = customerData[field.label] ?? customerData[field.label.toLowerCase()];
    if (val !== undefined) result[field.label] = val;
  }
  return result;
}
