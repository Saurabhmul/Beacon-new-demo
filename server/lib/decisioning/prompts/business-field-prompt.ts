import type { CatalogEntry } from "../../../field-catalog";

// ─── System Prompt ────────────────────────────────────────────────────────────
// Verbatim — do not edit without updating task spec.

const SYSTEM_PROMPT = `You are Beacon's business-field inference engine.
Your job is to infer exactly ONE business field for ONE customer using only the evidence provided.
You must follow these rules exactly:
1. Use only the provided evidence.
2. Do not use outside knowledge.
3. Do not use generic collections assumptions.
4. Do not use stereotypes.
5. Do not guess.
6. If the evidence is insufficient, contradictory, or too weak, return value = null.
7. If allowed_values are provided, you must return only one of those values or null.
8. If the field is effectively boolean, return only true, false, or null.
9. Your rationale must be short, factual, and based on the evidence.
10. Your evidence array must contain only evidence actually used in your reasoning.
Return valid JSON only. Do not include markdown. Do not include commentary outside the JSON object.`;

export function buildBusinessFieldSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

// ─── Context Sections ─────────────────────────────────────────────────────────

export interface CustomerContextSections {
  customerProfile: Record<string, unknown>;
  loanData: Record<string, unknown>;
  paymentData: unknown[];
  conversationData: unknown[];
  bureauData: Record<string, unknown>;
  derivedFields: Record<string, unknown>;
  priorBusinessFields: Record<string, unknown>;
  truncationWarnings: string[];
}

function renderSection(title: string, data: unknown): string {
  if (data === null || data === undefined) return `${title}: (no data)\n`;
  if (typeof data === "object" && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== ""
    );
    if (entries.length === 0) return `${title}: (no data)\n`;
    const lines = entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");
    return `${title}:\n${lines}\n`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return `${title}: (no data)\n`;
    const lines = data.map((item, i) => `  [${i + 1}] ${JSON.stringify(item)}`).join("\n");
    return `${title}:\n${lines}\n`;
  }
  return `${title}: ${JSON.stringify(data)}\n`;
}

// ─── User Prompt Builder ──────────────────────────────────────────────────────

const RETRY_SUFFIX_TEMPLATE =
  `Your previous response did not match the required schema. VALIDATION FEEDBACK: {{error}}. ` +
  `Please try again and return exactly one valid JSON object matching the required schema. ` +
  `Do not add any text before or after the JSON.`;

export function buildRetryUserPrompt(
  field: CatalogEntry,
  context: CustomerContextSections,
  validationError: string
): string {
  const base = buildBusinessFieldUserPrompt(field, context);
  return `${base}\n\n${RETRY_SUFFIX_TEMPLATE.replace("{{error}}", validationError)}`;
}

export function buildBusinessFieldUserPrompt(
  field: CatalogEntry,
  context: CustomerContextSections
): string {
  const fieldId = field.id ?? field.label;
  const fieldLabel = field.label;
  const displayName = field.displayName ?? field.label;
  const description = field.description ?? "(no description provided)";
  const businessMeaning = field.businessMeaning ?? null;
  const allowedValues = field.allowedValues ?? null;
  const defaultValue = field.defaultValue ?? null;
  const dataType = field.dataType ?? null;

  const hasPriorBusinessFields =
    Object.keys(context.priorBusinessFields).length > 0;

  const lines: string[] = [];

  lines.push(`FIELD TO INFER:`);
  lines.push(`  field_id: ${fieldId}`);
  lines.push(`  field_label: ${fieldLabel}`);
  lines.push(`  display_name: ${displayName}`);
  lines.push(`  description: ${description}`);
  if (businessMeaning) lines.push(`  business_meaning: ${businessMeaning}`);
  if (allowedValues && allowedValues.length > 0) {
    lines.push(`  allowed_values: [${allowedValues.map(v => JSON.stringify(v)).join(", ")}]`);
  } else {
    lines.push(`  allowed_values: (none — accept any value appropriate for the data type)`);
  }
  if (defaultValue !== null) lines.push(`  default_value: ${defaultValue}`);

  if (dataType) {
    lines.push(`  data_type: ${dataType}`);
    lines.push(`  IMPORTANT DATA-TYPE RULE: The returned value MUST conform to data_type "${dataType}".`);
  } else if (allowedValues && allowedValues.length > 0) {
    const inferredType = inferDataTypeFromValues(allowedValues);
    lines.push(`  data_type: (not specified — inferred as "${inferredType}" from allowed_values)`);
    lines.push(`  IMPORTANT DATA-TYPE RULE: Return a value matching type "${inferredType}" or null.`);
  } else {
    const inferredType = inferDataTypeFromDescription(description, businessMeaning);
    lines.push(`  data_type: (not specified — inferred as "${inferredType}" from description/business_meaning)`);
    lines.push(`  IMPORTANT DATA-TYPE RULE: Return a value matching type "${inferredType}" (string or null) unless the field is clearly boolean-like.`);
  }

  lines.push(``);
  lines.push(`CUSTOMER EVIDENCE:`);
  lines.push(renderSection("customerProfile", context.customerProfile));
  lines.push(renderSection("loanData", context.loanData));
  lines.push(renderSection("paymentData", context.paymentData));
  lines.push(renderSection("conversationData", context.conversationData));
  lines.push(renderSection("bureauData", context.bureauData));
  lines.push(renderSection("derivedFields", context.derivedFields));

  if (hasPriorBusinessFields) {
    lines.push(
      `priorBusinessFields (already inferred earlier in this run — use as supporting context only):`
    );
    const priorLines = Object.entries(context.priorBusinessFields)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
    if (priorLines.length > 0) {
      lines.push(priorLines.join("\n"));
    } else {
      lines.push(`  (none)`);
    }
    lines.push(``);
  } else {
    lines.push(`priorBusinessFields: (none inferred yet)\n`);
  }

  if (context.truncationWarnings.length > 0) {
    lines.push(
      `NOTE: Some data sections were truncated to fit context limits: ${context.truncationWarnings.join("; ")}`
    );
    lines.push(``);
  }

  lines.push(`CONFIDENCE RULES:`);
  lines.push(`  - confidence must be a number between 0.0 and 1.0 (inclusive).`);
  lines.push(`  - If value is null, confidence must be ≤ 0.1 (or null).`);
  lines.push(`  - confidence > 0.8 requires multiple strong, corroborated evidence items.`);
  lines.push(`  - Do not assign high confidence based on a single, weak, or ambiguous piece of evidence.`);
  lines.push(``);

  lines.push(`REQUIRED OUTPUT FORMAT (JSON — no markdown, no extra text):`);
  lines.push(`{`);
  lines.push(`  "field_id": "${fieldId}",`);
  lines.push(`  "field_label": "${fieldLabel}",`);
  lines.push(`  "value": <inferred value or null>,`);
  lines.push(`  "confidence": <0.0–1.0 or null>,`);
  lines.push(`  "rationale": "<short factual explanation based on evidence>",`);
  lines.push(`  "null_reason": "<reason why value is null — omit or set to null if value is not null>",`);
  lines.push(`  "evidence": ["<evidence item 1>", "<evidence item 2>", ...]`);
  lines.push(`}`);
  lines.push(``);

  lines.push(
    `FINAL REMINDER: Use only the provided evidence. Do not invent facts. ` +
    `Return valid JSON only. Do not include markdown code fences or any text outside the JSON object.`
  );

  return lines.join("\n");
}

// ─── Data type inference helpers ──────────────────────────────────────────────

function inferDataTypeFromValues(allowedValues: string[]): string {
  const lower = allowedValues.map(v => v.toLowerCase().trim());
  if (
    lower.every(v => ["true", "false", "yes", "no", "1", "0"].includes(v))
  ) {
    return "boolean";
  }
  if (lower.every(v => /^-?\d+(\.\d+)?$/.test(v))) {
    return "number";
  }
  return "string";
}

function inferDataTypeFromDescription(
  description: string | null | undefined,
  businessMeaning: string | null | undefined
): string {
  const combined = `${description ?? ""} ${businessMeaning ?? ""}`.toLowerCase();
  const booleanSignals = [
    "true or false",
    "yes or no",
    "boolean",
    "is active",
    "is enabled",
    "detected",
    "confirmed",
    "flag",
    "indicator",
  ];
  if (booleanSignals.some(s => combined.includes(s))) return "boolean";
  const numberSignals = ["amount", "count", "score", "number of", "days", "rate", "percentage", "total"];
  if (numberSignals.some(s => combined.includes(s))) return "number";
  return "string";
}
