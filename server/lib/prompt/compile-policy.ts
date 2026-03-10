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
    return 'AFFORDABILITY LABEL RULES:\n- HIGH: estimated monthly payment capacity >= 100% of minimum amount due\n- MEDIUM: estimated monthly payment capacity >= 60% and < 100% of minimum amount due\n- LOW: estimated monthly payment capacity >= 10% and < 60% of minimum amount due\n- VERY LOW: estimated monthly payment capacity = 0 OR < 10% of minimum amount due\n- NOT SURE: Absolutely no payment data, no conversation data, and no income data exists to estimate capacity';
  }

  let text = 'AFFORDABILITY LABEL RULES:\n';
  for (const rule of rules) {
    if (rule.label === 'NOT SURE') {
      text += `- NOT SURE: ${rule.condition || 'Absolutely no payment data, no conversation data, and no income data exists to estimate capacity'}\n`;
    } else {
      const opText = rule.operator === '>=' ? '>=' : rule.operator === '>' ? '>' : rule.operator === '<' ? '<' : rule.operator === '<=' ? '<=' : rule.operator === '=' ? '=' : rule.operator;
      text += `- ${rule.label}: estimated monthly payment capacity ${opText} ${rule.percentage}% of minimum amount due`;
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

    if (t.name === 'Clear Arrears Plan') {
      const months = t.clearanceMonths || 6;
      const stageList = allowed.length > 0 ? allowed.join(', ') : (dpdStages.length === 0 ? 'all stages' : 'none');
      catalog += `\nTREATMENT: Clear Arrears Plan\n`;
      catalog += `Available in: [${stageList}]\n`;
      catalog += `Definition: Customer pays above minimum amount due to clear arrears within target window.\n`;
      catalog += `Eligibility condition: (estimated monthly payment capacity - minimum amount due) * ${months} >= Total Arrears\n`;
      catalog += `  where ${months} = configured maximum months (client-configurable)\n\n`;
      catalog += `When recommending Clear Arrears Plan, you MUST calculate and include:\n`;
      catalog += `  1. Monthly payment needed = minimum amount due + (Total Arrears / ${months})\n`;
      catalog += `  2. Actual months to clear = ceiling(Total Arrears / (estimated monthly payment capacity - minimum amount due))\n`;
      catalog += `  3. Month-by-month projection showing arrears balance reducing to zero\n\n`;
      catalog += `If (estimated monthly payment capacity - minimum amount due) * ${months} < Total Arrears, this treatment\n`;
      catalog += `does NOT qualify. Skip to next matching decision rule.\n`;
    } else {
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
    const affArr = Array.isArray(r.affordability) ? r.affordability : (r.affordability ? [r.affordability as string] : ['ANY']);
    const willArr = Array.isArray(r.willingness) ? r.willingness : (r.willingness ? [r.willingness as string] : ['ANY']);
    const affFiltered = affArr.filter(v => v !== 'ANY');
    const willFiltered = willArr.filter(v => v !== 'ANY');
    if (affFiltered.length > 0 && !affArr.includes('ANY')) {
      conditions.push(affFiltered.length === 1 ? `affordability = ${affFiltered[0]}` : `affordability IN [${affFiltered.join(', ')}]`);
    }
    if (willFiltered.length > 0 && !willArr.includes('ANY')) {
      conditions.push(willFiltered.length === 1 ? `willingness = ${willFiltered[0]}` : `willingness IN [${willFiltered.join(', ')}]`);
    }

    if (conditions.length > 0) {
      text += `\nRule ${r.priority ?? '?'}: IF ${conditions.join(' AND ')}\n`;
    } else {
      text += `\nRule ${r.priority ?? '?'}: UNCONDITIONAL\n`;
    }

    const treatmentName = r.treatmentName || 'Agent Review';
    if (treatmentName === 'None — Encourage Payment') {
      const target = r.paymentTarget || 'At or above minimum amount due';
      const targetText = target === 'Specific amount' && r.paymentTargetAmount
        ? `Specific amount: ${r.paymentTargetAmount}`
        : target.replace(/\bMAD\b/g, 'minimum amount due');
      text += `  THEN: No loan treatment required — encourage payment.\n`;
      text += `  PAYMENT TARGET: ${targetText}\n`;

      if (target === 'At or above MAD' || target === 'At or above minimum amount due') {
        text += `  EMAIL RULE: The proposed email MUST encourage the customer to pay at least the minimum amount due (MAD). Do NOT suggest that paying below the minimum amount is acceptable or a positive step. Frame the minimum amount as the baseline expectation.\n`;
      } else if (target === 'Any amount they can afford') {
        text += `  EMAIL RULE: The proposed email should encourage any payment the customer can make, even partial amounts below the minimum due. Acknowledge that every payment helps.\n`;
      } else if (target === 'Specific amount' && r.paymentTargetAmount) {
        text += `  EMAIL RULE: The proposed email MUST reference the specific payment amount of ${r.paymentTargetAmount} and encourage the customer to pay at least this amount.\n`;
      }
    } else if (treatmentName === 'Agent Review — Escalate to Human' || treatmentName === 'Agent Review') {
      text += `  THEN recommend: Agent Review — Escalate to Human\n`;
    } else {
      text += `  THEN recommend: ${treatmentName}\n`;
    }

    const tone = r.communicationTone || 'Supportive';
    text += `  COMMUNICATION TONE: ${tone}\n`;
    text += `  Tone guidelines:\n`;
    if (tone === 'Supportive') {
      text += `  - Encourage payment, highlight credit health benefits,\n`;
      text += `    explain how staying current protects their financial\n`;
      text += `    future. Be warm and motivating.\n`;
    } else if (tone === 'Firm') {
      text += `  - Be direct and professional. State that they need to\n`;
      text += `    engage with us so we can help. Explain that continued\n`;
      text += `    non-payment will damage their credit report and have\n`;
      text += `    long-term consequences. Still offer help but create urgency.\n`;
    } else if (tone === 'Urgent') {
      text += `  - Emphasize imminent deadline or escalation. Clear call\n`;
      text += `    to action with specific date.\n`;
    } else if (tone === 'Empathetic') {
      text += `  - Acknowledge their situation, express willingness to find\n`;
      text += `    solutions together, reassure them that engaging with us\n`;
      text += `    is the first step.\n`;
    }
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
