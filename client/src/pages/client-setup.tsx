import React, { useState, useEffect, useCallback, useRef } from "react";
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
  Building2, Mail, Phone, User, Save, Loader2,
  BookOpen, Upload, FileText, Trash2, Plus, File as FileIcon,
  Database, Pencil, MessageSquare, RotateCcw, Shield, Lock, AlertTriangle,
  Copy, RefreshCw, Info, Eye,
} from "lucide-react";
import type { ClientConfig, Rulebook, DataConfig, DpdStage, PolicyConfig, TreatmentOption, DecisionRule, EscalationRules, EscalationCustomCondition, AffordabilityRule } from "@shared/schema";

const companyFormSchema = z.object({
  companyName: z.string().min(2, "Company name must be at least 2 characters"),
  contactEmail: z.string().email("Please enter a valid email"),
  contactName: z.string().min(2, "Contact name must be at least 2 characters"),
  contactPhone: z.string().optional(),
});

type CompanyFormValues = z.infer<typeof companyFormSchema>;

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
VERY LOW: if the customer cannot pay us anything or pay <10% of minimum amount due
NOT SURE: If there is not enough data to infer anything

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
VERY LOW: avoidance/ghosting, not at all engaging on any channels, repeated broken PTP, inconsistent reasons, no payments despite contact (especially if ability to pay not clearly constrained)
NOT SURE: If there is not enough data to infer anything

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

function CompanyDetailsTab() {
  const { toast } = useToast();
  const { user } = useAuth();

  const userFullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const userEmail = user?.email || "";

  const { data: config, isLoading } = useQuery<ClientConfig>({
    queryKey: ["/api/client-config"],
  });

  const form = useForm<CompanyFormValues>({
    resolver: zodResolver(companyFormSchema),
    defaultValues: {
      companyName: "",
      contactEmail: userEmail,
      contactName: userFullName,
      contactPhone: "",
    },
    values: config
      ? {
          companyName: config.companyName,
          contactEmail: userEmail,
          contactName: config.contactName,
          contactPhone: config.contactPhone || "",
        }
      : undefined,
  });

  const mutation = useMutation({
    mutationFn: async (data: CompanyFormValues) => {
      const method = config ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/client-config", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/client-config"] });
      toast({ title: "Configuration saved", description: "Your company details have been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save configuration.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card><CardContent className="p-6 space-y-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent></Card>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Company Details</CardTitle>
        <CardDescription>This information identifies your organization in the system.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
            <FormField
              control={form.control}
              name="companyName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5" />
                    Company Name
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="Acme Financial Services" {...field} data-testid="input-company-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contactName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" />
                    Contact Name
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="Jane Smith" {...field} data-testid="input-contact-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contactEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    Contact Email
                  </FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="jane@acmefinancial.com" {...field} disabled className="bg-muted/50 cursor-not-allowed" data-testid="input-contact-email" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contactPhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5" />
                    Contact Phone (optional)
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="+1 (555) 000-0000" {...field} data-testid="input-contact-phone" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="pt-2">
              <Button type="submit" disabled={mutation.isPending} data-testid="button-save-config">
                {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                {config ? "Update Configuration" : "Save Configuration"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
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

const AFFORDABILITY_OPTIONS = ["HIGH", "MEDIUM", "LOW", "VERY LOW", "NOT SURE"];
const WILLINGNESS_OPTIONS = ["HIGH", "MEDIUM", "LOW", "VERY LOW", "NOT SURE"];

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
const AFFORDABILITY_LABELS = ["HIGH", "MEDIUM", "LOW", "VERY LOW", "NOT SURE"];

const DEFAULT_AFFORDABILITY_RULES: AffordabilityRule[] = [
  { id: 1, label: "HIGH", operator: ">", percentage: 100, condition: "", isDefault: true },
  { id: 2, label: "MEDIUM", operator: ">=", percentage: 60, condition: "and < Minimum Amount Due", isDefault: true },
  { id: 3, label: "LOW", operator: "<", percentage: 60, condition: "", isDefault: true },
  { id: 4, label: "VERY LOW", operator: "<", percentage: 10, condition: "NMPC = 0 OR NMPC < 10% of MAD", isDefault: true },
  { id: 5, label: "NOT SURE", operator: "=", percentage: null, condition: "Not enough data to estimate NMPC or Minimum Amount Due not provided", isDefault: true },
];

function PolicyConfigTab() {
  const { toast } = useToast();

  const { data: policyConfig, isLoading: policyLoading } = useQuery<PolicyConfig>({
    queryKey: ["/api/policy-config"],
    retry: false,
  });
  const { data: dpdStages = [] } = useQuery<DpdStage[]>({ queryKey: ["/api/dpd-stages"] });

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

  if (policyLoading) {
    return <div className="space-y-6"><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Section A: DPD Configuration</CardTitle>
                <CardDescription>Configure Days Past Due (DPD) stages for your collection workflow.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={openAddStageDialog} data-testid="button-add-stage">
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Stage
              </Button>
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
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditStageDialog(stage)} data-testid={`button-edit-stage-${stage.id}`}>
                            <Pencil className="w-3.5 h-3.5 text-primary" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteStageMutation.mutate(stage.id)} data-testid={`button-delete-stage-${stage.id}`}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </div>
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
                        {rule.label === "NOT SURE" ? (
                          <span className="text-xs text-muted-foreground italic px-2">N/A</span>
                        ) : (
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
                        )}
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
                <p className="text-xs text-amber-800 dark:text-amber-300">If Minimum Amount Due is missing, output <strong>NOT SURE</strong> (and still provide best NMPC estimate if possible, clearly marked as an estimate).</p>
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section D: Available Treatments</CardTitle>
            <CardDescription>Select which treatments Beacon is allowed to recommend. Toggle on the treatments applicable to your business.</CardDescription>
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

        <div className="pt-2 pb-8">
          <Button onClick={() => savePolicyMutation.mutate()} disabled={savePolicyMutation.isPending} data-testid="button-save-policy-config">
            {savePolicyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Policy Configuration
          </Button>
        </div>
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

function DataConfigTab() {
  const { toast } = useToast();

  const { data: dataConfig, isLoading } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });

  const [mandatoryFields] = useState<string[]>(MANDATORY_LOAN_FIELDS);
  const [paymentAdditionalFields, setPaymentAdditionalFields] = useState<string[]>([]);
  const [customPaymentField, setCustomPaymentField] = useState("");
  const [optionalFields, setOptionalFields] = useState<string[]>([]);
  const [customField, setCustomField] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (dataConfig && !hydrated) {
      if (dataConfig.optionalFields && (dataConfig.optionalFields as string[]).length > 0) {
        setOptionalFields(dataConfig.optionalFields as string[]);
      }
      if (dataConfig.paymentAdditionalFields && (dataConfig.paymentAdditionalFields as string[]).length > 0) {
        setPaymentAdditionalFields(dataConfig.paymentAdditionalFields as string[]);
      }
      setHydrated(true);
    }
  }, [dataConfig, hydrated]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const method = dataConfig ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/data-config", {
        mandatoryFields,
        optionalFields,
        paymentAdditionalFields,
        dpdBuckets: [],
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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mandatory Loan Data</CardTitle>
            <CardDescription>These fields are required in every loan data upload.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {mandatoryFields.map((f) => (
                <Badge key={f} variant="default" className="text-xs py-1 px-2.5">
                  {f.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mandatory Payment History</CardTitle>
            <CardDescription>These fields are required in every payment history upload.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-4">
              {MANDATORY_PAYMENT_FIELDS.map((f) => (
                <Badge key={f} variant="default" className="text-xs py-1 px-2.5">
                  {f.replace(/_/g, " ")}
                </Badge>
              ))}
              {paymentAdditionalFields.map((f) => (
                <Badge key={f} variant="secondary" className="text-xs py-1 px-2.5">
                  {f.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={customPaymentField}
                onChange={(e) => setCustomPaymentField(e.target.value)}
                placeholder="Add additional field (e.g. payment method)"
                className="max-w-[280px]"
                data-testid="input-custom-payment-field"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (customPaymentField.trim()) {
                    setPaymentAdditionalFields((prev) => [...prev, customPaymentField.trim().replace(/\s+/g, "_")]);
                    setCustomPaymentField("");
                  }
                }}
                data-testid="button-add-payment-field"
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Optional Data Fields</CardTitle>
            <CardDescription>Select additional fields to improve accuracy.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {OPTIONAL_FIELDS.map((f) => (
                <label key={f} className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={optionalFields.includes(f)}
                    onCheckedChange={(checked) => {
                      setOptionalFields((prev) =>
                        checked ? [...prev, f] : prev.filter((x) => x !== f)
                      );
                    }}
                    data-testid={`checkbox-field-${f}`}
                  />
                  <span className="text-sm capitalize">
                    {f.replace(/_/g, " ")}
                    {f === "conversation_history" && (
                      <span className="text-xs text-muted-foreground normal-case ml-1">
                        ({MANDATORY_CONVERSATION_FIELDS.map(c => c.replace(/_/g, " ")).join(", ")})
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <div className="flex items-center gap-2 mt-3">
                <Input
                  value={customField}
                  onChange={(e) => setCustomField(e.target.value)}
                  placeholder="Add custom field"
                  className="max-w-[200px]"
                  data-testid="input-custom-field"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (customField.trim()) {
                      setOptionalFields((prev) => [...prev, customField.trim().replace(/\s+/g, "_")]);
                      setCustomField("");
                    }
                  }}
                  data-testid="button-add-field"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="pt-2 pb-8">
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-dataconfig">
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Configuration
          </Button>
        </div>
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
  const { data: config } = useQuery<ClientConfig>({ queryKey: ["/api/client-config"] });

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

      <Tabs defaultValue="company" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="company" data-testid="tab-company-details">
            <Building2 className="w-3.5 h-3.5 mr-1.5" />
            Company Details
          </TabsTrigger>
          <TabsTrigger value="policy" data-testid="tab-policy-config" disabled={!config}>
            <Shield className="w-3.5 h-3.5 mr-1.5" />
            Policy Config
          </TabsTrigger>
          <TabsTrigger value="data-config" data-testid="tab-data-config" disabled={!config}>
            <Database className="w-3.5 h-3.5 mr-1.5" />
            Data Configuration
          </TabsTrigger>
          <TabsTrigger value="prompt-config" data-testid="tab-prompt-config" disabled={!config}>
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
            Prompt Config
          </TabsTrigger>
        </TabsList>

        <TabsContent value="company">
          <CompanyDetailsTab />
        </TabsContent>

        <TabsContent value="policy">
          <PolicyConfigTab />
        </TabsContent>

        <TabsContent value="data-config">
          <DataConfigTab />
        </TabsContent>

        <TabsContent value="prompt-config">
          <PromptConfigTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
