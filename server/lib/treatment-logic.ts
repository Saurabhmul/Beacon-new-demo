export type RuleGroupLogic = "ALL" | "ANY";

export function toLogicOperator(
  logic: RuleGroupLogic | undefined,
  defaultVal: "AND" | "OR"
): "AND" | "OR" {
  if (logic === "ALL") return "AND";
  if (logic === "ANY") return "OR";
  return defaultVal;
}
