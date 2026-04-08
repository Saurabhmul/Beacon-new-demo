import { z } from "zod";
import type { LogicalDerivationConfig } from "@shared/schema";

const LOGICAL_OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains", "is_true", "is_false"] as const;

export const LogicalConditionSchema = z.object({
  field: z.string().min(1),
  fieldType: z.enum(["source", "derived", "business"]).optional(),
  operator: z.enum(LOGICAL_OPERATORS),
  value: z.union([
    z.string(),
    z.number(),
    z.array(z.union([z.string(), z.number()])),
  ]).optional(),
});

export const LogicalDerivationConfigSchema = z.object({
  type: z.literal("logical"),
  operator: z.enum(["AND", "OR"]),
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

export function generateLogicalDerivationSummary(config: LogicalDerivationConfig): string {
  if (!config.conditions || config.conditions.length === 0) return "";
  const parts = config.conditions.map(c => {
    const noValueOps = new Set(["is_true", "is_false"]);
    if (noValueOps.has(c.operator)) return `${c.field} ${c.operator}`;
    const val = Array.isArray(c.value) ? `[${c.value.join(", ")}]` : String(c.value ?? "");
    return `${c.field} ${c.operator} ${val}`;
  });
  return parts.join(` ${config.operator} `);
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
  const adjacency = new Map<string, string[]>();

  for (const f of fields) {
    const key = f.fieldName.toLowerCase();
    if (!inDegree.has(key)) inDegree.set(key, 0);
    if (!adjacency.has(key)) adjacency.set(key, []);
    for (const dep of f.dependsOn) {
      const depKey = dep.toLowerCase();
      if (!nameSet.has(depKey)) continue;
      adjacency.get(key)!.push(depKey);
      inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      if (!adjacency.has(depKey)) adjacency.set(depKey, []);
    }
  }

  const queue: string[] = [];
  for (const [key, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(key);
  }

  const sortedKeys: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sortedKeys.push(cur);
    for (const [key, deps] of adjacency.entries()) {
      if (deps.includes(cur)) {
        const newDeg = (inDegree.get(key) ?? 1) - 1;
        inDegree.set(key, newDeg);
        if (newDeg === 0) queue.push(key);
      }
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
