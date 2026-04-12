export const SECTION_CUSTOMER_PROFILE = "customerProfile";
export const SECTION_LOAN_DATA = "loanData";
export const SECTION_PAYMENT_DATA = "paymentData";
export const SECTION_CONVERSATION_DATA = "conversationData";
export const SECTION_BUREAU_DATA = "bureauData";
export const SECTION_INCOME_EMPLOYMENT_DATA = "incomeEmploymentData";
export const SECTION_RESOLVED_SOURCE_FIELDS = "resolvedSourceFields";
export const SECTION_PRIOR_BUSINESS_FIELDS = "priorBusinessFields";
export const SECTION_COMPLIANCE_POLICY_INTERNAL_RULES = "compliancePolicyInternalRules";
export const SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE = "knowledgeBaseAgentGuidance";

export type ContextSections = {
  [SECTION_CUSTOMER_PROFILE]: Record<string, unknown>;
  [SECTION_LOAN_DATA]: Record<string, unknown>;
  [SECTION_PAYMENT_DATA]: Record<string, unknown>[];
  [SECTION_CONVERSATION_DATA]: Record<string, unknown>[];
  [SECTION_BUREAU_DATA]: Record<string, unknown>;
  [SECTION_INCOME_EMPLOYMENT_DATA]: Record<string, unknown>;
  [SECTION_RESOLVED_SOURCE_FIELDS]: Record<string, unknown>;
  [SECTION_PRIOR_BUSINESS_FIELDS]: Record<string, unknown>;
  [SECTION_COMPLIANCE_POLICY_INTERNAL_RULES]: unknown[];
  [SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE]: unknown[];
};

export function emptyContextSections(): ContextSections {
  return {
    [SECTION_CUSTOMER_PROFILE]: {},
    [SECTION_LOAN_DATA]: {},
    [SECTION_PAYMENT_DATA]: [],
    [SECTION_CONVERSATION_DATA]: [],
    [SECTION_BUREAU_DATA]: {},
    [SECTION_INCOME_EMPLOYMENT_DATA]: {},
    [SECTION_RESOLVED_SOURCE_FIELDS]: {},
    [SECTION_PRIOR_BUSINESS_FIELDS]: {},
    [SECTION_COMPLIANCE_POLICY_INTERNAL_RULES]: [],
    [SECTION_KNOWLEDGE_BASE_AGENT_GUIDANCE]: [],
  };
}
