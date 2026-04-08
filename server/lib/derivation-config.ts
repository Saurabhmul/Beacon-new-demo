import { z } from "zod";
import type { LogicalDerivationConfig, LogicalConditionLeaf, LogicalConditionGroup } from "@shared/schema";

const COMPARISON_OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains", "is_true", "is_false"] as const;

export const LogicalConditionLeafSchema = z.object({
  field: z.string().min(1),
  fieldType: z.enum(["source", "derived", "business"]).optional(),
  operator: z.enum(COMPARISON_OPERATORS),
  value: z.union([
    z.string(),
    z.number(),
    z.array(z.union([z.string(), z.number()])),
  ]).optional(),
});

type AnyLogicalCondition = LogicalConditionLeaf | LogicalConditionGroup;

export const LogicalConditionSchema: z.ZodType<AnyLogicalCondition> = z.lazy(() =>
  z.union([
    LogicalConditionLeafSchema,
    z.object({
      operator: z.enum(["AND", "OR"] as const),
      conditions: z.array(LogicalConditionSchema).min(1),
    }),
  ])
);

export const LogicalDerivationConfigSchema = z.object({
  type: z.literal("logical"),
  operator: z.enum(["AND", "OR"] as const),
  conditions: z.array(LogicalConditionSchema).min(1),
});

export type ValidatedLogicalDerivationConfig = z.infer<typeof LogicalDerivationConfigSchema>;

export function isLogicalDerivationConfig(config: unknown): config is LogicalDerivationConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    "type" in config &&
    (config as Record<string, unknown>).type === "logical"
  );
}

function buildConditionSummary(c: AnyLogicalCondition): string {
  if ("conditions" in c) {
    const sub = (c as LogicalConditionGroup).conditions.map(buildConditionSummary).join(` ${c.operator} `);
    return `(${sub})`;
  }
  const leaf = c as LogicalConditionLeaf;
  const noValueOps = new Set(["is_true", "is_false"]);
  if (noValueOps.has(leaf.operator)) return `${leaf.field} ${leaf.operator}`;
  const val = Array.isArray(leaf.value) ? `[${leaf.value.join(", ")}]` : String(leaf.value ?? "");
  return `${leaf.field} ${leaf.operator} ${val}`;
}

export function generateLogicalDerivationSummary(config: LogicalDerivationConfig): string {
  if (!config.conditions || config.conditions.length === 0) return "";
  return config.conditions.map(buildConditionSummary).join(` ${config.operator} `);
}

export interface FieldNode {
  fieldName: string;
  dependsOn: string[];
}

export interface TopologicalSortResult {
  sorted: FieldNode[];
  cyclic: FieldNode[];
}

export function topologicalSort(fields: FieldNode[]): TopologicalSortResult {
  const nameSet = new Set(fields.map(f => f.fieldName.toLowerCase()));
  const inDegree = new Map<string, number>();
  const reverseAdj = new Map<string, string[]>();

  for (const f of fields) {
    const key = f.fieldName.toLowerCase();
    if (!inDegree.has(key)) inDegree.set(key, 0);
    if (!reverseAdj.has(key)) reverseAdj.set(key, []);
    for (const dep of f.dependsOn) {
      const depKey = dep.toLowerCase();
      if (!nameSet.has(depKey)) continue;
      inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      if (!reverseAdj.has(depKey)) reverseAdj.set(depKey, []);
      reverseAdj.get(depKey)!.push(key);
    }
  }

  const queue: string[] = Array.from(inDegree.entries())
    .filter(([, deg]) => deg === 0)
    .map(([key]) => key);

  const sortedKeys: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sortedKeys.push(cur);
    for (const dependent of (reverseAdj.get(cur) ?? [])) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  const sortedSet = new Set(sortedKeys);
  const fieldByKey = new Map(fields.map(f => [f.fieldName.toLowerCase(), f]));

  const sorted = sortedKeys.map(k => fieldByKey.get(k)!).filter(Boolean);
  const cyclic = fields.filter(f => !sortedSet.has(f.fieldName.toLowerCase()));

  return { sorted, cyclic };
}

export function validateFieldDependencies(
  field: FieldNode,
  availableNames: Set<string>
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const dep of field.dependsOn) {
    if (!availableNames.has(dep.toLowerCase())) {
      missing.push(dep);
    }
  }
  return { valid: missing.length === 0, missing };
}
