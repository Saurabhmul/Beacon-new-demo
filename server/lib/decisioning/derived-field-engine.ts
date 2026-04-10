import type { CatalogEntry } from "../../field-catalog";
import type {
  DerivedFieldResult,
  DerivedFieldTrace,
  DerivedFieldStatus,
  StageMetrics,
} from "./types";
import type {
  ArithmeticDerivationConfig,
  LogicalDerivationConfig,
  LogicalConditionLeaf,
  LogicalConditionGroup,
} from "@shared/schema";
import { topologicalSort } from "../derivation-config";

// ─── Coercion Helpers ─────────────────────────────────────────────────────────

const TRUTHY_STRINGS = new Set(["true", "yes", "1", "on"]);
const FALSY_STRINGS = new Set(["false", "no", "0", "off"]);

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUTHY_STRINGS.has(s)) return 1;
    if (FALSY_STRINGS.has(s)) return 0;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  return null;
}

export function toBoolean(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
    return null;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUTHY_STRINGS.has(s)) return true;
    if (FALSY_STRINGS.has(s)) return false;
    return null;
  }
  return null;
}

export function toStringValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return String(v);
}

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ─── Arithmetic Evaluation ────────────────────────────────────────────────────

function applyArithmeticOp(
  a: number,
  op: string,
  b: number
): number | null {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? null : a / b;
    default: return null;
  }
}

function evaluateArithmetic(
  config: ArithmeticDerivationConfig,
  resolvedValues: Record<string, unknown>
): { value: number | null; inputsUsed: string[]; nullReason?: string; error?: string } {
  const inputsUsed: string[] = [];

  // Resolve fieldA
  const rawA = resolvedValues[config.fieldA];
  if (rawA === undefined) {
    return { value: null, inputsUsed, nullReason: `Input field "${config.fieldA}" not found in resolved values` };
  }
  inputsUsed.push(config.fieldA);
  const a = toNumber(rawA);
  if (a === null) {
    return { value: null, inputsUsed, nullReason: `Cannot coerce "${config.fieldA}" value (${JSON.stringify(rawA)}) to number` };
  }

  // Resolve operandB
  let b: number | null = null;
  if (config.operandBType === "constant") {
    b = toNumber(config.operandBValue);
    if (b === null) {
      return { value: null, inputsUsed, nullReason: `Cannot parse constant operandB "${config.operandBValue}" as number` };
    }
  } else {
    const rawB = resolvedValues[config.operandBValue];
    if (rawB === undefined) {
      return { value: null, inputsUsed, nullReason: `Input field "${config.operandBValue}" (operandB) not found in resolved values` };
    }
    inputsUsed.push(config.operandBValue);
    b = toNumber(rawB);
    if (b === null) {
      return { value: null, inputsUsed, nullReason: `Cannot coerce "${config.operandBValue}" value (${JSON.stringify(rawB)}) to number` };
    }
  }

  let result = applyArithmeticOp(a, config.operator1, b);
  if (result === null) {
    return { value: null, inputsUsed, nullReason: `Division by zero in operator "${config.operator1}"` };
  }

  // Optionally resolve operandC
  if (config.operator2 && config.operandCType && config.operandCValue !== undefined) {
    let c: number | null = null;
    if (config.operandCType === "constant") {
      c = toNumber(config.operandCValue ?? null);
      if (c === null) {
        return { value: null, inputsUsed, nullReason: `Cannot parse constant operandC "${config.operandCValue}" as number` };
      }
    } else {
      const rawC = resolvedValues[config.operandCValue!];
      if (rawC === undefined) {
        return { value: null, inputsUsed, nullReason: `Input field "${config.operandCValue}" (operandC) not found in resolved values` };
      }
      inputsUsed.push(config.operandCValue!);
      c = toNumber(rawC);
      if (c === null) {
        return { value: null, inputsUsed, nullReason: `Cannot coerce "${config.operandCValue}" value (${JSON.stringify(rawC)}) to number` };
      }
    }
    const result2 = applyArithmeticOp(result, config.operator2, c);
    if (result2 === null) {
      return { value: null, inputsUsed, nullReason: `Division by zero in operator "${config.operator2}"` };
    }
    result = result2;
  }

  return { value: result, inputsUsed };
}

// ─── Logical Condition Evaluation ─────────────────────────────────────────────

function evaluateLeaf(
  leaf: LogicalConditionLeaf,
  resolvedValues: Record<string, unknown>
): boolean | null {
  const fieldValue = resolvedValues[leaf.field];
  const op = leaf.operator;

  // is_true / is_false don't need a value
  if (op === "is_true") {
    const b = toBoolean(fieldValue);
    return b === null ? null : b;
  }
  if (op === "is_false") {
    const b = toBoolean(fieldValue);
    return b === null ? null : !b;
  }

  // For all other operators, if the field isn't present, we can't evaluate
  if (fieldValue === undefined) return null;

  const expected = leaf.value;

  switch (op) {
    case "=":
      return toStringValue(fieldValue) === toStringValue(expected ?? null);
    case "!=":
      return toStringValue(fieldValue) !== toStringValue(expected ?? null);
    case ">": {
      const n = toNumber(fieldValue);
      const e = toNumber(expected ?? null);
      return n !== null && e !== null ? n > e : null;
    }
    case ">=": {
      const n = toNumber(fieldValue);
      const e = toNumber(expected ?? null);
      return n !== null && e !== null ? n >= e : null;
    }
    case "<": {
      const n = toNumber(fieldValue);
      const e = toNumber(expected ?? null);
      return n !== null && e !== null ? n < e : null;
    }
    case "<=": {
      const n = toNumber(fieldValue);
      const e = toNumber(expected ?? null);
      return n !== null && e !== null ? n <= e : null;
    }
    case "in": {
      if (!Array.isArray(expected)) return null;
      const fStr = toStringValue(fieldValue);
      return fStr !== null ? expected.map(String).includes(fStr) : null;
    }
    case "not_in": {
      if (!Array.isArray(expected)) return null;
      const fStr = toStringValue(fieldValue);
      return fStr !== null ? !expected.map(String).includes(fStr) : null;
    }
    case "contains": {
      const fStr = toStringValue(fieldValue);
      const eStr = toStringValue(expected ?? null);
      return fStr !== null && eStr !== null ? fStr.includes(eStr) : null;
    }
    default:
      return null;
  }
}

function evaluateConditionNode(
  node: LogicalConditionLeaf | LogicalConditionGroup,
  resolvedValues: Record<string, unknown>
): boolean | null {
  if ("conditions" in node) {
    const group = node as LogicalConditionGroup;
    const results = group.conditions.map(c => evaluateConditionNode(c, resolvedValues));
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
  return evaluateLeaf(node as LogicalConditionLeaf, resolvedValues);
}

function evaluateLogical(
  config: LogicalDerivationConfig,
  resolvedValues: Record<string, unknown>
): { value: boolean | null; inputsUsed: string[]; nullReason?: string } {
  const inputsUsed: string[] = [];

  // Collect all field references for inputsUsed
  function collectFields(node: LogicalConditionLeaf | LogicalConditionGroup) {
    if ("conditions" in node) {
      (node as LogicalConditionGroup).conditions.forEach(collectFields);
    } else {
      const leaf = node as LogicalConditionLeaf;
      if (!inputsUsed.includes(leaf.field)) inputsUsed.push(leaf.field);
    }
  }
  config.conditions.forEach(collectFields);

  const results = config.conditions.map(c => evaluateConditionNode(c, resolvedValues));
  let value: boolean | null = null;

  if (config.operator === "AND") {
    if (results.some(r => r === false)) value = false;
    else if (results.some(r => r === null)) value = null;
    else value = true;
  } else {
    if (results.some(r => r === true)) value = true;
    else if (results.some(r => r === null)) value = null;
    else value = false;
  }

  const nullReason = value === null
    ? "One or more condition fields are missing or unevaluable"
    : undefined;

  return { value, inputsUsed, nullReason };
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

function buildFormulaSummary(entry: CatalogEntry): string {
  if (entry.derivationSummary) return entry.derivationSummary;
  if (!entry.derivationConfig) return "no formula defined";
  const cfg = entry.derivationConfig;
  if ((cfg as ArithmeticDerivationConfig).operator1) {
    const a = (cfg as ArithmeticDerivationConfig);
    return `${a.fieldALabel || a.fieldA} ${a.operator1} ${a.operandBLabel || a.operandBValue}`;
  }
  return "logical expression";
}

/**
 * Evaluate all derived fields in topological dependency order.
 *
 * Outputs per field:
 *   "computed" — formula evaluated successfully
 *   "null"     — missing input or unevaluable (cannot compute, but not an error)
 *   "error"    — runtime failure or cycle detected
 *   "skipped"  — field config incomplete or field not referenced/required
 *
 * null and skipped are strictly separate:
 *   null   = field is configured, but inputs aren't available right now
 *   skipped = field is not configured well enough to evaluate
 */
export function evaluateDerivedFields(
  catalog: CatalogEntry[],
  resolvedValues: Record<string, unknown>
): DerivedFieldResult {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const derivedEntries = catalog.filter(e => e.sourceType === "derived_field");

  const values: Record<string, unknown> = {};
  const traces: Record<string, DerivedFieldTrace> = {};

  if (derivedEntries.length === 0) {
    const completedAt = new Date().toISOString();
    return {
      values,
      traces,
      stageMetrics: {
        startedAt,
        completedAt,
        durationMs: Date.now() - startMs,
        counts: { computed: 0, null: 0, error: 0, skipped: 0 },
      },
    };
  }

  // Build FieldNode graph for topological sort
  const fieldNodes = derivedEntries.map(entry => {
    const deps: string[] = [];
    const cfg = entry.derivationConfig;
    if (cfg) {
      if ((cfg as ArithmeticDerivationConfig).operator1) {
        const a = cfg as ArithmeticDerivationConfig;
        deps.push(a.fieldA);
        if (a.operandBType === "field") deps.push(a.operandBValue);
        if (a.operandCType === "field" && a.operandCValue) deps.push(a.operandCValue);
      } else if ((cfg as LogicalDerivationConfig).type === "logical") {
        const l = cfg as LogicalDerivationConfig;
        function extractFields(node: LogicalConditionLeaf | LogicalConditionGroup) {
          if ("conditions" in node) {
            (node as LogicalConditionGroup).conditions.forEach(extractFields);
          } else {
            deps.push((node as LogicalConditionLeaf).field);
          }
        }
        l.conditions.forEach(extractFields);
      }
    }
    return { fieldName: entry.label, dependsOn: deps };
  });

  const { sorted, cyclic } = topologicalSort(fieldNodes);

  // Mark cyclic fields as error
  for (const node of cyclic) {
    const entry = derivedEntries.find(e => e.label === node.fieldName);
    if (!entry) continue;
    const formula = buildFormulaSummary(entry);
    const cycleDesc = `Dependency cycle detected for "${node.fieldName}" (depends on: ${node.dependsOn.join(", ")})`;
    traces[entry.label] = {
      status: "error",
      formula,
      inputsUsed: node.dependsOn,
      outputValue: null,
      error: cycleDesc,
    };
  }

  // Working values include both resolved source values and computed derived values
  const workingValues: Record<string, unknown> = { ...resolvedValues };

  // Evaluate in topological order
  for (const node of sorted) {
    const entry = derivedEntries.find(e => e.label === node.fieldName);
    if (!entry) continue;

    const formula = buildFormulaSummary(entry);
    const cfg = entry.derivationConfig;

    // Skipped: no derivation config
    if (!cfg) {
      traces[entry.label] = {
        status: "skipped",
        formula: "no formula defined",
        inputsUsed: [],
        outputValue: null,
        nullReason: "No derivation config defined for this field",
      };
      continue;
    }

    try {
      let status: DerivedFieldStatus = "computed";
      let outputValue: unknown = null;
      let inputsUsed: string[] = [];
      let nullReason: string | undefined;
      let error: string | undefined;

      if ((cfg as ArithmeticDerivationConfig).operator1 !== undefined) {
        const result = evaluateArithmetic(cfg as ArithmeticDerivationConfig, workingValues);
        inputsUsed = result.inputsUsed;
        if (result.error) {
          status = "error";
          error = result.error;
        } else if (result.value === null) {
          status = "null";
          nullReason = result.nullReason;
        } else {
          outputValue = result.value;
        }
      } else if ((cfg as LogicalDerivationConfig).type === "logical") {
        const result = evaluateLogical(cfg as LogicalDerivationConfig, workingValues);
        inputsUsed = result.inputsUsed;
        if (result.value === null) {
          status = "null";
          nullReason = result.nullReason;
        } else {
          outputValue = result.value;
        }
      } else {
        // Unknown derivation config type
        status = "skipped";
        nullReason = `Unknown derivation config type`;
      }

      const trace: DerivedFieldTrace = {
        status,
        formula,
        inputsUsed,
        outputValue: status === "computed" ? outputValue : null,
      };
      if (nullReason !== undefined) trace.nullReason = nullReason;
      if (error !== undefined) trace.error = error;

      traces[entry.label] = trace;

      if (status === "computed") {
        // Index by label for chained derivation dependencies (derivation configs reference by label)
        workingValues[entry.label] = outputValue;
        // Index by canonical ID (entry.id) so rule evaluator can find via leftFieldId
        if (entry.id && entry.id !== entry.label) {
          workingValues[entry.id] = outputValue;
        }
        // Output values: primary key is canonical ID; label alias is also included
        if (entry.id && entry.id !== entry.label) {
          values[entry.id] = outputValue;
        }
        values[entry.label] = outputValue;
      }
    } catch (err) {
      traces[entry.label] = {
        status: "error",
        formula,
        inputsUsed: [],
        outputValue: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const completedAt = new Date().toISOString();

  const counts: Record<string, number> = { computed: 0, null: 0, error: 0, skipped: 0 };
  for (const trace of Object.values(traces)) {
    counts[trace.status] = (counts[trace.status] ?? 0) + 1;
  }

  return {
    values,
    traces,
    stageMetrics: {
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      counts,
    },
  };
}
