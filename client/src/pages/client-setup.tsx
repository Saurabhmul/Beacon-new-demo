import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Building2, Save, Loader2,
  BookOpen, Upload, FileText, Trash2, Plus, File as FileIcon,
  Database, Pencil, MessageSquare, RotateCcw, Shield, Lock, AlertTriangle,
  Copy, RefreshCw, Info, Eye, ChevronDown, ChevronRight, X, Wand2, FileUp,
} from "lucide-react";
import type { ClientConfig, Rulebook, DataConfig, DpdStage, PolicyConfig, TreatmentOption, DecisionRule, EscalationRules, EscalationCustomCondition, AffordabilityRule, CategoryEntry, FieldReview, PolicyPack, TreatmentWithRules, TreatmentRuleGroupWithRules } from "@shared/schema";


const MANDATORY_LOAN_FIELDS = [
  "customer / account / loan id", "dpd_bucket",
  "amount_due", "minimum_due", "due_date",
];

const MANDATORY_PAYMENT_FIELDS = [
  "customer / account / loan id", "payment_reference", "date_of_payment", "amount_paid", "payment_status",
];

const MANDATORY_CONVERSATION_FIELDS = [
  "customer / account / loan id", "date_and_timestamp", "message",
];

const OPTIONAL_FIELDS = [
  "conversation_history", "income_and_employment_data",
  "credit_bureau_data", "compliance_policy", "knowledge_base",
];

const DEFAULT_PROMPT = `ROLE
You are Collections Analyst AI.

Primary objective
Analyze each customer's current delinquency situation and identify the most effective path to bring them back to a consistent, on-time repayment schedule.

Goal
Recommend the next best action we should take for the customer, in alignment with the SOP provided below.

Inputs available
You may be given (for each customer) any combination of:
  ● Inputs you may receive (any subset)
  ● Payment & delinquency history: due dates, DPD, repayments, partial payments, reversals/chargebacks, frequency, amount patterns, promises-to-pay, broken PTPs.
  ● Conversation logs (call/chat/email): stated hardship, job loss, medical/family issues, disputes, sentiment, avoidance, commitment, dates mentioned, requested payment plans.
  ● Income & employment: employer, job type, tenure, salary/income range, pay frequency, bank credits if provided, verification status, last update date.
  ● Credit bureau: score, tradelines, utilization, recent inquiries, delinquencies, write-offs, total obligations, estimated installment burden, public records (if provided), last pull date.

Key instructions for interpreting input data

Date and relevance filter
Current date: {{current_date}}
Review only tickets and conversations from the last 180 days.
Ignore any conversations older than 180 days.
Also ignore content within the last 180 days if it is not relevant to the customer's current situation.

Recency check before recommending outreach
Before proposing any outreach, review ticket history for the last 7 days:
If an email was sent within the last 7 days and there is no customer response and no completed survey, you should generally recommend no action to avoid over-contacting.
Exception: If the due date is very close or the situation is urgent, recommend an urgent outreach and explain why.

Payment failure detection: Actively look for payment failures (in payment data and/or mentioned in conversations) that could be preventing repayment (e.g., repeated failed attempts, mandate/autopay issues, insufficient funds, bank errors). If present, call this out explicitly and incorporate it into the recommended next step.

Non-negotiable constraint: No hallucinations: Do not create, assume, or infer missing facts as truth. Use only the information provided; if something is unknown, state it as unknown and reduce confidence accordingly.

HOW to go about analyzing the data (for every customer)

Rules you must follow
DO NOT HALLUCINATE. Use only evidence in the case. Do not invent facts.
Weight by recency: prefer newer signals. If something is old, discount it and say so.
If key data is missing, degrade gracefully.
If signals conflict (e.g., bureau strong but payment history weak), reconcile explicitly and state the most plausible explanation(s).
Do not output sensitive attributes or make prohibited inferences. Stick to financial capacity and documented facts.

Foundation to a collection analysis is analyzing the following for each customer
  ● Vulnerability: any customer condition or circumstance that materially reduces their ability to engage with collections normally or increases the risk of harm if we use standard collection tactics (frequency, tone, deadlines, escalation). It's less about "can they pay" and more about duty of care + appropriate treatment.
  ● Affordability: i.e how much the customer can pay us in the upcoming month
  ● Willingness: is the customer willing to pay us, or are they willfully trying to avoid the payment

Vulnerability: TRUE / FALSE

A customer is vulnerable if there is credible evidence (from customer statements or verified records) of one or more of the following:
Health / mental capacity: mental health crisis, suicidal ideation, psychiatric care, serious illness/hospitalization, cognitive impairment/disability affecting communication or decisions, pregnancy/post-partum complications.
Bereavement: customer deceased or death of a close family member.
Severe accident / safety risk: major injury (customer/dependent), domestic violence/abuse disclosure.
Legal / exceptional service status: active military deployment/war-zone constraints, incarceration or legal restrictions that materially limit engagement.
Exploitation / loss of control: fraud/scam victim, coerced payments/financial abuse, or concerning third-party control over communication/payments.

Affordability

Your task is to assess the customer's Affordability using only the information provided in this case. Data coverage will vary by customer—some cases may include payment history, conversation notes, income/employment information, and credit bureau data, while others may include only a subset (sometimes only payment history). Data may also vary in freshness: some inputs may be from today, while others may be up to 6 months old.
When stronger external data (e.g., verified income/employment) is not available, treat the customer's statements in conversation as credible for affordability assessment. For example, disclosures such as job loss, severe financial distress, low-paid internship, or unpaid internship should be interpreted as low affordability, unless contradicted by more reliable, recent evidence.

Affordability calculation (WTP)
HIGH: if the customer can pay greater than the minimum amount due, it would be considered high
MEDIUM: if the customer can pay greater than 60% of minimum amount due and less than minimum amount due
LOW: if the customer can pay less than 60% of minimum amount due
VERY LOW: if the customer cannot pay us anything or pay <10% of minimum amount due. Also applies when there is not enough data — absence of payments means VERY LOW.

Ability to Pay (ATP)
Additionally we can estimate ability to pay: estimated amount the customer can pay next month to us depending upon what the customer has mentioned, payment history and income and employment data - depending on what is available to pay - some logic as we put for affordability only difference is Ability to pay is a number

Willingness (WTP)
You are a senior collections behavioral risk analyst at an education lender. Your task is to determine the customer's Willingness to Pay (WTP) using only the data provided in this case. Data availability varies: some customers may have conversation logs + payment history + bureau + income/employment, while others may have only payment history. Data freshness varies: some fields may be today, others may be up to 6 months old. You must weight signals by recency, avoid guessing, and explicitly state uncertainty when evidence is limited.

Definition
Willingness to Pay (WTP) = the customer's intent and behavioral likelihood of paying given their situation, measured via existence of historical payments, the more the better, responsiveness, follow-through, consistency, cooperation, and avoidance—not their financial capacity.

Willingness to Pay (WTP)
Assign WTP level based on recent behavior:
HIGH: responsive + consistent + follows through; payments align with promises when capacity exists
MEDIUM: mixed responsiveness or occasional broken promises; some payments
LOW: Very irregular engagements but some sort of communication established between our agents and customers during the collection period
VERY LOW: avoidance/ghosting, not at all engaging on any channels, repeated broken PTP, inconsistent reasons, no payments despite contact (especially if ability to pay not clearly constrained). Also applies when there is no data — absence of engagement means VERY LOW.

Determining the next best action

If the customer is vulnerable: true then populate all information around the problem customer is facing and all but in propose a solution: we should strictly mention "agent review"

If the customer is not vulnerable && Affordability = HIGH
  ● We should encourage them to pay then we should encourage to pay more than minimum amount so as to clear arrears and mention why timely payments is good so as to build a healthy credit report etc.
  ● If the customer ability to pay is so high that if they pay that much then they can clear arrears in the next 3 months then we should ask them to pay that much amount and mention how that would clear up arrears and bring their credit report to very healthy place and why that is important

If customer is not vulnerable && Affordability = MEDIUM && Willingness: High or medium or low
  ● We should encourage them to pay then we should encourage to trying paying close to minimum amount due and mention why timely payments is good so as to build a healthy credit report etc.

If customer is not vulnerable && Affordability = MEDIUM && Willingness: very low
  ● We should encourage them to pay then we should ask them to paying close to minimum amount due and mention a) they need to engage with us to help us help them b) not paying on time can be detrimental to credit report health and can have long term ramification

If customer is not vulnerable && Affordability = LOW && Willingness: High or medium or low
  ● We should look at offering loan modification to reduce the installment amount right now for a period of a year or so giving enough time for student to find a job and then EMI kicking after that period is exhausted

If customer is not vulnerable && Affordability = LOW && Willingness: very low
  ● We should encourage them to pay then we should ask them to paying close to minimum amount due and mention a) they need to engage with us to help us help them b) not paying on time can be detrimental to credit report health and can have long term ramification

If customer is not vulnerable && Affordability = Very LOW && Willingness: High or medium or low
  ● We should offer Forbearance of 3 months either ask them to pay a very small or no amount to reduce the burden on them and allow them to focus on finding a new job and then EMI kicking after that period is exhausted

If customer is not vulnerable && Affordability = Very LOW && Willingness: very low
  ● We should encourage them to pay then we should ask them to paying close to minimum amount due and mention a) they need to engage with us to help us help them b) not paying on time can be detrimental to credit report health and can have long term ramification for them

Respond in JSON format.`;

const DEFAULT_OUTPUT = `{
  "customer_guid": "string",
  "combined_cmd": 0.0,
  "problem_description": "string (max 5 lines)",
  "problem_confidence_score": 1-10,
  "problem_evidence": "string (max 5 lines)",
  "proposed_solution": "string (max 5 lines)",
  "solution_confidence_score": 1-10,
  "solution_evidence": "string (max 5 lines)",
  "internal_action": "string (max 5 lines)",
  "ability_to_pay": 0.0,
  "reason_for_ability_to_pay": "string (max 5 lines)",
  "no_of_latest_payments_failed": 0,
  "proposed_email_to_customer": "Subject: ... Body: ... OR NO_ACTION"
}`;

const STAGE_COLORS = [
  { name: "blue", bg: "bg-blue-50", border: "border-blue-200", dot: "bg-blue-500" },
  { name: "green", bg: "bg-green-50", border: "border-green-200", dot: "bg-green-500" },
  { name: "orange", bg: "bg-orange-50", border: "border-orange-200", dot: "bg-orange-500" },
  { name: "red", bg: "bg-red-50", border: "border-red-200", dot: "bg-red-500" },
  { name: "purple", bg: "bg-purple-50", border: "border-purple-200", dot: "bg-purple-500" },
  { name: "yellow", bg: "bg-yellow-50", border: "border-yellow-200", dot: "bg-yellow-500" },
  { name: "pink", bg: "bg-pink-50", border: "border-pink-200", dot: "bg-pink-500" },
  { name: "teal", bg: "bg-teal-50", border: "border-teal-200", dot: "bg-teal-500" },
];

function getColorClasses(color: string) {
  return STAGE_COLORS.find(c => c.name === color) || STAGE_COLORS[0];
}


const DEFAULT_TREATMENTS: TreatmentOption[] = [
  {
    name: "Forbearance / Payment Holiday",
    enabled: false,
    definition: "Temporarily pausing or reducing payments for a set period (typically 1-6 months). The loan still accrues interest usually, but the customer gets breathing room. Used when the customer genuinely can't pay right now but the situation is temporary.",
  },
  {
    name: "Loan Modification / Restructure",
    enabled: false,
    definition: "Permanently changing the loan terms: extending tenor, reducing interest rate, reducing EMI amount, or some combination. Used when the customer's financial situation has fundamentally changed and the original terms are no longer realistic.",
  },
  {
    name: "Reaging / Re-amortization",
    enabled: false,
    definition: "Resetting the delinquency clock back to current after the customer demonstrates good behavior (e.g., 3 consecutive on-time payments). The past-due status is wiped. Sometimes combined with capitalizing the arrears into the remaining loan balance.",
  },
  {
    name: "Interest Rate Reduction",
    enabled: false,
    definition: "Specifically lowering the rate, either temporarily or permanently, to make payments more affordable. Sometimes a standalone action, sometimes part of a broader modification.",
  },
  {
    name: "Capitalization of Arrears",
    enabled: false,
    definition: "Rolling the missed payment amounts into the remaining principal balance and recalculating the EMI. The customer doesn't have to \"catch up\" separately — the arrears just become part of the loan going forward.",
  },
  {
    name: "Deferment",
    enabled: false,
    definition: "Specifically for education/student loans, pausing payments entirely because the borrower meets a qualifying condition (still in school, military service, economic hardship). Different from forbearance because it's often interest-free or subsidized.",
  },
  {
    name: "Clear Arrears Plan",
    enabled: false,
    definition: "Customer is encouraged to pay above the Minimum Amount Due to clear outstanding arrears within a target period. No loan modification or system intervention needed — the arrears clear naturally through consistent overpayment. Communication includes a specific payment amount and timeline showing month-over-month arrears reduction, plus credit report benefits of becoming current.",
    blockedStages: ["Late"],
    clearanceMonths: 6,
  },
];

const DEFAULT_ESCALATION: EscalationRules = {
  vulnerabilityDetected: true,
  legalAction: false,
  debtDispute: false,
  balanceAbove: null,
  dpdAbove: null,
  managerRequest: false,
  brokenPtps: null,
  otherConditions: [],
};

const AFFORDABILITY_OPTIONS = ["HIGH", "MEDIUM", "LOW", "VERY LOW"];
const WILLINGNESS_OPTIONS = ["HIGH", "MEDIUM", "LOW", "VERY LOW"];

function MultiSelectDropdown({ values, options, onChange, testIdPrefix }: {
  values: string[];
  options: string[];
  onChange: (newValues: string[]) => void;
  testIdPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const isAny = values.includes("ANY") || values.length === 0;

  const displayText = isAny ? "ANY" : values.join(", ");

  const handleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(!open);
  };

  const toggleOption = (option: string) => {
    if (values.includes(option)) {
      const next = values.filter(v => v !== option);
      onChange(next.length === 0 ? ["ANY"] : next);
    } else {
      const next = [...values.filter(v => v !== "ANY"), option];
      onChange(next);
    }
  };

  const toggleAny = () => {
    onChange(["ANY"]);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        className="flex items-center justify-between w-full h-9 px-3 text-xs border rounded-md bg-background hover:bg-accent/50 transition-colors text-left"
        data-testid={`${testIdPrefix}-trigger`}
      >
        <span className={`truncate ${isAny ? "text-muted-foreground" : ""}`}>{displayText}</span>
        <svg className="w-3 h-3 ml-1 shrink-0 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-44 bg-popover border rounded-md shadow-md p-1.5 space-y-0.5"
            style={{ top: pos.top, left: pos.left }}
            data-testid={`${testIdPrefix}-dropdown`}
          >
            <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer">
              <Checkbox
                checked={isAny}
                onCheckedChange={toggleAny}
                className="h-3.5 w-3.5"
                data-testid={`${testIdPrefix}-any`}
              />
              <span className="text-xs font-medium">ANY (all)</span>
            </label>
            <div className="border-t my-1" />
            {options.map(option => (
              <label key={option} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer">
                <Checkbox
                  checked={!isAny && values.includes(option)}
                  onCheckedChange={() => toggleOption(option)}
                  className="h-3.5 w-3.5"
                  data-testid={`${testIdPrefix}-${option.toLowerCase().replace(/\s+/g, '-')}`}
                />
                <span className="text-xs">{option}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
const ESCALATION_OPERATORS = [">", "<", "=", ">=", "<=", "contains"];

const AFFORDABILITY_OPERATORS = [">", ">=", "<", "<=", "="];
const AFFORDABILITY_LABELS = ["HIGH", "MEDIUM", "LOW", "VERY LOW"];

const DEFAULT_AFFORDABILITY_RULES: AffordabilityRule[] = [
  { id: 1, label: "HIGH", operator: ">", percentage: 100, condition: "", isDefault: true },
  { id: 2, label: "MEDIUM", operator: ">=", percentage: 60, condition: "and < Minimum Amount Due", isDefault: true },
  { id: 3, label: "LOW", operator: "<", percentage: 60, condition: "", isDefault: true },
  { id: 4, label: "VERY LOW", operator: "<", percentage: 10, condition: "NMPC = 0 OR NMPC < 10% of MAD. Also applies when no payment data exists.", isDefault: true },
];

// ── Policy Pack — Rule Builder ─────────────────────────────────────────────────
const RULE_OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "contains", "is empty", "is not empty"] as const;
const NO_VALUE_OPERATORS = new Set(["is empty", "is not empty"]);
const CUSTOM_FIELD_SENTINEL = "__custom__";

interface LocalRuleRow {
  localId: string;
  fieldName: string;
  useCustom: boolean;
  customFieldName: string;
  operator: string;
  value: string;
}
interface LocalRuleGroup {
  dbId?: number;
  logicOperator: "AND" | "OR";
  rows: LocalRuleRow[];
}
interface LocalTreatment {
  localId: string;
  dbId?: number;
  name: string;
  shortDescription: string;
  enabled: boolean;
  priority: string;
  tone: string;
  whenToOffer: LocalRuleGroup;
  blockedIf: LocalRuleGroup;
  isDraft: boolean;
  expanded: boolean;
  activeSection: "when" | "blocked";
}

function makeEmptyRow(): LocalRuleRow {
  return { localId: crypto.randomUUID(), fieldName: "", useCustom: false, customFieldName: "", operator: "=", value: "" };
}
function makeEmptyGroup(): LocalRuleGroup {
  return { logicOperator: "AND", rows: [] };
}
function serverGroupToLocal(ruleType: string, ruleGroups: TreatmentRuleGroupWithRules[]): LocalRuleGroup {
  const group = ruleGroups.find(g => g.ruleType === ruleType);
  if (!group) return makeEmptyGroup();
  return {
    dbId: group.id,
    logicOperator: (group.logicOperator as "AND" | "OR") || "AND",
    rows: group.rules.map(r => ({
      localId: `r${r.id}`,
      fieldName: r.fieldName,
      useCustom: false,
      customFieldName: "",
      operator: r.operator,
      value: r.value || "",
    })),
  };
}
function serverTxToLocal(tx: TreatmentWithRules): LocalTreatment {
  return {
    localId: `db-${tx.id}`,
    dbId: tx.id,
    name: tx.name,
    shortDescription: tx.shortDescription || "",
    enabled: tx.enabled,
    priority: tx.priority || "",
    tone: tx.tone || "",
    whenToOffer: serverGroupToLocal("when_to_offer", tx.ruleGroups),
    blockedIf: serverGroupToLocal("blocked_if", tx.ruleGroups),
    isDraft: false,
    expanded: false,
    activeSection: "when",
  };
}
function extractionToLocal(e: { name: string; shortDescription: string; whenToOffer: { fieldName: string; operator: string; value: string }[]; blockedIf: { fieldName: string; operator: string; value: string }[] }): LocalTreatment {
  return {
    localId: crypto.randomUUID(),
    dbId: undefined,
    name: e.name,
    shortDescription: e.shortDescription || "",
    enabled: true,
    priority: "",
    tone: "",
    whenToOffer: { logicOperator: "AND", rows: e.whenToOffer.map(r => ({ localId: crypto.randomUUID(), fieldName: r.fieldName, useCustom: false, customFieldName: "", operator: r.operator, value: r.value })) },
    blockedIf: { logicOperator: "AND", rows: e.blockedIf.map(r => ({ localId: crypto.randomUUID(), fieldName: r.fieldName, useCustom: false, customFieldName: "", operator: r.operator, value: r.value })) },
    isDraft: true,
    expanded: true,
    activeSection: "when",
  };
}

function RuleBuilderGroup({ group, knownFields, onChange, isReadOnly }: { group: LocalRuleGroup; knownFields: string[]; onChange: (g: LocalRuleGroup) => void; isReadOnly: boolean }) {
  function updateRow(localId: string, patch: Partial<LocalRuleRow>) {
    onChange({ ...group, rows: group.rows.map(r => r.localId === localId ? { ...r, ...patch } : r) });
  }
  function removeRow(localId: string) {
    onChange({ ...group, rows: group.rows.filter(r => r.localId !== localId) });
  }
  return (
    <div className="space-y-2">
      {group.rows.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Match:</span>
          {(["AND", "OR"] as const).map(op => (
            <button key={op} type="button" disabled={isReadOnly}
              className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${group.logicOperator === op ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
              onClick={() => onChange({ ...group, logicOperator: op })}>
              {op === "AND" ? "All conditions" : "Any condition"}
            </button>
          ))}
        </div>
      )}
      {group.rows.map((row, idx) => (
        <div key={row.localId} className="flex items-center gap-2 flex-wrap">
          {group.rows.length > 1 && (
            <span className="text-[10px] text-muted-foreground w-6 shrink-0 text-right font-mono">
              {idx === 0 ? "IF" : group.logicOperator}
            </span>
          )}
          <div className="flex items-center gap-1">
            {row.useCustom ? (
              <>
                <Input value={row.customFieldName}
                  onChange={e => updateRow(row.localId, { customFieldName: e.target.value, fieldName: e.target.value })}
                  placeholder="Enter field name..." className="h-8 text-xs w-40" disabled={isReadOnly}
                  data-testid={`input-custom-field-${row.localId}`} />
                {!isReadOnly && (
                  <Button variant="ghost" size="icon" className="h-8 w-8"
                    onClick={() => updateRow(row.localId, { useCustom: false, customFieldName: "", fieldName: "" })}>
                    <X className="w-3 h-3" />
                  </Button>
                )}
              </>
            ) : (
              <Select value={row.fieldName || ""} disabled={isReadOnly}
                onValueChange={v => {
                  if (v === CUSTOM_FIELD_SENTINEL) updateRow(row.localId, { useCustom: true, customFieldName: "", fieldName: "" });
                  else updateRow(row.localId, { fieldName: v, useCustom: false });
                }}>
                <SelectTrigger className="h-8 text-xs w-44" data-testid={`select-field-${row.localId}`}>
                  <SelectValue placeholder="Select field…" />
                </SelectTrigger>
                <SelectContent>
                  {knownFields.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                  <SelectItem value={CUSTOM_FIELD_SENTINEL} className="text-muted-foreground italic">Use custom field…</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          <Select value={row.operator} onValueChange={v => updateRow(row.localId, { operator: v })} disabled={isReadOnly}>
            <SelectTrigger className="h-8 text-xs w-32" data-testid={`select-operator-${row.localId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_OPERATORS.map(op => <SelectItem key={op} value={op}>{op}</SelectItem>)}
            </SelectContent>
          </Select>
          {!NO_VALUE_OPERATORS.has(row.operator) && (
            <Input value={row.value} onChange={e => updateRow(row.localId, { value: e.target.value })}
              placeholder="Value…" className="h-8 text-xs w-32" disabled={isReadOnly}
              data-testid={`input-value-${row.localId}`} />
          )}
          {!isReadOnly && (
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeRow(row.localId)}
              data-testid={`button-remove-row-${row.localId}`}>
              <Trash2 className="w-3 h-3 text-destructive" />
            </Button>
          )}
        </div>
      ))}
      {!isReadOnly && (
        <Button variant="outline" size="sm" className="h-7 text-xs"
          onClick={() => onChange({ ...group, rows: [...group.rows, makeEmptyRow()] })}
          data-testid="button-add-condition">
          <Plus className="w-3 h-3 mr-1" />Add Condition
        </Button>
      )}
      {group.rows.length === 0 && (
        <p className="text-xs text-muted-foreground italic">{isReadOnly ? "No conditions defined." : "No conditions yet — add one above."}</p>
      )}
    </div>
  );
}

function TreatmentCard({ treatment, knownFields, isReadOnly, onUpdate, onDelete }: {
  treatment: LocalTreatment;
  knownFields: string[];
  isReadOnly: boolean;
  onUpdate: (updated: LocalTreatment) => void;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [local, setLocal] = useState<LocalTreatment>(treatment);
  useEffect(() => { setLocal(t => ({ ...treatment, expanded: t.expanded, activeSection: t.activeSection })); }, [treatment.dbId, treatment.isDraft]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      let dbId = local.dbId;
      if (!dbId) {
        const tx = await apiRequest("POST", "/api/policy-pack/treatments", {
          name: local.name, shortDescription: local.shortDescription || null,
          enabled: local.enabled, priority: local.priority || null, tone: local.tone || null, displayOrder: 0,
        }).then(r => r.json());
        dbId = tx.id;
      } else {
        await apiRequest("PATCH", `/api/policy-pack/treatments/${dbId}`, {
          name: local.name, shortDescription: local.shortDescription || null,
          enabled: local.enabled, priority: local.priority || null, tone: local.tone || null,
        });
      }
      const saveGroup = (g: LocalRuleGroup, ruleType: string) =>
        apiRequest("POST", `/api/policy-pack/treatments/${dbId}/rules`, {
          ruleType, logicOperator: g.logicOperator,
          rows: g.rows.map(r => ({ fieldName: r.fieldName, operator: r.operator, value: r.value })),
        });
      await saveGroup(local.whenToOffer, "when_to_offer");
      await saveGroup(local.blockedIf, "blocked_if");
      return dbId;
    },
    onSuccess: (dbId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/policy-pack/treatments"] });
      onUpdate({ ...local, dbId, isDraft: false });
      toast({ title: `"${local.name}" saved` });
    },
    onError: () => toast({ title: "Error", description: "Failed to save treatment", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => { if (local.dbId) await apiRequest("DELETE", `/api/policy-pack/treatments/${local.dbId}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policy-pack/treatments"] });
      onDelete();
      toast({ title: `"${local.name}" removed` });
    },
  });

  return (
    <div className={`rounded-lg border transition-colors ${local.enabled ? "border-primary/20 bg-primary/5 dark:bg-primary/10" : "bg-muted/20 border-border"} ${local.isDraft ? "border-amber-300 dark:border-amber-700" : ""}`}
      data-testid={`card-treatment-pack-${local.localId}`}>
      {/* Header */}
      <div className="flex items-center gap-2 p-3 flex-wrap">
        <button type="button" className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => setLocal(l => ({ ...l, expanded: !l.expanded }))}
          data-testid={`button-expand-${local.localId}`}>
          {local.expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <Switch checked={local.enabled} onCheckedChange={v => setLocal(l => ({ ...l, enabled: v }))}
          disabled={isReadOnly} data-testid={`switch-enabled-${local.localId}`} />
        {!isReadOnly ? (
          <Input value={local.name} onChange={e => setLocal(l => ({ ...l, name: e.target.value }))}
            className="h-8 text-sm font-medium flex-1 min-w-[140px] max-w-xs border-transparent bg-transparent hover:border-border focus:border-border focus:bg-background transition-colors"
            placeholder="Treatment name" data-testid={`input-name-${local.localId}`} />
        ) : (
          <span className="font-medium text-sm flex-1">{local.name}</span>
        )}
        {local.isDraft && <Badge variant="outline" className="text-amber-600 border-amber-400 text-[10px] shrink-0">Draft — unsaved</Badge>}
        <Select value={local.priority || "_none"} onValueChange={v => setLocal(l => ({ ...l, priority: v === "_none" ? "" : v }))} disabled={isReadOnly}>
          <SelectTrigger className="h-8 text-xs w-28 shrink-0" data-testid={`select-priority-${local.localId}`}>
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none">No priority</SelectItem>
            <SelectItem value="High">High</SelectItem>
            <SelectItem value="Medium">Medium</SelectItem>
            <SelectItem value="Low">Low</SelectItem>
          </SelectContent>
        </Select>
        <Select value={local.tone || "_none"} onValueChange={v => setLocal(l => ({ ...l, tone: v === "_none" ? "" : v }))} disabled={isReadOnly}>
          <SelectTrigger className="h-8 text-xs w-32 shrink-0" data-testid={`select-tone-pack-${local.localId}`}>
            <SelectValue placeholder="Tone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none">No tone</SelectItem>
            <SelectItem value="Supportive">Supportive</SelectItem>
            <SelectItem value="Neutral">Neutral</SelectItem>
            <SelectItem value="Firm">Firm</SelectItem>
            <SelectItem value="Empathetic">Empathetic</SelectItem>
          </SelectContent>
        </Select>
        {!isReadOnly && (
          <div className="flex gap-1 shrink-0">
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !local.name.trim()} className="h-8 text-xs" data-testid={`button-save-tx-${local.localId}`}>
              {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              <span className="ml-1">Save</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}
              className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
              data-testid={`button-delete-tx-${local.localId}`}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        )}
      </div>

      {local.expanded && (
        <div className="px-4 pb-4 space-y-4 border-t pt-4">
          {/* Short description */}
          {!isReadOnly ? (
            <Textarea value={local.shortDescription}
              onChange={e => setLocal(l => ({ ...l, shortDescription: e.target.value }))}
              placeholder="Short description of when and how this treatment is applied…"
              className="text-xs min-h-[56px] resize-none" data-testid={`textarea-desc-${local.localId}`} />
          ) : local.shortDescription ? (
            <p className="text-xs text-muted-foreground leading-relaxed">{local.shortDescription}</p>
          ) : null}

          {/* Evaluation logic note */}
          <div className="flex items-start gap-2 p-2.5 rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Beacon recommends this treatment when <strong>When to Offer</strong> conditions are met <strong>AND</strong> no <strong>Blocked If</strong> conditions are true.</span>
          </div>

          {/* Section tabs */}
          <div className="flex gap-2">
            {(["when", "blocked"] as const).map(s => {
              const count = s === "when" ? local.whenToOffer.rows.length : local.blockedIf.rows.length;
              return (
                <button key={s} type="button"
                  className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${local.activeSection === s ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setLocal(l => ({ ...l, activeSection: s }))}>
                  {s === "when" ? "When to Offer" : "Blocked If"}
                  {count > 0 && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${local.activeSection === s ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted-foreground/20"}`}>{count}</span>}
                </button>
              );
            })}
          </div>

          {/* Rule builder */}
          {local.activeSection === "when" ? (
            <RuleBuilderGroup group={local.whenToOffer} knownFields={knownFields}
              onChange={g => setLocal(l => ({ ...l, whenToOffer: g }))} isReadOnly={isReadOnly} />
          ) : (
            <RuleBuilderGroup group={local.blockedIf} knownFields={knownFields}
              onChange={g => setLocal(l => ({ ...l, blockedIf: g }))} isReadOnly={isReadOnly} />
          )}
        </div>
      )}
    </div>
  );
}

const PRELOADED_TREATMENTS = [
  { name: "Forbearance / Payment Holiday", shortDescription: "Temporarily pausing or reducing payments for a set period (typically 1–6 months). The loan still accrues interest, but the customer gets breathing room. Used when the customer genuinely can't pay right now but the situation is temporary." },
  { name: "Loan Modification / Restructure", shortDescription: "Permanently changing the loan terms: extending tenor, reducing interest rate, reducing EMI amount, or some combination. Used when the customer's financial situation has fundamentally changed and the original terms are no longer realistic." },
  { name: "Reaging / Re-amortization", shortDescription: "Resetting the delinquency clock back to current after the customer demonstrates good behavior (e.g., 3 consecutive on-time payments). The past-due status is wiped. Sometimes combined with capitalizing the arrears into the remaining loan balance." },
  { name: "Interest Rate Reduction", shortDescription: "Specifically lowering the rate, either temporarily or permanently, to make payments more affordable. Sometimes a standalone action, sometimes part of a broader modification." },
  { name: "Capitalization of Arrears", shortDescription: "Rolling the missed payment amounts into the remaining principal balance and recalculating the EMI. The customer doesn't have to \"catch up\" separately — the arrears just become part of the loan going forward." },
  { name: "Deferment", shortDescription: "Specifically for education/student loans, pausing payments entirely because the borrower meets a qualifying condition (still in school, military service, economic hardship). Different from forbearance because it's often interest-free or subsidised." },
  { name: "Clear Arrears Plan", shortDescription: "Customer is encouraged to pay above the Minimum Amount Due to clear outstanding arrears within a target period. No loan modification or system intervention needed — the arrears clear naturally through consistent overpayment." },
  { name: "Write-Off / Debt Settlement", shortDescription: "Offering a reduced lump-sum settlement to close the account. Used in late-stage collections when full recovery is unlikely. Typically requires management approval." },
];

function PolicyPackSection({ isReadOnly, policyPack }: { isReadOnly: boolean; policyPack: PolicyPack }) {
  const { toast } = useToast();

  const { data: serverTreatmentsData, isLoading: txLoading } = useQuery<TreatmentWithRules[]>({ queryKey: ["/api/policy-pack/treatments"] });
  const { data: dataConfig } = useQuery<DataConfig>({ queryKey: ["/api/data-config"], retry: false });

  const knownFields = useMemo(() => {
    if (!dataConfig?.categoryData) return [];
    const fields: string[] = [];
    for (const entry of Object.values(dataConfig.categoryData as Record<string, { fieldAnalysis?: Array<{ fieldName: string; ignored: boolean }> }>)) {
      if (entry.fieldAnalysis) for (const f of entry.fieldAnalysis) if (!f.ignored && f.fieldName) fields.push(f.fieldName);
    }
    return [...new Set(fields)];
  }, [dataConfig]);

  const [localTreatments, setLocalTreatments] = useState<LocalTreatment[]>([]);
  const [entryMode, setEntryMode] = useState<"build" | "upload" | null>(null);
  const [sopFile, setSopFile] = useState<File | null>(null);
  const [sopExtracting, setSopExtracting] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [addEnabled, setAddEnabled] = useState(true);
  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [buildSelectedTemplates, setBuildSelectedTemplates] = useState<Set<string>>(new Set());
  const sopInputRef = useRef<HTMLInputElement>(null);

  // Sync from server — preserve expanded/activeSection state
  // Note: use serverTreatmentsData (not a defaulted alias) to keep stable reference when undefined
  useEffect(() => {
    if (!serverTreatmentsData) return;
    setLocalTreatments(prev => {
      const drafts = prev.filter(t => t.isDraft);
      const serverLocals = serverTreatmentsData.map(tx => {
        const existing = prev.find(p => p.dbId === tx.id);
        const base = serverTxToLocal(tx);
        return existing ? { ...base, expanded: existing.expanded, activeSection: existing.activeSection } : base;
      });
      return [...serverLocals, ...drafts];
    });
  }, [serverTreatmentsData]);

  const hasTreatments = localTreatments.length > 0 || (serverTreatmentsData?.length ?? 0) > 0;

  function makeTemplateLocal(name: string, shortDescription: string, expanded = false): LocalTreatment {
    return {
      localId: crypto.randomUUID(), dbId: undefined, name, shortDescription,
      enabled: true, priority: "", tone: "",
      whenToOffer: makeEmptyGroup(), blockedIf: makeEmptyGroup(),
      isDraft: true, expanded, activeSection: "when",
    };
  }

  function handleStartBuild() {
    if (buildSelectedTemplates.size > 0) {
      const drafts = PRELOADED_TREATMENTS
        .filter(t => buildSelectedTemplates.has(t.name))
        .map(t => makeTemplateLocal(t.name, t.shortDescription));
      setLocalTreatments(prev => [...prev, ...drafts]);
    }
    setBuildSelectedTemplates(new Set());
    setEntryMode(null);
  }

  async function handleExtractSOP() {
    if (!sopFile) return;
    setSopExtracting(true);
    try {
      const form = new FormData();
      form.append("file", sopFile);
      const res = await fetch("/api/policy-pack/extract-sop", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) throw new Error();
      const { treatments: extracted } = await res.json();
      if (!extracted?.length) { toast({ title: "No treatments found", description: "Beacon couldn't extract treatments from this file.", variant: "destructive" }); return; }
      setLocalTreatments(prev => [...prev, ...extracted.map(extractionToLocal)]);
      // Update pack provenance to reflect SOP extraction
      if (policyPack && policyPack.sourceType !== "file") {
        await fetch("/api/policy-pack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ id: policyPack.id, policyName: policyPack.policyName, sourceType: "file", sourceFileName: sopFile.name }),
        });
      }
      setEntryMode(null);
      toast({ title: `${extracted.length} treatment${extracted.length !== 1 ? "s" : ""} extracted`, description: "Review and save each treatment below." });
    } catch {
      toast({ title: "Extraction failed", description: "Could not extract treatments from the file.", variant: "destructive" });
    } finally { setSopExtracting(false); }
  }

  function closeAddDialog() {
    setAddDialogOpen(false);
    setSelectedTemplates(new Set());
    setShowCustomForm(false);
    setAddName(""); setAddDesc(""); setAddEnabled(true);
  }

  function handleAddFromDialog() {
    const newTreatments: LocalTreatment[] = [];
    for (const name of selectedTemplates) {
      const t = PRELOADED_TREATMENTS.find(p => p.name === name);
      if (t) newTreatments.push(makeTemplateLocal(t.name, t.shortDescription, true));
    }
    if (showCustomForm && addName.trim()) {
      newTreatments.push(makeTemplateLocal(addName.trim(), addDesc, true));
    }
    if (!newTreatments.length) return;
    setLocalTreatments(prev => [...prev, ...newTreatments]);
    closeAddDialog();
  }

  return (
    <div className="space-y-4">
      {/* ── Entry selector (no treatments yet) ─────────────────────── */}
      {!hasTreatments && entryMode === null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section D: Treatments</CardTitle>
            <CardDescription>Define the treatments Beacon can recommend. Start by building them directly or uploading your SOP / policy file.</CardDescription>
          </CardHeader>
          <CardContent>
            {isReadOnly ? (
              <p className="text-sm text-muted-foreground">No treatments configured yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <button type="button" onClick={() => setEntryMode("build")}
                  className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors text-center"
                  data-testid="button-mode-build">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center"><Pencil className="w-5 h-5 text-primary" /></div>
                  <div>
                    <p className="font-medium text-sm">Build in Beacon</p>
                    <p className="text-xs text-muted-foreground mt-1">Define treatments and rules directly in the UI</p>
                  </div>
                </button>
                <button type="button" onClick={() => setEntryMode("upload")}
                  className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors text-center"
                  data-testid="button-mode-upload">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center"><FileUp className="w-5 h-5 text-primary" /></div>
                  <div>
                    <p className="font-medium text-sm">Upload SOP / Policy File</p>
                    <p className="text-xs text-muted-foreground mt-1">Let Beacon extract draft treatments from your document</p>
                  </div>
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Build mode setup ──────────────────────────────────────── */}
      {entryMode === "build" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Build in Beacon</CardTitle>
            <CardDescription>Pick from our treatment library to get started — or skip to begin with an empty list and add treatments manually later.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <p className="text-sm font-medium mb-2">Select treatments to include</p>
              <p className="text-xs text-muted-foreground mb-3">You can always add or remove treatments later. Select any that apply to your business.</p>
              <div className="space-y-2">
                {PRELOADED_TREATMENTS.map(t => {
                  const checked = buildSelectedTemplates.has(t.name);
                  return (
                    <label key={t.name}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors select-none ${checked ? "border-primary/30 bg-primary/5" : "hover:bg-muted/40 border-border"}`}
                      data-testid={`label-build-template-${t.name}`}>
                      <Checkbox checked={checked}
                        onCheckedChange={v => setBuildSelectedTemplates(prev => {
                          const next = new Set(prev);
                          if (v) next.add(t.name); else next.delete(t.name);
                          return next;
                        })}
                        className="mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium leading-snug">{t.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{t.shortDescription}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Button onClick={handleStartBuild} data-testid="button-start-build">
                {buildSelectedTemplates.size > 0 ? `Get Started with ${buildSelectedTemplates.size} Treatment${buildSelectedTemplates.size !== 1 ? "s" : ""}` : "Get Started"}
              </Button>
              <Button variant="outline" onClick={() => setEntryMode(null)}>Back</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Upload SOP mode setup (first-time) ───────────────────── */}
      {!hasTreatments && entryMode === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload SOP / Policy File</CardTitle>
            <CardDescription>Beacon will read your document and extract draft treatments for you to review and edit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">SOP file</label>
              <input ref={sopInputRef} type="file" accept=".txt,.pdf,.docx,.doc" className="hidden"
                onChange={e => setSopFile(e.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={() => sopInputRef.current?.click()} data-testid="button-browse-sop">
                  <Upload className="w-4 h-4 mr-2" />Browse
                </Button>
                {sopFile && <span className="text-sm text-muted-foreground"><FileText className="w-3.5 h-3.5 inline mr-1" />{sopFile.name}</span>}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">Supported: TXT, PDF, DOCX</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleExtractSOP} disabled={!sopFile || sopExtracting} data-testid="button-extract-sop">
                {sopExtracting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Extracting…</> : <><Wand2 className="w-4 h-4 mr-2" />Extract Treatments</>}
              </Button>
              <Button variant="outline" onClick={() => setEntryMode(null)}>Back</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Treatments card (once treatments exist) ──────────────── */}
      {hasTreatments && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Section D: Treatments</CardTitle>
                <CardDescription>
                  {policyPack.sourceType === "file" ? "Extracted from SOP" : "Built in Beacon"}
                </CardDescription>
              </div>
              {!isReadOnly && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEntryMode("upload")} data-testid="button-upload-more">
                    <Wand2 className="w-3.5 h-3.5 mr-1" />Extract from SOP
                  </Button>
                  <Button size="sm" onClick={() => setAddDialogOpen(true)} data-testid="button-add-treatment">
                    <Plus className="w-3.5 h-3.5 mr-1" />Add Treatment
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>

          {/* Upload SOP when pack exists */}
          {entryMode === "upload" && (
            <CardContent className="border-t pt-4 space-y-3">
              <p className="text-sm font-medium">Extract additional treatments from a file</p>
              <input ref={sopInputRef} type="file" accept=".txt,.pdf,.docx,.doc" className="hidden"
                onChange={e => setSopFile(e.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => sopInputRef.current?.click()}>
                  <Upload className="w-3.5 h-3.5 mr-1" />Browse
                </Button>
                {sopFile && <span className="text-xs text-muted-foreground">{sopFile.name}</span>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleExtractSOP} disabled={!sopFile || sopExtracting}>
                  {sopExtracting ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />Extracting…</> : <><Wand2 className="w-3.5 h-3.5 mr-1" />Extract</>}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEntryMode(null)}>Cancel</Button>
              </div>
            </CardContent>
          )}

          {/* Treatment list */}
          <CardContent className="space-y-3">
            {txLoading ? (
              <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
            ) : localTreatments.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Shield className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No treatments yet.</p>
                {!isReadOnly && <p className="text-xs mt-1">Click "Add Treatment" or extract from an SOP to get started.</p>}
              </div>
            ) : (
              localTreatments.map(tx => (
                <TreatmentCard key={tx.localId} treatment={tx} knownFields={knownFields} isReadOnly={isReadOnly}
                  onUpdate={updated => setLocalTreatments(prev => prev.map(t => t.localId === tx.localId ? updated : t))}
                  onDelete={() => setLocalTreatments(prev => prev.filter(t => t.localId !== tx.localId))} />
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Add Treatment Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={v => { if (!v) closeAddDialog(); else setAddDialogOpen(true); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Add Treatments</DialogTitle>
            <p className="text-sm text-muted-foreground">Pick from our treatment library, create your own, or both.</p>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {/* Template library */}
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Treatment library</p>
            {PRELOADED_TREATMENTS.map(t => {
              const alreadyAdded = localTreatments.some(lt => lt.name === t.name);
              const checked = selectedTemplates.has(t.name);
              return (
                <label key={t.name}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors select-none ${alreadyAdded ? "opacity-50 cursor-not-allowed border-border bg-muted/30" : checked ? "border-primary/30 bg-primary/5" : "hover:bg-muted/40 border-border"}`}
                  data-testid={`label-template-${t.name}`}>
                  <Checkbox checked={checked} disabled={alreadyAdded}
                    onCheckedChange={v => {
                      if (alreadyAdded) return;
                      setSelectedTemplates(prev => {
                        const next = new Set(prev);
                        if (v) next.add(t.name); else next.delete(t.name);
                        return next;
                      });
                    }}
                    className="mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium leading-snug">{t.name}</p>
                      {alreadyAdded && <Badge variant="secondary" className="text-[10px] shrink-0">Already added</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{t.shortDescription}</p>
                  </div>
                </label>
              );
            })}

            {/* Custom treatment toggle */}
            <div className="border-t pt-3">
              {!showCustomForm ? (
                <Button variant="outline" size="sm" className="w-full" onClick={() => setShowCustomForm(true)}
                  data-testid="button-show-custom-form">
                  <Plus className="w-3.5 h-3.5 mr-1.5" />Create custom treatment
                </Button>
              ) : (
                <div className="space-y-3 p-4 rounded-lg border-2 border-dashed border-primary/30 bg-primary/5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Custom treatment</p>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setShowCustomForm(false); setAddName(""); setAddDesc(""); }}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Name <span className="text-destructive">*</span></label>
                    <Input value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. Payment Holiday"
                      data-testid="input-add-treatment-name" />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Short description</label>
                    <Textarea value={addDesc} onChange={e => setAddDesc(e.target.value)}
                      placeholder="Describe when and how this treatment is applied…"
                      className="min-h-[72px] text-sm" data-testid="textarea-add-treatment-desc" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={addEnabled} onCheckedChange={setAddEnabled} data-testid="switch-add-enabled" />
                    <Label className="text-sm">Enabled</Label>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t pt-4">
            <Button variant="outline" onClick={closeAddDialog}>Cancel</Button>
            <Button onClick={handleAddFromDialog}
              disabled={selectedTemplates.size === 0 && !(showCustomForm && addName.trim())}
              data-testid="button-confirm-add-treatment">
              {(() => {
                const count = selectedTemplates.size + (showCustomForm && addName.trim() ? 1 : 0);
                return count > 1 ? `Add ${count} Treatments` : "Add Treatment";
              })()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Policy Config Tab ──────────────────────────────────────────────────────────
function PolicyConfigTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";
  const isReadOnly = user?.role === "superadmin" || user?.role === "manager";

  const { data: policyConfig, isLoading: policyLoading } = useQuery<PolicyConfig>({
    queryKey: ["/api/policy-config"],
    retry: false,
  });
  const { data: dpdStages = [] } = useQuery<DpdStage[]>({ queryKey: ["/api/dpd-stages"] });

  // Policy pack — lifted here so the header can use it
  const { data: policyPack, isLoading: packLoading } = useQuery<PolicyPack>({ queryKey: ["/api/policy-pack"], retry: false });
  const [policyNameInput, setPolicyNameInput] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState("");

  const createPackMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/policy-pack", { policyName: name, sourceType: "ui" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policy-pack"] });
      setPolicyNameInput("");
    },
    onError: () => toast({ title: "Error", description: "Failed to create policy", variant: "destructive" }),
  });

  const renamePackMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/policy-pack", { id: policyPack!.id, policyName: name, sourceType: policyPack!.sourceType });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policy-pack"] });
      setIsEditingName(false);
    },
    onError: () => toast({ title: "Error", description: "Failed to rename policy", variant: "destructive" }),
  });

  const [vulnerabilityDefinition, setVulnerabilityDefinition] = useState("");
  const [affordabilityRules, setAffordabilityRules] = useState<AffordabilityRule[]>(DEFAULT_AFFORDABILITY_RULES);
  const [treatments, setTreatments] = useState<TreatmentOption[]>(DEFAULT_TREATMENTS);
  const [decisionRules, setDecisionRules] = useState<DecisionRule[]>([]);
  const [escalation, setEscalation] = useState<EscalationRules>(DEFAULT_ESCALATION);
  const [hydrated, setHydrated] = useState(false);

  const [customTreatmentName, setCustomTreatmentName] = useState("");
  const [customTreatmentDef, setCustomTreatmentDef] = useState("");

  const [customEscField, setCustomEscField] = useState("");
  const [customEscOp, setCustomEscOp] = useState(">");
  const [customEscValue, setCustomEscValue] = useState("");

  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<DpdStage | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageDesc, setStageDesc] = useState("");
  const [stageFrom, setStageFrom] = useState("");
  const [stageTo, setStageTo] = useState("");
  const [stageColor, setStageColor] = useState("blue");

  useEffect(() => {
    if (policyConfig && !hydrated) {
      if (policyConfig.vulnerabilityDefinition) setVulnerabilityDefinition(policyConfig.vulnerabilityDefinition);
      if (policyConfig.affordabilityRules && (policyConfig.affordabilityRules as AffordabilityRule[]).length > 0) {
        setAffordabilityRules(policyConfig.affordabilityRules as AffordabilityRule[]);
      }
      if (policyConfig.availableTreatments && (policyConfig.availableTreatments as TreatmentOption[]).length > 0) {
        const saved = policyConfig.availableTreatments as TreatmentOption[];
        const merged = DEFAULT_TREATMENTS.map(dt => {
          const found = saved.find(s => s.name === dt.name);
          return found ? { ...dt, enabled: found.enabled, blockedStages: found.blockedStages ?? dt.blockedStages, clearanceMonths: found.clearanceMonths ?? dt.clearanceMonths } : dt;
        });
        const customs = saved.filter(s => s.isCustom);
        setTreatments([...merged, ...customs]);
      }
      if (policyConfig.decisionRules && (policyConfig.decisionRules as any[]).length > 0) {
        const migratedRules = (policyConfig.decisionRules as any[]).map((r: any) => ({
          ...r,
          treatmentName: r.treatmentName === "Agent Review" ? "Agent Review — Escalate to Human" : r.treatmentName,
          affordability: Array.isArray(r.affordability) ? r.affordability : [r.affordability || "ANY"],
          willingness: Array.isArray(r.willingness) ? r.willingness : [r.willingness || "ANY"],
        })) as DecisionRule[];
        setDecisionRules(migratedRules);
      }
      if (policyConfig.escalationRules) {
        setEscalation({ ...DEFAULT_ESCALATION, ...(policyConfig.escalationRules as EscalationRules), vulnerabilityDetected: true });
      }
      setHydrated(true);
    }
  }, [policyConfig, hydrated]);

  const savePolicyMutation = useMutation({
    mutationFn: async () => {
      const method = policyConfig ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/policy-config", {
        vulnerabilityDefinition,
        affordabilityRules,
        availableTreatments: treatments,
        decisionRules,
        escalationRules: escalation,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/policy-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-preview"] });
      toast({ title: "Policy configuration saved" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save policy config.", variant: "destructive" });
    },
  });

  const createStageMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; fromDays: number; toDays: number; color: string }) => {
      const res = await apiRequest("POST", "/api/dpd-stages", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dpd-stages"] });
      toast({ title: "DPD stage created" });
      closeStageDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to create stage.", variant: "destructive" });
    },
  });

  const updateStageMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; name: string; description: string; fromDays: number; toDays: number; color: string }) => {
      const res = await apiRequest("PATCH", `/api/dpd-stages/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dpd-stages"] });
      toast({ title: "DPD stage updated" });
      closeStageDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to update stage.", variant: "destructive" });
    },
  });

  const deleteStageMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/dpd-stages/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dpd-stages"] });
      toast({ title: "DPD stage deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete stage.", variant: "destructive" });
    },
  });

  function openAddStageDialog() {
    setEditingStage(null);
    setStageName("");
    setStageDesc("");
    setStageFrom("");
    setStageTo("");
    setStageColor("blue");
    setStageDialogOpen(true);
  }

  function openEditStageDialog(stage: DpdStage) {
    setEditingStage(stage);
    setStageName(stage.name);
    setStageDesc(stage.description || "");
    setStageFrom(String(stage.fromDays));
    setStageTo(String(stage.toDays));
    setStageColor(stage.color);
    setStageDialogOpen(true);
  }

  function closeStageDialog() {
    setStageDialogOpen(false);
    setEditingStage(null);
  }

  function handleSaveStage() {
    const fromDays = parseInt(stageFrom);
    const toDays = parseInt(stageTo);
    if (!stageName.trim()) {
      toast({ title: "Error", description: "Stage name is required.", variant: "destructive" });
      return;
    }
    if (isNaN(fromDays) || isNaN(toDays)) {
      toast({ title: "Error", description: "Please enter valid day ranges.", variant: "destructive" });
      return;
    }
    if (fromDays >= toDays) {
      toast({ title: "Error", description: "From days must be less than To days.", variant: "destructive" });
      return;
    }
    const payload = { name: stageName.trim(), description: stageDesc.trim(), fromDays, toDays, color: stageColor };
    if (editingStage) {
      updateStageMutation.mutate({ id: editingStage.id, ...payload });
    } else {
      createStageMutation.mutate(payload);
    }
  }

  function toggleTreatment(index: number) {
    setTreatments(prev => prev.map((t, i) => i === index ? { ...t, enabled: !t.enabled } : t));
  }

  function addCustomTreatment() {
    if (!customTreatmentName.trim()) return;
    setTreatments(prev => [...prev, { name: customTreatmentName.trim(), enabled: true, definition: customTreatmentDef.trim(), isCustom: true }]);
    setCustomTreatmentName("");
    setCustomTreatmentDef("");
  }

  function removeCustomTreatment(index: number) {
    setTreatments(prev => prev.filter((_, i) => i !== index));
  }

  function toggleBlockedStage(treatmentIndex: number, stageName: string) {
    setTreatments(prev => prev.map((t, i) => {
      if (i !== treatmentIndex) return t;
      const blocked = t.blockedStages || [];
      const updated = blocked.includes(stageName)
        ? blocked.filter(s => s !== stageName)
        : [...blocked, stageName];
      return { ...t, blockedStages: updated };
    }));
  }

  function addDecisionRule() {
    const newId = decisionRules.length > 0 ? Math.max(...decisionRules.map(r => r.id)) + 1 : 1;
    setDecisionRules(prev => [...prev, { id: newId, treatmentName: "", affordability: ["ANY"], willingness: ["ANY"], otherCondition: "", communicationTone: "Supportive", priority: prev.length + 1 }]);
  }

  function updateClearanceMonths(index: number, value: number) {
    setTreatments(prev => prev.map((t, i) => i === index ? { ...t, clearanceMonths: value } : t));
    setDecisionRules(prev => prev.map(r => {
      if (r.treatmentName !== 'Clear Arrears Plan') return r;
      const oldPattern = /^\(NMPC - MAD\) \* \d+ >= Total Arrears$/;
      if (r.otherCondition && oldPattern.test(r.otherCondition)) {
        return { ...r, otherCondition: `(NMPC - MAD) * ${value} >= Total Arrears` };
      }
      return r;
    }));
  }

  function updateDecisionRule(id: number, field: keyof DecisionRule, value: string | number | string[]) {
    setDecisionRules(prev => prev.map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, [field]: value };
      if (field === 'treatmentName') {
        if (value === 'Clear Arrears Plan' && !r.otherCondition) {
          const cap = treatments.find(t => t.name === 'Clear Arrears Plan');
          const months = cap?.clearanceMonths || 6;
          updated.otherCondition = `(NMPC - MAD) * ${months} >= Total Arrears`;
        }
        if (value === 'None — Encourage Payment') {
          if (!r.paymentTarget) updated.paymentTarget = 'At or above MAD';
          if (!r.communicationTone) updated.communicationTone = 'Supportive';
        }
      }
      return updated;
    }));
  }

  function removeDecisionRule(id: number) {
    setDecisionRules(prev => prev.filter(r => r.id !== id));
  }

  function addCustomEscalation() {
    if (!customEscField.trim() || !customEscValue.trim()) return;
    setEscalation(prev => ({
      ...prev,
      otherConditions: [...prev.otherConditions, { field: customEscField.trim(), operator: customEscOp, value: customEscValue.trim() }],
    }));
    setCustomEscField("");
    setCustomEscOp(">");
    setCustomEscValue("");
  }

  function removeCustomEscalation(index: number) {
    setEscalation(prev => ({
      ...prev,
      otherConditions: prev.otherConditions.filter((_, i) => i !== index),
    }));
  }

  function updateAffordabilityRule(id: number, field: keyof AffordabilityRule, value: string | number | null) {
    setAffordabilityRules(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  }

  function addAffordabilityRule() {
    const newId = affordabilityRules.length > 0 ? Math.max(...affordabilityRules.map(r => r.id)) + 1 : 1;
    setAffordabilityRules(prev => [...prev, { id: newId, label: "HIGH", operator: ">", percentage: 100, condition: "", isDefault: false }]);
  }

  function removeAffordabilityRule(id: number) {
    setAffordabilityRules(prev => prev.filter(r => r.id !== id));
  }

  const enabledTreatments = treatments.filter(t => t.enabled);

  if (policyLoading || packLoading) {
    return <div className="space-y-6"><Skeleton className="h-28 w-full rounded-xl" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <>
      <div className="space-y-6">

        {/* ── Policy Header ──────────────────────────────────────────── */}
        <Card>
          <CardContent className="py-5">
            {!policyPack ? (
              <div>
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-1">Policy</p>
                {isReadOnly ? (
                  <p className="text-sm text-muted-foreground">No policy has been created yet. An Admin must create one before configuration sections become available.</p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground mb-4">Give this policy a name to unlock all configuration sections below.</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <Input
                        value={policyNameInput}
                        onChange={e => setPolicyNameInput(e.target.value)}
                        placeholder="e.g. Standard Collections Policy 2025"
                        className="max-w-sm"
                        onKeyDown={e => { if (e.key === "Enter" && policyNameInput.trim()) createPackMutation.mutate(policyNameInput.trim()); }}
                        data-testid="input-policy-name"
                      />
                      <Button
                        onClick={() => createPackMutation.mutate(policyNameInput.trim())}
                        disabled={!policyNameInput.trim() || createPackMutation.isPending}
                        data-testid="button-create-policy">
                        {createPackMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Create Policy
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-1">Policy</p>
                  {isEditingName ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={editingNameValue}
                        onChange={e => setEditingNameValue(e.target.value)}
                        className="text-lg font-semibold h-9 max-w-sm"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter" && editingNameValue.trim()) renamePackMutation.mutate(editingNameValue.trim());
                          if (e.key === "Escape") setIsEditingName(false);
                        }}
                        onBlur={() => {
                          if (editingNameValue.trim() && editingNameValue !== policyPack.policyName) renamePackMutation.mutate(editingNameValue.trim());
                          else setIsEditingName(false);
                        }}
                        data-testid="input-rename-policy"
                      />
                      {renamePackMutation.isPending && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 group cursor-default">
                      <h2 className="text-lg font-semibold leading-tight" data-testid="text-policy-name">{policyPack.policyName}</h2>
                      {!isReadOnly && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => { setEditingNameValue(policyPack.policyName); setIsEditingName(true); }}
                          data-testid="button-rename-policy">
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 pt-1 shrink-0">
                  <Badge variant={policyPack.status === "active" ? "default" : "secondary"} className="capitalize" data-testid="badge-policy-status">
                    {policyPack.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">Updated {new Date(policyPack.updatedAt).toLocaleDateString()}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Gate: show lock message if no policy created yet ──────── */}
        {!policyPack ? (
          <div className="rounded-xl border-2 border-dashed border-border/60 p-10 text-center text-muted-foreground">
            <Lock className="w-8 h-8 mx-auto mb-3 opacity-25" />
            <p className="text-sm font-medium">All configuration sections will appear here once you name your policy above.</p>
          </div>
        ) : (
          <>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Section A: DPD Configuration</CardTitle>
                <CardDescription>Configure Days Past Due (DPD) stages for your collection workflow.</CardDescription>
              </div>
              {!isReadOnly && (
                <Button variant="outline" size="sm" onClick={openAddStageDialog} data-testid="button-add-stage">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add Stage
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {dpdStages.length > 0 && (
              <p className="text-sm text-muted-foreground mb-4">{dpdStages.length} DPD Stages Configured</p>
            )}
            {dpdStages.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">No DPD stages configured yet. Click "Add Stage" to create your first one.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {dpdStages.map((stage) => {
                  const colors = getColorClasses(stage.color);
                  return (
                    <div
                      key={stage.id}
                      className={`rounded-lg border p-4 ${colors.bg} ${colors.border}`}
                      data-testid={`card-dpd-stage-${stage.id}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-2.5 h-2.5 rounded-full ${colors.dot}`} />
                          <span className="font-semibold text-sm">{stage.name}</span>
                        </div>
                        {!isReadOnly && (
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditStageDialog(stage)} data-testid={`button-edit-stage-${stage.id}`}>
                              <Pencil className="w-3.5 h-3.5 text-primary" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteStageMutation.mutate(stage.id)} data-testid={`button-delete-stage-${stage.id}`}>
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {stage.description && (
                        <p className="text-xs text-muted-foreground mt-1 ml-4.5">{stage.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-2 ml-4.5">
                        From <span className="font-medium text-foreground">{stage.fromDays}</span> days &nbsp; To <span className="font-medium text-foreground">{stage.toDays}</span> days
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Section B: Affordability Rules</CardTitle>
                <CardDescription>Define how Next Month Pay Capability (NMPC) is compared to Minimum Amount Due (MAD) to determine affordability.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={addAffordabilityRule} data-testid="button-add-affordability-rule">
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Rule
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-affordability-rules">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground w-36">Label</th>
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground w-24">Operator</th>
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground w-28">% of MAD</th>
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground">Additional Condition</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {affordabilityRules.map((rule) => (
                    <tr key={rule.id} className="border-b last:border-0" data-testid={`row-affordability-rule-${rule.id}`}>
                      <td className="py-2 px-2">
                        <Select value={rule.label} onValueChange={(v) => updateAffordabilityRule(rule.id, "label", v)}>
                          <SelectTrigger className="h-9 text-xs" data-testid={`select-aff-label-${rule.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {AFFORDABILITY_LABELS.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="py-2 px-2">
                        <Select value={rule.operator} onValueChange={(v) => updateAffordabilityRule(rule.id, "operator", v)}>
                          <SelectTrigger className="h-9 text-xs font-mono" data-testid={`select-aff-op-${rule.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {AFFORDABILITY_OPERATORS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="py-2 px-2">
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            value={rule.percentage ?? ""}
                            onChange={(e) => updateAffordabilityRule(rule.id, "percentage", e.target.value ? parseInt(e.target.value) : null)}
                            className="h-9 text-xs w-16"
                            placeholder="0"
                            data-testid={`input-aff-pct-${rule.id}`}
                          />
                          <span className="text-xs text-muted-foreground">%</span>
                        </div>
                      </td>
                      <td className="py-2 px-2">
                        <Input
                          value={rule.condition}
                          onChange={(e) => updateAffordabilityRule(rule.id, "condition", e.target.value)}
                          placeholder="Additional condition (optional)"
                          className="h-9 text-xs"
                          data-testid={`input-aff-condition-${rule.id}`}
                        />
                      </td>
                      <td className="py-2 px-2">
                        {!rule.isDefault && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeAffordabilityRule(rule.id)} data-testid={`button-remove-aff-rule-${rule.id}`}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 p-3 rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-800 dark:text-amber-300">If Minimum Amount Due is missing or no payment data exists, affordability defaults to <strong>VERY LOW</strong>. The system will still provide the best estimate possible based on available data.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section C: Vulnerability Definition</CardTitle>
            <CardDescription>Define what counts as vulnerable for your customers. This definition will guide how the AI identifies vulnerability.</CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={vulnerabilityDefinition}
              onChange={(e) => setVulnerabilityDefinition(e.target.value)}
              placeholder="Define what counts as vulnerable for your customers...&#10;&#10;For example:&#10;- Health / mental capacity issues (mental health crisis, serious illness, cognitive impairment)&#10;- Bereavement (customer deceased or death of close family member)&#10;- Severe accident / safety risk (major injury, domestic violence disclosure)&#10;- Legal / exceptional service status (active military deployment, incarceration)&#10;- Exploitation / loss of control (fraud/scam victim, coerced payments)"
              className="min-h-[180px] text-sm"
              data-testid="textarea-vulnerability-definition"
            />
          </CardContent>
        </Card>

        <PolicyPackSection isReadOnly={isReadOnly} policyPack={policyPack!} />

        {false && (<>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Section D: Available Treatments (LEGACY)</CardTitle>
            </CardHeader>
          <CardContent className="space-y-4">
            {treatments.map((treatment, index) => (
              <div key={treatment.name} className={`rounded-lg border p-4 ${treatment.enabled ? "bg-primary/5 border-primary/20" : "bg-muted/30"}`} data-testid={`card-treatment-${index}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1">
                    <Checkbox
                      checked={treatment.enabled}
                      onCheckedChange={() => toggleTreatment(index)}
                      className="mt-0.5"
                      data-testid={`checkbox-treatment-${index}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{treatment.name}</span>
                        {treatment.isCustom && <Badge variant="secondary" className="text-[10px]">Custom</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{treatment.definition}</p>
                      {treatment.enabled && dpdStages.length > 0 && (
                        <div className="mt-2 flex items-center gap-3 flex-wrap">
                          <span className="text-xs text-muted-foreground">Blocked in:</span>
                          {dpdStages.map(stage => (
                            <label key={stage.id} className="flex items-center gap-1.5 cursor-pointer">
                              <Checkbox
                                checked={(treatment.blockedStages || []).includes(stage.name)}
                                onCheckedChange={() => toggleBlockedStage(index, stage.name)}
                                className="h-3.5 w-3.5"
                                data-testid={`checkbox-block-${index}-${stage.name}`}
                              />
                              <span className="text-xs">{stage.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      {treatment.enabled && treatment.name === "Clear Arrears Plan" && (
                        <div className="mt-3 flex items-center gap-2">
                          <Label className="text-xs whitespace-nowrap">Maximum months to clear arrears:</Label>
                          <Input
                            type="number"
                            min={2}
                            max={12}
                            value={treatment.clearanceMonths || 6}
                            onChange={(e) => updateClearanceMonths(index, Math.min(12, Math.max(2, parseInt(e.target.value) || 6)))}
                            className="w-20 h-8 text-sm"
                            data-testid="input-clearance-months"
                          />
                          <span className="text-xs text-muted-foreground">months (2-12)</span>
                        </div>
                      )}
                    </div>
                  </div>
                  {treatment.isCustom && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removeCustomTreatment(index)} data-testid={`button-remove-treatment-${index}`}>
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <div className="border-t pt-4 mt-4">
              <p className="text-sm font-medium mb-3">Add Custom Treatment</p>
              <div className="space-y-3">
                <Input
                  value={customTreatmentName}
                  onChange={(e) => setCustomTreatmentName(e.target.value)}
                  placeholder="Treatment name"
                  data-testid="input-custom-treatment-name"
                />
                <Textarea
                  value={customTreatmentDef}
                  onChange={(e) => setCustomTreatmentDef(e.target.value)}
                  placeholder="Treatment definition — describe when and how this treatment should be applied..."
                  className="min-h-[80px] text-sm"
                  data-testid="textarea-custom-treatment-def"
                />
                <Button variant="outline" size="sm" onClick={addCustomTreatment} disabled={!customTreatmentName.trim()} data-testid="button-add-custom-treatment">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add Treatment
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section E: Decision Rules</CardTitle>
            <CardDescription>Define structured rules for when Beacon should recommend each treatment. Rules are evaluated by priority (lower number = higher priority).</CardDescription>
          </CardHeader>
          <CardContent>
            {decisionRules.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <p className="text-sm mb-3">No decision rules configured yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-decision-rules">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Treatment</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Affordability</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Willingness</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Other Condition</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Tone</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground w-20">Priority</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {decisionRules.map((rule) => {
                      const isEncourage = rule.treatmentName === "None — Encourage Payment";
                      return (
                      <React.Fragment key={rule.id}>
                      <tr className={isEncourage ? "" : "border-b last:border-0"} data-testid={`row-decision-rule-${rule.id}`}>
                        <td className="py-2 px-2">
                          <Select value={rule.treatmentName} onValueChange={(v) => updateDecisionRule(rule.id, "treatmentName", v)}>
                            <SelectTrigger className="h-9 text-xs" data-testid={`select-treatment-${rule.id}`}>
                              <SelectValue placeholder="Select treatment" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="None — Encourage Payment">None — Encourage Payment</SelectItem>
                              {enabledTreatments.map(t => (
                                <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
                              ))}
                              <SelectItem value="Agent Review — Escalate to Human">Agent Review — Escalate to Human</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 px-2">
                          <MultiSelectDropdown
                            values={Array.isArray(rule.affordability) ? rule.affordability : [rule.affordability || "ANY"]}
                            options={AFFORDABILITY_OPTIONS}
                            onChange={(v) => updateDecisionRule(rule.id, "affordability", v)}
                            testIdPrefix={`select-affordability-${rule.id}`}
                          />
                        </td>
                        <td className="py-2 px-2">
                          <MultiSelectDropdown
                            values={Array.isArray(rule.willingness) ? rule.willingness : [rule.willingness || "ANY"]}
                            options={WILLINGNESS_OPTIONS}
                            onChange={(v) => updateDecisionRule(rule.id, "willingness", v)}
                            testIdPrefix={`select-willingness-${rule.id}`}
                          />
                        </td>
                        <td className="py-2 px-2">
                          <Input
                            value={rule.otherCondition}
                            onChange={(e) => updateDecisionRule(rule.id, "otherCondition", e.target.value)}
                            placeholder="e.g., consecutive payments >= 3"
                            className="h-9 text-xs"
                            data-testid={`input-other-condition-${rule.id}`}
                          />
                        </td>
                        <td className="py-2 px-2">
                          <Select
                            value={rule.communicationTone || "Supportive"}
                            onValueChange={(v) => updateDecisionRule(rule.id, "communicationTone", v)}
                          >
                            <SelectTrigger className="h-9 text-xs" data-testid={`select-tone-${rule.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="Supportive">Supportive</SelectItem>
                              <SelectItem value="Firm">Firm</SelectItem>
                              <SelectItem value="Urgent">Urgent</SelectItem>
                              <SelectItem value="Empathetic">Empathetic</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 px-2">
                          <Input
                            type="number"
                            value={rule.priority}
                            onChange={(e) => updateDecisionRule(rule.id, "priority", parseInt(e.target.value) || 0)}
                            className="h-9 text-xs w-16"
                            data-testid={`input-priority-${rule.id}`}
                          />
                        </td>
                        <td className="py-2 px-2">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeDecisionRule(rule.id)} data-testid={`button-remove-rule-${rule.id}`}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                      {isEncourage && (
                        <tr className="border-b last:border-0" data-testid={`row-encourage-fields-${rule.id}`}>
                          <td colSpan={7} className="py-2 px-2">
                            <div className="flex items-center gap-4 pl-2 py-1 bg-muted/30 rounded-md px-3">
                              <div className="flex items-center gap-2">
                                <Label className="text-xs whitespace-nowrap text-muted-foreground">Payment Target:</Label>
                                <Select
                                  value={rule.paymentTarget || "At or above MAD"}
                                  onValueChange={(v) => updateDecisionRule(rule.id, "paymentTarget", v)}
                                >
                                  <SelectTrigger className="h-8 text-xs w-48" data-testid={`select-payment-target-${rule.id}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="At or above MAD">At or above MAD</SelectItem>
                                    <SelectItem value="Any amount they can afford">Any amount they can afford</SelectItem>
                                    <SelectItem value="Specific amount">Specific amount</SelectItem>
                                  </SelectContent>
                                </Select>
                                {rule.paymentTarget === "Specific amount" && (
                                  <Input
                                    type="number"
                                    value={rule.paymentTargetAmount || ""}
                                    onChange={(e) => updateDecisionRule(rule.id, "paymentTargetAmount", parseFloat(e.target.value) || 0)}
                                    placeholder="Amount"
                                    className="h-8 text-xs w-24"
                                    data-testid={`input-payment-amount-${rule.id}`}
                                  />
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="pt-3">
              <Button variant="outline" size="sm" onClick={addDecisionRule} data-testid="button-add-rule">
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Rule
              </Button>
            </div>
          </CardContent>
        </Card>
        </>)}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section F: Escalation & Guardrails</CardTitle>
            <CardDescription>Define conditions that should automatically escalate a case to a human reviewer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-amber-600" />
                  <Checkbox checked={true} disabled className="opacity-70" />
                </div>
                <div>
                  <span className="font-medium text-sm">Vulnerability detected</span>
                  <span className="text-xs text-amber-600 dark:text-amber-400 ml-2">Always enabled</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-10">Cases with detected vulnerability are always escalated for human review.</p>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                <Checkbox
                  checked={escalation.legalAction}
                  onCheckedChange={(c) => setEscalation(prev => ({ ...prev, legalAction: !!c }))}
                  data-testid="checkbox-esc-legal"
                />
                <span className="text-sm">Customer mentions legal action</span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                <Checkbox
                  checked={escalation.debtDispute}
                  onCheckedChange={(c) => setEscalation(prev => ({ ...prev, debtDispute: !!c }))}
                  data-testid="checkbox-esc-dispute"
                />
                <span className="text-sm">Customer disputes the debt</span>
              </label>

              <div className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                <Checkbox
                  checked={escalation.balanceAbove !== null}
                  onCheckedChange={(c) => setEscalation(prev => ({ ...prev, balanceAbove: c ? 0 : null }))}
                  data-testid="checkbox-esc-balance"
                />
                <span className="text-sm whitespace-nowrap">Balance above</span>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    value={escalation.balanceAbove ?? ""}
                    onChange={(e) => setEscalation(prev => ({ ...prev, balanceAbove: e.target.value ? parseFloat(e.target.value) : null }))}
                    disabled={escalation.balanceAbove === null}
                    className="h-8 w-28 text-sm"
                    placeholder="Amount"
                    data-testid="input-esc-balance"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                <Checkbox
                  checked={escalation.dpdAbove !== null}
                  onCheckedChange={(c) => setEscalation(prev => ({ ...prev, dpdAbove: c ? 0 : null }))}
                  data-testid="checkbox-esc-dpd"
                />
                <span className="text-sm whitespace-nowrap">DPD above</span>
                <Input
                  type="number"
                  value={escalation.dpdAbove ?? ""}
                  onChange={(e) => setEscalation(prev => ({ ...prev, dpdAbove: e.target.value ? parseInt(e.target.value) : null }))}
                  disabled={escalation.dpdAbove === null}
                  className="h-8 w-28 text-sm"
                  placeholder="Days"
                  data-testid="input-esc-dpd"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>

              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                <Checkbox
                  checked={escalation.managerRequest}
                  onCheckedChange={(c) => setEscalation(prev => ({ ...prev, managerRequest: !!c }))}
                  data-testid="checkbox-esc-manager"
                />
                <span className="text-sm">Customer requests to speak to a manager</span>
              </label>

              <div className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                <Checkbox
                  checked={escalation.brokenPtps !== null}
                  onCheckedChange={(c) => setEscalation(prev => ({ ...prev, brokenPtps: c ? 0 : null }))}
                  data-testid="checkbox-esc-ptps"
                />
                <span className="text-sm whitespace-nowrap">Broken PTPs in last 90 days &ge;</span>
                <Input
                  type="number"
                  value={escalation.brokenPtps ?? ""}
                  onChange={(e) => setEscalation(prev => ({ ...prev, brokenPtps: e.target.value ? parseInt(e.target.value) : null }))}
                  disabled={escalation.brokenPtps === null}
                  className="h-8 w-20 text-sm"
                  placeholder="Count"
                  data-testid="input-esc-ptps"
                />
              </div>
            </div>

            {escalation.otherConditions.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-xs font-medium text-muted-foreground">Custom Conditions</p>
                {escalation.otherConditions.map((cond, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 rounded border bg-muted/20" data-testid={`card-esc-custom-${i}`}>
                    <Badge variant="outline" className="text-xs">{cond.field}</Badge>
                    <span className="text-xs font-mono text-muted-foreground">{cond.operator}</span>
                    <Badge variant="secondary" className="text-xs">{cond.value}</Badge>
                    <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={() => removeCustomEscalation(i)} data-testid={`button-remove-esc-${i}`}>
                      <Trash2 className="w-3 h-3 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">Add Custom Condition</p>
              <div className="flex items-end gap-2 flex-wrap">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Data Field</label>
                  <Input
                    value={customEscField}
                    onChange={(e) => setCustomEscField(e.target.value)}
                    placeholder="e.g., income"
                    className="h-9 w-40 text-sm"
                    data-testid="input-custom-esc-field"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Operator</label>
                  <Select value={customEscOp} onValueChange={setCustomEscOp}>
                    <SelectTrigger className="h-9 w-24 text-sm" data-testid="select-custom-esc-op">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ESCALATION_OPERATORS.map(op => <SelectItem key={op} value={op}>{op}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Value</label>
                  <Input
                    value={customEscValue}
                    onChange={(e) => setCustomEscValue(e.target.value)}
                    placeholder="e.g., 5000"
                    className="h-9 w-32 text-sm"
                    data-testid="input-custom-esc-value"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={addCustomEscalation} disabled={!customEscField.trim() || !customEscValue.trim()} data-testid="button-add-custom-esc">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {!isReadOnly && (
          <div className="pt-2 pb-8">
            <Button onClick={() => savePolicyMutation.mutate()} disabled={savePolicyMutation.isPending} data-testid="button-save-policy-config">
              {savePolicyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Policy Configuration
            </Button>
          </div>
        )}
          </>
        )}
      </div>

      <Dialog open={stageDialogOpen} onOpenChange={setStageDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStage ? "Edit DPD Stage" : "Add DPD Stage"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Stage Name</label>
              <Input value={stageName} onChange={(e) => setStageName(e.target.value)} placeholder="e.g. Pre Due, Grace, Early" data-testid="input-stage-name" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Description</label>
              <Input value={stageDesc} onChange={(e) => setStageDesc(e.target.value)} placeholder="e.g. Accounts approaching due date" data-testid="input-stage-description" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1.5 block">From (days)</label>
                <Input type="number" value={stageFrom} onChange={(e) => setStageFrom(e.target.value)} placeholder="-5" data-testid="input-stage-from" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">To (days)</label>
                <Input type="number" value={stageTo} onChange={(e) => setStageTo(e.target.value)} placeholder="0" data-testid="input-stage-to" />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Color</label>
              <div className="flex gap-2 flex-wrap">
                {STAGE_COLORS.map((c) => (
                  <button key={c.name} type="button" className={`w-8 h-8 rounded-full ${c.dot} ${stageColor === c.name ? "ring-2 ring-offset-2 ring-primary" : ""}`} onClick={() => setStageColor(c.name)} data-testid={`button-color-${c.name}`} />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeStageDialog}>Cancel</Button>
            <Button onClick={handleSaveStage} disabled={createStageMutation.isPending || updateStageMutation.isPending} data-testid="button-save-stage">
              {(createStageMutation.isPending || updateStageMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editingStage ? "Update Stage" : "Add Stage"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const DATA_CATEGORIES = [
  {
    id: "loan_account",
    name: "Loan / Account Data",
    description: "Information about each customer loan or account, such as account ID, balances, due amounts, arrears status, and important dates.",
    docType: "tabular" as const,
    accept: ".csv,.xlsx,.xls",
  },
  {
    id: "payment_history",
    name: "Payment History",
    description: "Records of payments made or missed over time, including payment dates, amounts, and payment status.",
    docType: "tabular" as const,
    accept: ".csv,.xlsx,.xls",
  },
  {
    id: "conversation_history",
    name: "Conversation History",
    description: "Customer interactions such as calls, emails, chats, or notes, with date/time and message or outcome.",
    docType: "tabular" as const,
    accept: ".csv,.xlsx,.xls",
  },
  {
    id: "income_employment",
    name: "Income and Employment Data",
    description: "Information that helps assess affordability, such as income, employer status, and employment changes.",
    docType: "tabular" as const,
    accept: ".csv,.xlsx,.xls",
  },
  {
    id: "credit_bureau",
    name: "Credit Bureau Data",
    description: "External bureau information such as scores, delinquencies, or other credit-related indicators.",
    docType: "tabular" as const,
    accept: ".csv,.xlsx,.xls",
  },
  {
    id: "compliance_policy",
    name: "Compliance Policy / Internal Rules",
    description: "Policy or operating documents that explain how collections, forbearance, or compliance decisions should be handled.",
    docType: "document" as const,
    accept: ".pdf,.docx,.txt",
  },
  {
    id: "knowledge_base",
    name: "Knowledge Base / Agent Guidance",
    description: "Internal reference material used by agents, such as playbooks, FAQs, and customer handling guidance.",
    docType: "document" as const,
    accept: ".pdf,.docx,.txt",
  },
];

function DataConfigTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isReadOnly = user?.role === "superadmin" || user?.role === "manager";

  const { data: dataConfig, isLoading } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });

  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoryData, setCategoryData] = useState<Record<string, CategoryEntry>>({});
  const [analyzingCategories, setAnalyzingCategories] = useState<Set<string>>(new Set());
  const [editingField, setEditingField] = useState<{ categoryId: string; fieldIndex: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingForRef = useRef<string>("");
  const uploadAcceptRef = useRef<string>(".csv,.xlsx,.xls,.pdf,.docx,.txt");

  useEffect(() => {
    if (dataConfig && !hydrated) {
      const sc = (dataConfig as any).selectedCategories;
      const cd = (dataConfig as any).categoryData;
      if (sc && Array.isArray(sc) && sc.length > 0) setSelectedCategories(sc);
      if (cd && typeof cd === "object") setCategoryData(cd);
      setHydrated(true);
    }
  }, [dataConfig, hydrated]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const method = dataConfig ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/data-config", {
        selectedCategories,
        categoryData,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data-config"] });
      toast({ title: "Data configuration saved" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save.", variant: "destructive" });
    },
  });

  async function handleFile(categoryId: string, file: File) {
    setAnalyzingCategories(prev => new Set([...prev, categoryId]));
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", categoryId);
      const res = await fetch("/api/data-config/analyze-category", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setCategoryData(prev => ({
        ...prev,
        [categoryId]: {
          fileName: data.fileName,
          fileSize: data.fileSize,
          docType: data.docType,
          uploadedAt: new Date().toISOString(),
          fieldAnalysis: (data.fieldAnalysis || []).map((f: FieldReview) => ({
            ...f,
            userDescription: "",
            ignored: false,
          })),
        },
      }));
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setAnalyzingCategories(prev => {
        const next = new Set(prev);
        next.delete(categoryId);
        return next;
      });
    }
  }

  function triggerUpload(categoryId: string, accept: string) {
    uploadingForRef.current = categoryId;
    uploadAcceptRef.current = accept;
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.click();
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && uploadingForRef.current) {
      handleFile(uploadingForRef.current, file);
    }
    e.target.value = "";
  }

  function removeFile(categoryId: string) {
    setCategoryData(prev => {
      const next = { ...prev };
      delete next[categoryId];
      return next;
    });
  }

  function toggleCategory(categoryId: string, checked: boolean) {
    if (checked) {
      setSelectedCategories(prev => [...prev, categoryId]);
    } else {
      setSelectedCategories(prev => prev.filter(id => id !== categoryId));
      removeFile(categoryId);
    }
  }

  function updateFieldDescription(categoryId: string, fieldIndex: number, value: string) {
    setCategoryData(prev => {
      const entry = prev[categoryId];
      if (!entry?.fieldAnalysis) return prev;
      const updatedFields = entry.fieldAnalysis.map((f, i) =>
        i === fieldIndex ? { ...f, userDescription: value } : f
      );
      return { ...prev, [categoryId]: { ...entry, fieldAnalysis: updatedFields } };
    });
  }

  function toggleIgnoreField(categoryId: string, fieldIndex: number) {
    setCategoryData(prev => {
      const entry = prev[categoryId];
      if (!entry?.fieldAnalysis) return prev;
      const updatedFields = entry.fieldAnalysis.map((f, i) =>
        i === fieldIndex ? { ...f, ignored: !f.ignored } : f
      );
      return { ...prev, [categoryId]: { ...entry, fieldAnalysis: updatedFields } };
    });
  }

  function confidenceBadge(confidence: string) {
    if (confidence === "High") return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
    if (confidence === "Medium") return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
    return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <div className="space-y-6">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileInputChange}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data You Can Provide</CardTitle>
          <CardDescription>
            Select the types of data you can share with Beacon. For each selected category, upload a sample file so Beacon can understand the fields and prepare your configuration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {DATA_CATEGORIES.map(cat => {
            const isSelected = selectedCategories.includes(cat.id);
            const entry = categoryData[cat.id];
            const isAnalyzing = analyzingCategories.has(cat.id);

            return (
              <div
                key={cat.id}
                className={`border rounded-lg p-4 transition-colors ${isSelected ? "border-primary/40 bg-primary/5" : "border-border"}`}
                data-testid={`card-category-${cat.id}`}
              >
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    checked={isSelected}
                    disabled={isReadOnly}
                    onCheckedChange={(checked) => toggleCategory(cat.id, !!checked)}
                    data-testid={`checkbox-category-${cat.id}`}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{cat.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{cat.description}</div>
                  </div>
                </label>

                {isSelected && (
                  <div className="mt-4 ml-7">
                    {isAnalyzing ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Beacon is analyzing your file…</span>
                      </div>
                    ) : !entry?.fileName ? (
                      <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                        <Upload className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground mb-1">
                          Upload a sample file representative of your {cat.name.toLowerCase()} data.
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 mb-3">
                          Accepted: {cat.docType === "tabular" ? "CSV, XLSX" : "PDF, DOCX, TXT"}
                        </p>
                        {!isReadOnly && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => triggerUpload(cat.id, cat.accept)}
                            data-testid={`button-upload-${cat.id}`}
                          >
                            <Upload className="w-3.5 h-3.5 mr-1.5" />
                            Upload Sample File
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-sm">
                            <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium truncate max-w-[240px]">{entry.fileName}</span>
                            {entry.fileSize && (
                              <span className="text-xs text-muted-foreground flex-shrink-0">
                                ({(entry.fileSize / 1024).toFixed(1)} KB)
                              </span>
                            )}
                          </div>
                          {!isReadOnly && (
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs h-7 px-2"
                                onClick={() => triggerUpload(cat.id, cat.accept)}
                                data-testid={`button-reupload-${cat.id}`}
                              >
                                <Upload className="w-3 h-3 mr-1" />
                                Re-upload
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                onClick={() => removeFile(cat.id)}
                                data-testid={`button-remove-${cat.id}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>

                        {entry.docType === "tabular" && entry.fieldAnalysis && entry.fieldAnalysis.length > 0 && (
                          <div className="space-y-2">
                            <div>
                              <h4 className="text-sm font-medium">Review Beacon's understanding</h4>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                Beacon analyzed this file and described what each field appears to mean. {!isReadOnly && "Click any description to edit it before saving."}
                              </p>
                            </div>
                            <div className="border rounded-md overflow-hidden">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-muted/50 border-b">
                                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-[175px]">Field Name</th>
                                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Beacon's Understanding</th>
                                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-[85px]">Confidence</th>
                                    <th className="text-center px-3 py-2 text-xs font-medium text-muted-foreground w-[65px]">Ignore</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {entry.fieldAnalysis.map((field, idx) => (
                                    <tr
                                      key={`${field.fieldName}-${idx}`}
                                      className={`border-b last:border-0 ${field.ignored ? "opacity-40" : ""}`}
                                      data-testid={`row-field-${cat.id}-${idx}`}
                                    >
                                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{field.fieldName}</td>
                                      <td className="px-3 py-2">
                                        {editingField?.categoryId === cat.id && editingField?.fieldIndex === idx && !isReadOnly ? (
                                          <input
                                            autoFocus
                                            className="w-full text-xs border rounded px-2 py-1 bg-background outline-none focus:ring-1 focus:ring-primary"
                                            value={editValue}
                                            onChange={e => setEditValue(e.target.value)}
                                            onBlur={() => {
                                              updateFieldDescription(cat.id, idx, editValue);
                                              setEditingField(null);
                                            }}
                                            onKeyDown={e => {
                                              if (e.key === "Enter") { updateFieldDescription(cat.id, idx, editValue); setEditingField(null); }
                                              if (e.key === "Escape") setEditingField(null);
                                            }}
                                            data-testid={`input-field-desc-${cat.id}-${idx}`}
                                          />
                                        ) : (
                                          <div
                                            className={`flex items-start gap-1.5 ${!isReadOnly && !field.ignored ? "cursor-pointer group" : ""}`}
                                            onClick={() => {
                                              if (!isReadOnly && !field.ignored) {
                                                setEditingField({ categoryId: cat.id, fieldIndex: idx });
                                                setEditValue(field.userDescription || field.beaconsUnderstanding);
                                              }
                                            }}
                                            data-testid={`text-field-desc-${cat.id}-${idx}`}
                                          >
                                            <span className={`text-xs leading-relaxed group-hover:text-primary transition-colors`}>
                                              {field.userDescription || field.beaconsUnderstanding}
                                              {field.userDescription && (
                                                <span className="text-muted-foreground ml-1 text-[10px]">(edited)</span>
                                              )}
                                            </span>
                                            {!isReadOnly && !field.ignored && (
                                              <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary flex-shrink-0 mt-0.5 transition-colors" />
                                            )}
                                          </div>
                                        )}
                                      </td>
                                      <td className="px-3 py-2">
                                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${confidenceBadge(field.confidence)}`}>
                                          {field.confidence}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 text-center">
                                        <Checkbox
                                          checked={field.ignored}
                                          disabled={isReadOnly}
                                          onCheckedChange={() => toggleIgnoreField(cat.id, idx)}
                                          data-testid={`checkbox-ignore-${cat.id}-${idx}`}
                                        />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {entry.docType === "document" && (
                          <p className="text-xs text-muted-foreground">
                            Document uploaded successfully. Beacon will use this as reference guidance during analysis.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {!isReadOnly && (
        <div className="pt-2 pb-8">
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-dataconfig">
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Configuration
          </Button>
        </div>
      )}
    </div>
  );
}

function PromptConfigTab() {
  const { toast } = useToast();

  const { data: dataConfig } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });
  const { data: previewData, isLoading: previewLoading, refetch: refetchPreview } = useQuery<{
    preview: string;
    compiledAt: string | null;
    isLive: boolean;
  }>({ queryKey: ["/api/prompt-preview"] });

  const [outputFormat, setOutputFormat] = useState(DEFAULT_OUTPUT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (dataConfig && !hydrated) {
      if (dataConfig.outputFormat) {
        setOutputFormat(dataConfig.outputFormat);
      }
      setHydrated(true);
    }
  }, [dataConfig, hydrated]);

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/prompt-preview/regenerate");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/policy-config"] });
      toast({ title: "Prompt regenerated", description: "The prompt has been recompiled from your latest Policy Config." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to regenerate prompt.", variant: "destructive" });
    },
  });

  const saveOutputMutation = useMutation({
    mutationFn: async () => {
      const method = dataConfig ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/data-config", {
        outputFormat,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data-config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-preview"] });
      toast({ title: "Output format saved" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save output format.", variant: "destructive" });
    },
  });

  const copyToClipboard = () => {
    if (previewData?.preview) {
      navigator.clipboard.writeText(previewData.preview);
      toast({ title: "Copied", description: "Full prompt copied to clipboard." });
    }
  };

  const compiledAtText = previewData?.compiledAt
    ? `Last compiled: ${new Date(previewData.compiledAt).toLocaleString()}`
    : "Not yet compiled";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
        <div className="text-sm text-blue-800 dark:text-blue-300">
          <p className="font-medium">Auto-generated prompt</p>
          <p className="mt-1">
            This prompt is auto-generated from your Policy Config. To change rules, edit the Policy Config tab.
            {" "}<span className="font-medium">{compiledAtText}</span>
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Eye className="w-4 h-4" />
              Assembled Prompt Preview
            </CardTitle>
            <CardDescription>Read-only view of the full prompt (Brain + Policy Config). Customer data is injected at runtime.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => regenerateMutation.mutate()}
              disabled={regenerateMutation.isPending}
              data-testid="button-regenerate-preview"
            >
              {regenerateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
              Regenerate
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={copyToClipboard}
              data-testid="button-copy-prompt"
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              Copy
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {previewLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}
            </div>
          ) : (
            <pre
              className="min-h-[500px] max-h-[700px] overflow-auto text-sm font-mono leading-relaxed whitespace-pre-wrap bg-muted/50 dark:bg-muted/20 rounded-lg p-4 border"
              data-testid="text-prompt-preview"
            >
              {previewData?.preview || "No prompt generated yet. Save your Policy Config first."}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expected Output Format</CardTitle>
          <CardDescription>Define the JSON structure expected from AI responses. This section is editable.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={outputFormat}
            onChange={(e) => setOutputFormat(e.target.value)}
            className="min-h-[200px] text-sm font-mono"
            data-testid="textarea-output-format"
          />
        </CardContent>
      </Card>

      <div className="pt-2 pb-8">
        <Button onClick={() => saveOutputMutation.mutate()} disabled={saveOutputMutation.isPending} data-testid="button-save-prompt-config">
          {saveOutputMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Output Format
        </Button>
      </div>
    </div>
  );
}

export default function ClientSetupPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";
  const noCompanySelected = isSuperAdmin && !user?.viewingCompanyId;

  const { data: config } = useQuery<ClientConfig>({ queryKey: ["/api/client-config"], enabled: !noCompanySelected });

  if (noCompanySelected) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Select a Company</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Please select a company from the dropdown in the sidebar to view client configuration.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-setup-heading">
          Client Configuration
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your company, rules, and data settings in one place.
        </p>
      </div>

      <Tabs defaultValue="data-config" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="data-config" data-testid="tab-data-config">
            <Database className="w-3.5 h-3.5 mr-1.5" />
            Data Configuration
          </TabsTrigger>
          <TabsTrigger value="policy" data-testid="tab-policy-config">
            <Shield className="w-3.5 h-3.5 mr-1.5" />
            Policy Config
          </TabsTrigger>
          {isSuperAdmin && (
            <TabsTrigger value="prompt-config" data-testid="tab-prompt-config">
              <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
              Prompt Config
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="data-config">
          <DataConfigTab />
        </TabsContent>

        <TabsContent value="policy">
          <PolicyConfigTab />
        </TabsContent>

        {isSuperAdmin && (
          <TabsContent value="prompt-config">
            <PromptConfigTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
