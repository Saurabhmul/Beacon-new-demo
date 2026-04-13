import { describe, it, expect } from "vitest";
import { buildDecisionPacket } from "../server/lib/decisioning/decision-packet";
import { buildFinalDecisionUserPrompt } from "../server/lib/decisioning/prompts/final-decision-prompt";

const VULN_ESCALATION_RULE = {
  vulnerabilityDetected: true as const,
  legalAction: false,
  debtDispute: false,
  balanceAbove: null,
  dpdAbove: null,
  managerRequest: false,
  brokenPtps: null,
  otherConditions: [],
};

const COMPLIANCE_RULE = { id: "vuln", title: "Vulnerability", text: "Flag vulnerable customers for agent review" };

describe("buildDecisionPacket — escalation and compliance rule wiring", () => {
  it("passes escalationRules through to packet.policy.escalationRules", () => {
    const packet = buildDecisionPacket({
      customerId: "CUST-TEST-001",
      escalationRules: [VULN_ESCALATION_RULE],
      compliancePolicyInternalRules: [COMPLIANCE_RULE],
    });

    expect(packet.policy.escalationRules).toHaveLength(1);
    expect((packet.policy.escalationRules[0] as typeof VULN_ESCALATION_RULE).vulnerabilityDetected).toBe(true);
  });

  it("passes compliancePolicyInternalRules through to packet.policy", () => {
    const packet = buildDecisionPacket({
      customerId: "CUST-TEST-001",
      escalationRules: [VULN_ESCALATION_RULE],
      compliancePolicyInternalRules: [COMPLIANCE_RULE],
    });

    expect(packet.policy.compliancePolicyInternalRules).toHaveLength(1);
    expect((packet.policy.compliancePolicyInternalRules[0] as typeof COMPLIANCE_RULE).id).toBe("vuln");
  });

  it("defaults escalationRules to [] when not provided", () => {
    const packet = buildDecisionPacket({ customerId: "CUST-TEST-002" });
    expect(packet.policy.escalationRules).toEqual([]);
  });

  it("defaults compliancePolicyInternalRules to [] when not provided", () => {
    const packet = buildDecisionPacket({ customerId: "CUST-TEST-002" });
    expect(packet.policy.compliancePolicyInternalRules).toEqual([]);
  });
});

describe("buildFinalDecisionUserPrompt — escalation rules appear non-empty in prompt", () => {
  it("serializes escalationRules into the == ESCALATION RULES == section (not [])", () => {
    const packet = buildDecisionPacket({
      customerId: "CUST-TEST-003",
      escalationRules: [VULN_ESCALATION_RULE],
      compliancePolicyInternalRules: [COMPLIANCE_RULE],
    });

    const prompt = buildFinalDecisionUserPrompt(packet);

    expect(prompt).toContain("== ESCALATION RULES ==");
    expect(prompt).toContain("vulnerabilityDetected");

    const escSection = prompt.split("== ESCALATION RULES ==")[1].split("==")[0].trim();
    expect(escSection).not.toBe("[]");
    expect(escSection.length).toBeGreaterThan(5);
  });

  it("serializes compliancePolicyInternalRules into the == COMPLIANCE POLICY INTERNAL RULES == section (not [])", () => {
    const packet = buildDecisionPacket({
      customerId: "CUST-TEST-003",
      escalationRules: [VULN_ESCALATION_RULE],
      compliancePolicyInternalRules: [COMPLIANCE_RULE],
    });

    const prompt = buildFinalDecisionUserPrompt(packet);

    expect(prompt).toContain("== COMPLIANCE POLICY INTERNAL RULES ==");
    const compSection = prompt.split("== COMPLIANCE POLICY INTERNAL RULES ==")[1].split("==")[0].trim();
    expect(compSection).not.toBe("[]");
    expect(compSection).toContain("vulnerable");
  });

  it("shows empty [] in prompt when no escalation rules configured", () => {
    const packet = buildDecisionPacket({ customerId: "CUST-TEST-004" });
    const prompt = buildFinalDecisionUserPrompt(packet);

    expect(prompt).toContain("== ESCALATION RULES ==");
    const escSection = prompt.split("== ESCALATION RULES ==")[1].split("==")[0].trim();
    expect(escSection).toBe("[]");
  });

  it("PATH A — vulnerabilityRules with data-driven conditions flows into == ESCALATION RULES == (Lendable pattern)", () => {
    const lendableEscalationRule = {
      vulnerabilityDetected: true as const,
      legalAction: true,
      debtDispute: true,
      balanceAbove: null,
      dpdAbove: null,
      managerRequest: false,
      brokenPtps: null,
      otherConditions: [],
      vulnerabilityRules: {
        rows: [
          {
            leftFieldId: "source:vulnerability_rag",
            operator: "!=",
            rightConstantValue: "None",
            rightMode: "constant" as const,
            rightFieldId: null,
          },
        ],
        logicOperator: "AND" as const,
      },
    };

    const packet = buildDecisionPacket({
      customerId: "CUST-LENDABLE-001",
      escalationRules: [lendableEscalationRule],
      compliancePolicyInternalRules: [COMPLIANCE_RULE],
    });

    const prompt = buildFinalDecisionUserPrompt(packet);
    const escSection = prompt.split("== ESCALATION RULES ==")[1].split("==")[0].trim();

    expect(escSection).toContain("vulnerabilityRules");
    expect(escSection).toContain("vulnerability_rag");
    expect(escSection).toContain("logicOperator");
  });

  it("PATH B — no vulnerabilityRules in escalation rules (Prodigy Finance pattern) — prompt contains no vulnerabilityRules key", () => {
    const prodigyEscalationRule = {
      vulnerabilityDetected: true as const,
      legalAction: true,
      debtDispute: true,
      balanceAbove: null,
      dpdAbove: null,
      managerRequest: true,
      brokenPtps: null,
      otherConditions: [],
    };

    const packet = buildDecisionPacket({
      customerId: "CUST-PRODIGY-001",
      escalationRules: [prodigyEscalationRule],
      compliancePolicyInternalRules: [COMPLIANCE_RULE],
    });

    const prompt = buildFinalDecisionUserPrompt(packet);
    const escSection = prompt.split("== ESCALATION RULES ==")[1].split("==")[0].trim();

    expect(escSection).toContain("vulnerabilityDetected");
    expect(escSection).not.toContain("vulnerabilityRules");
    expect(escSection).not.toContain("vulnerability_rag");
  });
});
