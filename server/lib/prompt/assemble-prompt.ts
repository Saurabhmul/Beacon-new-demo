import * as fs from 'fs';
import * as path from 'path';
import type { CompiledPolicy } from './compile-policy';

function resolvePromptDir(): string {
  try {
    return path.dirname((new URL(import.meta.url)).pathname);
  } catch {
    return __dirname;
  }
}

const promptDir = resolvePromptDir();
const BRAIN_TEMPLATE_PATH = path.join(promptDir, 'brain-template.txt');
const OUTPUT_SCHEMA_PATH = path.join(promptDir, 'output-schema.json');

let brainTemplateCache: string | null = null;
let outputSchemaCache: string | null = null;

export function loadBrainTemplate(): string {
  if (!brainTemplateCache) {
    try {
      brainTemplateCache = fs.readFileSync(BRAIN_TEMPLATE_PATH, 'utf-8');
    } catch {
      brainTemplateCache = fs.readFileSync(path.join(process.cwd(), 'server/lib/prompt/brain-template.txt'), 'utf-8');
    }
  }
  return brainTemplateCache;
}

export function loadOutputSchema(): string {
  if (!outputSchemaCache) {
    try {
      outputSchemaCache = fs.readFileSync(OUTPUT_SCHEMA_PATH, 'utf-8');
    } catch {
      outputSchemaCache = fs.readFileSync(path.join(process.cwd(), 'server/lib/prompt/output-schema.json'), 'utf-8');
    }
  }
  return outputSchemaCache;
}

export function clearTemplateCache(): void {
  brainTemplateCache = null;
  outputSchemaCache = null;
}

export function formatCustomerData(customerData: Record<string, unknown>): string {
  let text = '';

  const id = customerData['customer / account / loan id'] || customerData.customer_id || customerData.account_id || 'unknown';
  text += `Customer ID: ${id}\n`;

  const skipKeys = new Set([
    'customer / account / loan id', 'customer_id', 'account_id',
    'payments', 'conversations', 'income', 'bureau',
    '_payments', '_conversations', '_payment_count', '_conversation_count',
  ]);

  for (const [key, value] of Object.entries(customerData)) {
    if (skipKeys.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    text += `${key}: ${value}\n`;
  }

  const payments = (customerData._payments || customerData.payments) as Record<string, unknown>[] | undefined;
  if (payments && Array.isArray(payments) && payments.length > 0) {
    text += '\nPAYMENT HISTORY:\n';
    for (const p of payments) {
      const parts = Object.entries(p).map(([k, v]) => `${k}: ${v}`);
      text += `  ${parts.join(' | ')}\n`;
    }
  } else {
    text += '\nPAYMENT HISTORY:\n  No payment records available.\n';
  }

  const conversations = (customerData._conversations || customerData.conversations) as Record<string, unknown>[] | undefined;
  if (conversations && Array.isArray(conversations) && conversations.length > 0) {
    text += '\nCONVERSATION HISTORY:\n';
    for (const c of conversations) {
      const parts = Object.entries(c).map(([k, v]) => `${k}: ${v}`);
      text += `  ${parts.join(' | ')}\n`;
    }
  } else {
    text += '\nCONVERSATION HISTORY:\n  No conversation records available.\n';
  }

  if (customerData.income && typeof customerData.income === 'object') {
    text += '\nINCOME & EMPLOYMENT:\n';
    text += `  ${JSON.stringify(customerData.income)}\n`;
  }

  if (customerData.bureau && typeof customerData.bureau === 'object') {
    text += '\nCREDIT BUREAU DATA:\n';
    text += `  ${JSON.stringify(customerData.bureau)}\n`;
  }

  return text;
}

export function assemblePrompt(
  compiledPolicy: CompiledPolicy | Record<string, string>,
  customerData: Record<string, unknown>,
  customOutputSchema?: string
): string {
  const brain = loadBrainTemplate();
  const outputSchema = customOutputSchema || loadOutputSchema();
  const currentDate = new Date().toISOString().split('T')[0];
  const formattedData = formatCustomerData(customerData);

  let prompt = brain;

  const replacements: Record<string, string> = {
    '{{CURRENT_DATE}}': currentDate,
    '{{CONVERSATION_LOOKBACK_DAYS}}': compiledPolicy.lookbackDays || '180',
    '{{OUTREACH_COOLDOWN_DAYS}}': compiledPolicy.cooldownDays || '7',
    '{{POLICY_VULNERABILITY_DEFINITIONS}}': compiledPolicy.vulnerability || '',
    '{{POLICY_AFFORDABILITY_THRESHOLDS}}': compiledPolicy.affordability || '',
    '{{POLICY_DPD_STAGES}}': compiledPolicy.dpdStages || '',
    '{{POLICY_TREATMENT_CATALOG}}': compiledPolicy.treatmentCatalog || '',
    '{{POLICY_TREATMENT_BLOCKLIST}}': compiledPolicy.treatmentBlocklist || '',
    '{{POLICY_DECISION_RULES}}': compiledPolicy.decisionRules || '',
    '{{POLICY_ESCALATION_RULES}}': compiledPolicy.escalation || '',
    '{{POLICY_CONTACT_RULES}}': compiledPolicy.contactRules || '',
    '{{CUSTOMER_DATA}}': formattedData,
    '{{OUTPUT_SCHEMA}}': outputSchema,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(placeholder, value);
  }

  return prompt;
}

export function assemblePreview(
  compiledPolicy: CompiledPolicy | Record<string, string>,
  customOutputSchema?: string
): string {
  const brain = loadBrainTemplate();
  const outputSchema = customOutputSchema || loadOutputSchema();
  const currentDate = new Date().toISOString().split('T')[0];

  let prompt = brain;

  const replacements: Record<string, string> = {
    '{{CURRENT_DATE}}': currentDate,
    '{{CONVERSATION_LOOKBACK_DAYS}}': compiledPolicy.lookbackDays || '180',
    '{{OUTREACH_COOLDOWN_DAYS}}': compiledPolicy.cooldownDays || '7',
    '{{POLICY_VULNERABILITY_DEFINITIONS}}': compiledPolicy.vulnerability || '',
    '{{POLICY_AFFORDABILITY_THRESHOLDS}}': compiledPolicy.affordability || '',
    '{{POLICY_DPD_STAGES}}': compiledPolicy.dpdStages || '',
    '{{POLICY_TREATMENT_CATALOG}}': compiledPolicy.treatmentCatalog || '',
    '{{POLICY_TREATMENT_BLOCKLIST}}': compiledPolicy.treatmentBlocklist || '',
    '{{POLICY_DECISION_RULES}}': compiledPolicy.decisionRules || '',
    '{{POLICY_ESCALATION_RULES}}': compiledPolicy.escalation || '',
    '{{POLICY_CONTACT_RULES}}': compiledPolicy.contactRules || '',
    '{{CUSTOMER_DATA}}': '[Customer data will be injected at runtime]',
    '{{OUTPUT_SCHEMA}}': outputSchema,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(placeholder, value);
  }

  return prompt;
}
