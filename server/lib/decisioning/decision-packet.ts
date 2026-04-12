export interface DecisionPacketTreatment {
  name: string;
  code: string;
  description?: string;
  enabled: boolean;
}

export interface DecisionPacket {
  customer: {
    customerId: string;
    resolvedSourceFields: Record<string, unknown>;
    businessFields: Record<string, unknown>;
    derivedFields: Record<string, unknown>;
    groupedSourceData: {
      loanData: Record<string, unknown>;
      paymentData: Record<string, unknown>[];
      conversationData: Record<string, unknown>[];
      bureauData: Record<string, unknown>;
      incomeEmploymentData: Record<string, unknown>;
    };
  };
  policy: {
    treatments: DecisionPacketTreatment[];
    treatmentRules: {
      whenToOffer: unknown[];
      blockedIf: unknown[];
    };
    escalationRules: unknown[];
    reviewTriggers: unknown[];
    guardrails: unknown[];
    compliancePolicyInternalRules: unknown[];
  };
  guidance: {
    knowledgeBaseAgentGuidance: unknown[];
    communicationToneGuidance?: string;
  };
  communication: {
    tonePrinciples: string[];
    emailTemplates: unknown[];
    contactPreferences: unknown[];
    outreachCooldownDays?: number;
    lookbackDays?: number;
  };
  sop: {
    text: string;
    sections: unknown[];
  };
}

export interface BuildDecisionPacketInput {
  customerId: string;
  resolvedSourceFields?: Record<string, unknown>;
  businessFields?: Record<string, unknown>;
  derivedFields?: Record<string, unknown>;
  loanData?: Record<string, unknown>;
  paymentData?: Record<string, unknown>[];
  conversationData?: Record<string, unknown>[];
  bureauData?: Record<string, unknown>;
  incomeEmploymentData?: Record<string, unknown>;
  treatments?: DecisionPacketTreatment[];
  whenToOfferRules?: unknown[];
  blockedIfRules?: unknown[];
  escalationRules?: unknown[];
  reviewTriggers?: unknown[];
  guardrails?: unknown[];
  compliancePolicyInternalRules?: unknown[];
  knowledgeBaseAgentGuidance?: unknown[];
  communicationToneGuidance?: string;
  tonePrinciples?: string[];
  emailTemplates?: unknown[];
  contactPreferences?: unknown[];
  outreachCooldownDays?: number;
  lookbackDays?: number;
  sopText?: string;
  sopSections?: unknown[];
}

export function buildDecisionPacket(input: BuildDecisionPacketInput): DecisionPacket {
  return {
    customer: {
      customerId: input.customerId,
      resolvedSourceFields: input.resolvedSourceFields ?? {},
      businessFields: input.businessFields ?? {},
      derivedFields: input.derivedFields ?? {},
      groupedSourceData: {
        loanData: input.loanData ?? {},
        paymentData: input.paymentData ?? [],
        conversationData: input.conversationData ?? [],
        bureauData: input.bureauData ?? {},
        incomeEmploymentData: input.incomeEmploymentData ?? {},
      },
    },
    policy: {
      treatments: input.treatments ?? [],
      treatmentRules: {
        whenToOffer: input.whenToOfferRules ?? [],
        blockedIf: input.blockedIfRules ?? [],
      },
      escalationRules: input.escalationRules ?? [],
      reviewTriggers: input.reviewTriggers ?? [],
      guardrails: input.guardrails ?? [],
      compliancePolicyInternalRules: input.compliancePolicyInternalRules ?? [],
    },
    guidance: {
      knowledgeBaseAgentGuidance: input.knowledgeBaseAgentGuidance ?? [],
      communicationToneGuidance: input.communicationToneGuidance,
    },
    communication: {
      tonePrinciples: input.tonePrinciples ?? [],
      emailTemplates: input.emailTemplates ?? [],
      contactPreferences: input.contactPreferences ?? [],
      outreachCooldownDays: input.outreachCooldownDays,
      lookbackDays: input.lookbackDays,
    },
    sop: {
      text: input.sopText ?? "",
      sections: input.sopSections ?? [],
    },
  };
}
