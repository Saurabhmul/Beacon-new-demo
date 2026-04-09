export type RuleGroupLogic = "ALL" | "ANY";

export function toLogicOperator(
  logic: RuleGroupLogic | undefined,
  defaultVal: "AND" | "OR"
): "AND" | "OR" {
  if (logic === "ALL") return "AND";
  if (logic === "ANY") return "OR";
  return defaultVal;
}

export function normalizeDraftPriorities(
  rawPriorities: (number | null | undefined)[]
): string[] {
  if (rawPriorities.length === 0) return [];

  const indexed = rawPriorities.map((p, i) => ({ raw: p ?? null, idx: i }));

  const sorted = [...indexed].sort((a, b) => {
    const aVal = a.raw === null ? Infinity : a.raw;
    const bVal = b.raw === null ? Infinity : b.raw;
    if (aVal !== bVal) return aVal - bVal;
    return a.idx - b.idx;
  });

  const rankByIdx = new Array<string>(rawPriorities.length);
  sorted.forEach((item, rank) => {
    rankByIdx[item.idx] = String(rank + 1);
  });

  return rankByIdx;
}
