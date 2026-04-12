// This engine is deterministic. Do not add AI calls here.

import type { PolicyFieldRecord } from "@shared/schema";
import { topologicalSort } from "../derivation-config";

export interface DerivedFieldTrace {
  field_id: string;
  formula: string;
  inputs_used: Record<string, { value: unknown; sourceKind?: "source_field" | "business_field" | "derived_field" }>;
  output_value: unknown;
  output_type: "number" | "boolean" | "string" | "date-like" | "null";
  configured_type: string | null;
  deduced_type: string | null;
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

function evaluateArithmetic(
  config: Record<string, unknown>,
  sourceMap: Record<string, unknown>
): { value: number | null; nullReason: string | null; warningMessage: string | null; inputsUsed: DerivedFieldTrace["inputs_used"] } {
  const inputsUsed: DerivedFieldTrace["inputs_used"] = {};

  function resolveOperand(
    opType: string | undefined,
    opValue: string | undefined,
    opLabel: string | undefined,
    kind: string
  ): { ok: boolean; num?: number; reason?: string; sourceKey?: string } {
    if (opType === "constant") {
      const n = parseFloat(String(opValue ?? ""));
      if (isNaN(n)) return { ok: false, reason: `constant "${opValue}" is not a valid number` };
      return { ok: true, num: n };
    }
    if (opType === "field" && opValue) {
      const rawVal = resolveFromMap(opValue, sourceMap);
      if (rawVal === null || rawVal === undefined) {
        return { ok: false, reason: `field "${opValue}" resolved to null (missing dependency)` };
      }
      const coerced = safeNumericCoerce(rawVal);
      if (!coerced.ok) return { ok: false, reason: coerced.reason };
      const sk = determineSourceKind(opValue, sourceMap);
      inputsUsed[opLabel || opValue] = { value: rawVal, sourceKind: sk as any };
      return { ok: true, num: coerced.value, sourceKey: opValue };
    }
    return { ok: false, reason: "unknown operand configuration" };
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

  const rawA = resolveFromMap(fieldA, sourceMap);
  if (rawA === null || rawA === undefined) {
    return { value: null, nullReason: "missing dependency", warningMessage: `field "${fieldA}" is null or unresolved`, inputsUsed };
  }
  const coercedA = safeNumericCoerce(rawA);
  if (!coercedA.ok) {
    return { value: null, nullReason: "unsafe coercion", warningMessage: coercedA.reason || "coercion failed", inputsUsed };
  }
  const skA = determineSourceKind(fieldA, sourceMap);
  inputsUsed[fieldALabel || fieldA] = { value: rawA, sourceKind: skA as any };

  const resolvedB = resolveOperand(operandBType, operandBValue, operandBLabel, "B");
  if (!resolvedB.ok) {
    const nr = resolvedB.reason?.includes("null") ? "missing dependency" : "invalid arithmetic input";
    return { value: null, nullReason: nr, warningMessage: resolvedB.reason || "operand B failed", inputsUsed };
  }

  let result = applyOperator(coercedA.value!, resolvedB.num!, operator1 || "+");
  if (result === null) {
    return { value: null, nullReason: "invalid arithmetic input", warningMessage: `unknown operator "${operator1}"`, inputsUsed };
  }

  if (operator2 && operandCType) {
    const resolvedC = resolveOperand(operandCType, operandCValue, operandCLabel, "C");
    if (!resolvedC.ok) {
      const nr = resolvedC.reason?.includes("null") ? "missing dependency" : "invalid arithmetic input";
      return { value: null, nullReason: nr, warningMessage: resolvedC.reason || "operand C failed", inputsUsed };
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

function evaluateLogicalCondition(
  condition: AnyCondition,
  sourceMap: Record<string, unknown>,
  inputsUsed: DerivedFieldTrace["inputs_used"]
): boolean | null {
  if ("conditions" in condition && Array.isArray(condition.conditions)) {
    const group = condition as { operator: string; conditions: AnyCondition[] };
    const results = group.conditions.map(c => evaluateLogicalCondition(c, sourceMap, inputsUsed));
    if (group.operator === "AND") {
      if (results.some(r => r === false)) return false;
      if (results.some(r => r === null)) return null;
      return true;
    } else {
      if (results.some(r => r === true)) return true;
      if (results.some(r => r === null)) return null;
      return false;
    }
  }

  const leaf = condition as { field: string; operator: string; value?: unknown; fieldType?: string };
  const fieldKey = leaf.field;
  const rawVal = resolveFromMap(fieldKey, sourceMap);
  const sk = determineSourceKind(fieldKey, sourceMap);
  inputsUsed[fieldKey] = { value: rawVal, sourceKind: sk as any };

  if (rawVal === null || rawVal === undefined) return null;

  const op = leaf.operator;

  if (op === "is_true") {
    const c = safeBooleanCoerce(rawVal);
    return c.ok ? c.value! : null;
  }
  if (op === "is_false") {
    const c = safeBooleanCoerce(rawVal);
    return c.ok ? !c.value! : null;
  }
  if (op === "exists") return rawVal !== null && rawVal !== undefined;
  if (op === "not_exists") return rawVal === null || rawVal === undefined;

  const compareVal = leaf.value;

  if (op === "in") {
    const arr = Array.isArray(compareVal) ? compareVal : [compareVal];
    return arr.includes(rawVal) || arr.map(String).includes(String(rawVal));
  }
  if (op === "not_in") {
    const arr = Array.isArray(compareVal) ? compareVal : [compareVal];
    return !(arr.includes(rawVal) || arr.map(String).includes(String(rawVal)));
  }
  if (op === "contains") {
    return String(rawVal).toLowerCase().includes(String(compareVal).toLowerCase());
  }

  const numericOps = [">", ">=", "<", "<="];
  if (numericOps.includes(op)) {
    const leftNum = safeNumericCoerce(rawVal);
    const rightNum = safeNumericCoerce(compareVal);
    if (!leftNum.ok || !rightNum.ok) return null;
    switch (op) {
      case ">": return leftNum.value! > rightNum.value!;
      case ">=": return leftNum.value! >= rightNum.value!;
      case "<": return leftNum.value! < rightNum.value!;
      case "<=": return leftNum.value! <= rightNum.value!;
    }
  }

  if (op === "=") return String(rawVal) === String(compareVal);
  if (op === "!=") return String(rawVal) !== String(compareVal);

  return null;
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
  const meta = (sourceMap as any).__meta;
  if (!meta) return undefined;
  if (meta.sourceFields && fieldId in meta.sourceFields) return "source_field";
  if (meta.businessFields && fieldId in meta.businessFields) return "business_field";
  if (meta.derivedFields && fieldId in meta.derivedFields) return "derived_field";
  return undefined;
}

function deduceType(config: Record<string, unknown>): string | null {
  const type = config.type as string | undefined;
  if (!type || type === "arithmetic") return "number";
  if (type === "logical") return "boolean";
  return null;
}

export function computeDerivedFields(
  derivedFields: PolicyFieldRecord[],
  resolvedSourceFields: Record<string, unknown>,
  businessFields: Record<string, unknown>
): DerivedFieldTrace[] {
  const fieldNodes = derivedFields.map(f => ({
    fieldName: f.label,
    dependsOn: extractDependencies(f.derivationConfig as Record<string, unknown> | null),
  }));

  const { sorted, cyclic } = topologicalSort(fieldNodes);

  const cyclicNames = new Set(cyclic.map(c => c.fieldName.toLowerCase()));
  const cyclicGroup = cyclic.map(c => c.fieldName).join(", ");

  const traces: DerivedFieldTrace[] = [];
  const computedValues: Record<string, unknown> = {};

  const sourceMap: Record<string, unknown> = {
    ...resolvedSourceFields,
    ...businessFields,
    __meta: {
      sourceFields: Object.fromEntries(Object.keys(resolvedSourceFields).map(k => [k, true])),
      businessFields: Object.fromEntries(Object.keys(businessFields).map(k => [k, true])),
      derivedFields: {} as Record<string, boolean>,
    },
  };

  const fieldByName = new Map(derivedFields.map(f => [f.label.toLowerCase(), f]));

  for (const node of cyclic) {
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
      warningMessage: `Dependency cycle detected involving: ${cyclicGroup}`,
    });
  }

  for (const node of sorted) {
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
      __meta: {
        sourceFields: Object.fromEntries(Object.keys(resolvedSourceFields).map(k => [k, true])),
        businessFields: Object.fromEntries(Object.keys(businessFields).map(k => [k, true])),
        derivedFields: Object.fromEntries(Object.keys(computedValues).map(k => [k, true])),
      },
    };

    const inputsUsed: DerivedFieldTrace["inputs_used"] = {};
    let outputValue: unknown = null;
    let nullReason: string | null = null;
    let warningMessage: string | null = null;

    const deps = extractDependencies(config);
    let hasMissingDep = false;
    for (const dep of deps) {
      const depLower = dep.toLowerCase();
      const inSource = dep in resolvedSourceFields || Object.keys(resolvedSourceFields).some(k => k.toLowerCase() === depLower);
      const inBusiness = dep in businessFields || Object.keys(businessFields).some(k => k.toLowerCase() === depLower);
      const inComputed = dep in computedValues || Object.keys(computedValues).some(k => k.toLowerCase() === depLower);
      if (!inSource && !inBusiness && !inComputed && !cyclicNames.has(depLower)) {
        const resolved = resolveFromMap(dep, currentSourceMap);
        if (resolved === null || resolved === undefined) {
          const computedDep = Object.keys(computedValues).find(k => k.toLowerCase() === depLower);
          if (computedDep !== undefined && computedValues[computedDep] === null) {
            hasMissingDep = true;
            warningMessage = `upstream derived field "${dep}" evaluated to null`;
            break;
          }
        }
      }
      if (cyclicNames.has(depLower)) {
        hasMissingDep = true;
        warningMessage = `dependency "${dep}" is in a cycle and could not be computed`;
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
      (sourceMap.__meta as any).derivedFields[field.label] = true;
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
      if (logicalResult === null) {
        nullReason = "missing dependency";
        warningMessage = "logical condition could not be evaluated — one or more operands are null";
      } else {
        outputValue = logicalResult;
      }
    } else {
      nullReason = "incompatible formula/type";
      warningMessage = `unknown derivation type "${configType}"`;
    }

    const outputType = classifyOutputType(outputValue);
    let typeMismatchWarning = false;

    if (outputValue !== null && configuredType) {
      const typeMatch = checkTypeMatch(outputType, configuredType);
      if (!typeMatch) {
        typeMismatchWarning = true;
        if (!warningMessage) {
          warningMessage = `configured type "${configuredType}" does not match computed type "${outputType}"`;
        }
      }
    }

    computedValues[field.label] = outputValue;
    (sourceMap.__meta as any).derivedFields[field.label] = true;

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
    if (config.operandBType === "field" && config.operandBValue) deps.push(String(config.operandBValue));
    if (config.operandCType === "field" && config.operandCValue) deps.push(String(config.operandCValue));
    if (config.fieldA) deps.push(String(config.fieldA));
  } else if (type === "logical") {
    const conditions = config.conditions as AnyCondition[] | undefined;
    if (conditions) extractConditionDeps(conditions, deps);
  }
  return [...new Set(deps)];
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
