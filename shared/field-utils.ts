export const FIELD_DATA_TYPES = ["string", "number", "boolean", "date", "enum"] as const;
export type FieldDataType = (typeof FIELD_DATA_TYPES)[number];

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const cleaned = trimmed.replace(/,/g, "");
    const num = Number(cleaned);
    if (!isFinite(num)) return null;
    return num;
  }
  return null;
}

export function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(lower)) return true;
    if (["false", "no", "n", "0"].includes(lower)) return false;
    return null;
  }
  return null;
}

const STRICT_DATE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !STRICT_DATE_PATTERN.test(trimmed)) return null;
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return null;
    if (d.getFullYear() < 1900 || d.getFullYear() > 2100) return null;
    return d;
  }
  return null;
}

export function coerceToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

export function safeCoerce(value: unknown, targetType: FieldDataType): unknown {
  switch (targetType) {
    case "number": return toNumber(value);
    case "boolean": return toBoolean(value);
    case "date": return toDate(value);
    case "string": return coerceToString(value);
    case "enum": return coerceToString(value);
    default: return coerceToString(value);
  }
}

export function resolveFieldType(
  userType?: string | null,
  aiType?: string | null,
  deducedType?: string | null,
): FieldDataType {
  const priority = [userType, aiType, deducedType];
  for (const t of priority) {
    if (t && FIELD_DATA_TYPES.includes(t as FieldDataType)) {
      return t as FieldDataType;
    }
  }
  return "string";
}

export interface DerivationTypeResult {
  deducedType: FieldDataType;
  warning: string | null;
}

export function deduceTypeFromDerivation(
  config: { operator1?: string; operator2?: string } | null,
): DerivationTypeResult {
  if (!config) return { deducedType: "string", warning: null };

  const ops = [config.operator1, config.operator2].filter(Boolean) as string[];
  const arithmeticOps = ["+", "-", "*", "/", "%"];
  const comparisonOps = [">", ">=", "<", "<=", "==", "!=", "===", "!=="];

  const hasArithmetic = ops.some(op => arithmeticOps.includes(op));
  const hasComparison = ops.some(op => comparisonOps.includes(op));

  if (hasArithmetic) return { deducedType: "number", warning: null };
  if (hasComparison) return { deducedType: "boolean", warning: null };
  return { deducedType: "string", warning: null };
}

export interface FormulaMismatchResult {
  hasWarning: boolean;
  message: string | null;
}

export function checkFormulaMismatch(
  config: { operator1?: string; operator2?: string; fieldA?: string; operandBType?: string; operandBValue?: string; operandCType?: string; operandCValue?: string } | null,
  fieldTypeMap: Record<string, FieldDataType>,
): FormulaMismatchResult {
  if (!config) return { hasWarning: false, message: null };

  const arithmeticOps = ["+", "-", "*", "/", "%"];
  const ops = [config.operator1, config.operator2].filter(Boolean) as string[];
  const hasArithmetic = ops.some(op => arithmeticOps.includes(op));

  if (!hasArithmetic) return { hasWarning: false, message: null };

  const fieldsUsed: string[] = [];
  if (config.fieldA) fieldsUsed.push(config.fieldA);
  if (config.operandBType === "field" && config.operandBValue) fieldsUsed.push(config.operandBValue);
  if (config.operandCType === "field" && config.operandCValue) fieldsUsed.push(config.operandCValue);

  const incompatible = fieldsUsed.filter(fId => {
    const ft = fieldTypeMap[fId];
    return ft === "enum" || ft === "string";
  });

  if (incompatible.length > 0) {
    return {
      hasWarning: true,
      message: "Type mismatch risk — arithmetic formula references text/enum fields. Result may evaluate to null at runtime.",
    };
  }

  return { hasWarning: false, message: null };
}

export function inferBusinessFieldType(
  allowedValues?: string[] | null,
  description?: string | null,
): FieldDataType {
  if (allowedValues && allowedValues.length > 0 && allowedValues.length <= 20) {
    return "enum";
  }
  if (description) {
    const lower = description.toLowerCase();
    if (/\b(yes\s*\/?\s*no|true\s*\/?\s*false|flag|boolean)\b/.test(lower)) {
      return "boolean";
    }
    if (/\b(amount|count|percentage|ratio|rate|score|balance|total|sum|number of)\b/.test(lower)) {
      return "number";
    }
    if (/\b(date|timestamp|when|day|month|year)\b/.test(lower)) {
      return "date";
    }
  }
  return "string";
}
