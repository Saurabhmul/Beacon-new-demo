import type { TreatmentOption, DecisionRule, EscalationRules, AffordabilityRule } from "@shared/schema";

interface DpdStageInput {
  name: string;
  fromDays: number;
  toDays: number;
}

export interface CompiledPolicy {
  dpdStages: string;
  vulnerability: string;
  affordability: string;
  treatmentCatalog: string;
  treatmentBlocklist: string;
  decisionRules: string;
  escalation: string;
  contactRules: string;
  lookbackDays: string;
  cooldownDays: string;
}

export function compileDPDStages(stages: DpdStageInput[]): string {
  if (!stages || stages.length === 0) {
    return 'DPD Stage Definitions:\n- No stages configured\n';
  }
  let text = 'DPD Stage Definitions:\n';
  for (const s of stages) {
    text += `- ${s.name}: ${s.fromDays} to ${s.toDays} DPD\n`;
  }
  return text;
}

export function compileVulnerability(def: string | null | undefined): string {
  if (!def || def.trim() === '') {
    return 'VULNERABILITY POLICY:\nNo vulnerability definition configured. Use general judgment to identify vulnerable customers.\nIf vulnerability = TRUE, Beacon MUST recommend Agent Review.';
  }
  return `VULNERABILITY POLICY:\nA customer is vulnerable if there is credible evidence of:\n${def}\nIf vulnerability = TRUE, Beacon MUST recommend Agent Review.`;
}

export function compileAffordability(rules: AffordabilityRule[] | null | undefined): string {
  if (!rules || rules.length === 0) {
    return 'AFFORDABILITY LABEL RULES:\n- HIGH: NMPC >= 100% of MAD\n- MEDIUM: NMPC >= 60% and < 100% of MAD\n- LOW: NMPC >= 10% and < 60% of MAD\n- VERY LOW: NMPC = 0 OR NMPC < 10% of MAD\n- NOT SURE: Insufficient data to estimate NMPC or MAD missing';
  }

  let text = 'AFFORDABILITY LABEL RULES:\n';
  for (const rule of rules) {
    if (rule.label === 'NOT SURE') {
      text += `- NOT SURE: ${rule.condition || 'Insufficient data to estimate NMPC or MAD missing'}\n`;
    } else {
      const opText = rule.operator === '>=' ? '>=' : rule.operator === '>' ? '>' : rule.operator === '<' ? '<' : rule.operator === '<=' ? '<=' : rule.operator === '=' ? '=' : rule.operator;
      text += `- ${rule.label}: NMPC ${opText} ${rule.percentage}% of MAD`;
      if (rule.condition) {
        text += ` (${rule.condition})`;
      }
      text += '\n';
    }
  }
  return text;
}

export function compileTreatments(
  treatments: TreatmentOption[] | null | undefined,
  dpdStages: DpdStageInput[]
): { catalog: string; blocklist: string } {
  if (!treatments || treatments.length === 0) {
    return {
      catalog: 'AVAILABLE TREATMENTS:\n- No treatments configured\n',
      blocklist: 'TREATMENT BLOCKLIST:\n- None\n'
    };
  }

  let catalog = 'AVAILABLE TREATMENTS:\n';
  let blocklist = 'TREATMENT BLOCKLIST:\n';

  const enabled = treatments.filter(t => t.enabled);
  const disabled = treatments.filter(t => !t.enabled);

  for (const t of enabled) {
    const blocked = t.blockedStages || [];
    const allowed = dpdStages
      .filter(s => !blocked.includes(s.name))
      .map(s => s.name);

    if (allowed.length > 0) {
      catalog += `- ${t.name}: ALLOWED in [${allowed.join(', ')}]\n`;
    } else if (dpdStages.length === 0) {
      catalog += `- ${t.name}: ALLOWED in all stages\n`;
    } else {
      catalog += `- ${t.name}: BLOCKED in all stages\n`;
    }
    if (t.definition) {
      catalog += `  Definition: ${t.definition}\n`;
    }

    if (blocked.length > 0) {
      blocklist += `- ${t.name}: BLOCKED in [${blocked.join(', ')}]\n`;
    }
  }

  if (disabled.length > 0) {
    blocklist += '\nGLOBALLY DISABLED (never recommend):\n';
    for (const t of disabled) {
      blocklist += `- ${t.name}\n`;
    }
  }

  return { catalog, blocklist };
}

export function compileDecisionRules(rules: DecisionRule[] | null | undefined): string {
  if (!rules || rules.length === 0) {
    return 'DECISION RULES (evaluate in order, first match wins):\n- No rules configured. Use Agent Review as default.\n\nDEFAULT: If no rule matches, recommend Agent Review (insufficient data).\n';
  }

  const sorted = [...rules].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  let text = 'DECISION RULES (evaluate in order, first match wins):\n';

  for (const r of sorted) {
    let conditions: string[] = [];
    if (r.otherCondition) conditions.push(r.otherCondition);
    if (r.affordability && r.affordability !== 'ANY')
      conditions.push(`affordability = ${r.affordability}`);
    if (r.willingness && r.willingness !== 'ANY')
      conditions.push(`willingness IN [${r.willingness}]`);

    if (conditions.length > 0) {
      text += `\nRule ${r.priority ?? '?'}: IF ${conditions.join(' AND ')}\n`;
    } else {
      text += `\nRule ${r.priority ?? '?'}: UNCONDITIONAL\n`;
    }
    text += `  THEN recommend: ${r.treatmentName}\n`;
  }

  text += '\nDEFAULT: If no rule matches, recommend Agent Review (insufficient data).\n';
  return text;
}

export function compileEscalation(esc: EscalationRules | null | undefined): string {
  let text = 'ESCALATION RULES - always route to human when:\n';
  text += '- Vulnerability detected (LOCKED - always active)\n';

  if (!esc) return text;

  if (esc.legalAction) text += '- Customer mentions legal action\n';
  if (esc.debtDispute) text += '- Customer disputes the debt\n';
  if (esc.balanceAbove != null) text += `- Balance above ${esc.balanceAbove}\n`;
  if (esc.dpdAbove != null) text += `- DPD above ${esc.dpdAbove} days\n`;
  if (esc.managerRequest) text += '- Customer requests to speak to manager\n';
  if (esc.brokenPtps != null) text += `- Broken PTPs in last 90 days >= ${esc.brokenPtps}\n`;

  if (esc.otherConditions && esc.otherConditions.length > 0) {
    for (const c of esc.otherConditions) {
      text += `- ${c.field} ${c.operator} ${c.value}\n`;
    }
  }

  return text;
}

export function compileContactRules(): string {
  return 'CONTACT RULES:\n- Check last outreach before proposing new contact.\n- Respect cooldown periods between outreach attempts.\n- Prioritize the channel most likely to get a response based on history.\n';
}

export interface CompilePolicyInput {
  dpdStages: DpdStageInput[];
  vulnerabilityDefinition: string | null | undefined;
  affordabilityRules: AffordabilityRule[] | null | undefined;
  treatments: TreatmentOption[] | null | undefined;
  decisionRules: DecisionRule[] | null | undefined;
  escalationRules: EscalationRules | null | undefined;
}

export function compilePolicyPrompt(config: CompilePolicyInput): CompiledPolicy {
  const { catalog, blocklist } = compileTreatments(config.treatments, config.dpdStages);

  return {
    dpdStages: compileDPDStages(config.dpdStages),
    vulnerability: compileVulnerability(config.vulnerabilityDefinition),
    affordability: compileAffordability(config.affordabilityRules),
    treatmentCatalog: catalog,
    treatmentBlocklist: blocklist,
    decisionRules: compileDecisionRules(config.decisionRules),
    escalation: compileEscalation(config.escalationRules),
    contactRules: compileContactRules(),
    lookbackDays: '180',
    cooldownDays: '7',
  };
}
