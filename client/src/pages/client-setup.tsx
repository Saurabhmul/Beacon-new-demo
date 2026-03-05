import { useState, useEffect, useCallback } from "react";
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
  Building2, Mail, Phone, User, Save, Loader2,
  BookOpen, Upload, FileText, Trash2, Plus, File as FileIcon,
  Database, Pencil, MessageSquare, RotateCcw,
} from "lucide-react";
import type { ClientConfig, Rulebook, DataConfig, DpdStage } from "@shared/schema";

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

function ActionRulebookTab() {
  const { toast } = useToast();
  const [title, setTitle] = useState("Default Rulebook");
  const [sopText, setSopText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeTab, setActiveTab] = useState("text");

  const { data: rulebooks, isLoading } = useQuery<Rulebook[]>({
    queryKey: ["/api/rulebooks"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (activeTab === "upload" && selectedFile) {
        const formData = new FormData();
        formData.append("title", title);
        formData.append("file", selectedFile);
        const res = await fetch("/api/rulebooks/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        if (!res.ok) throw new Error("Upload failed");
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/rulebooks", { title, sopText });
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rulebooks"] });
      toast({ title: "Rulebook saved", description: "Your SOP has been stored successfully." });
      setTitle("Default Rulebook");
      setSopText("");
      setSelectedFile(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save rulebook.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/rulebooks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rulebooks"] });
      toast({ title: "Deleted", description: "Rulebook removed." });
    },
  });

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.type === "application/pdf" || file.type.startsWith("image/"))) {
      setSelectedFile(file);
    } else {
      toast({ title: "Invalid file", description: "Please upload a PDF or image file.", variant: "destructive" });
    }
  }, [toast]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add New Rulebook / SOP</CardTitle>
          <CardDescription>Enter rules as text or upload a PDF/image document. AI will extract and use these rules.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Early Delinquency Playbook v2"
              data-testid="input-rulebook-title"
            />
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="text" data-testid="tab-text">
                <FileText className="w-3.5 h-3.5 mr-1.5" />
                Free Text
              </TabsTrigger>
              <TabsTrigger value="upload" data-testid="tab-upload">
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Upload Document
              </TabsTrigger>
            </TabsList>

            <TabsContent value="text" className="mt-4">
              <Textarea
                value={sopText}
                onChange={(e) => setSopText(e.target.value)}
                placeholder="Enter your SOP rules here. For example:&#10;&#10;If customer CMD < 0.3 and mentions employment loss -> offer forbearance&#10;If DPD > 60 and no payment in 3 months -> escalate to legal&#10;If customer has made 2+ partial payments -> offer restructured plan"
                className="min-h-[200px] text-sm"
                data-testid="textarea-sop"
              />
            </TabsContent>

            <TabsContent value="upload" className="mt-4">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleFileDrop}
                className="border-2 border-dashed border-border rounded-md p-8 text-center transition-colors"
              >
                {selectedFile ? (
                  <div className="space-y-2">
                    <FileIcon className="w-8 h-8 text-primary mx-auto" />
                    <p className="text-sm font-medium">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                    <Button variant="outline" size="sm" onClick={() => setSelectedFile(null)} data-testid="button-remove-file">
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Upload className="w-8 h-8 text-muted-foreground mx-auto" />
                    <p className="text-sm text-muted-foreground">Drag & drop a PDF or image here</p>
                    <label>
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) setSelectedFile(file);
                        }}
                        data-testid="input-file-upload"
                      />
                      <Button variant="outline" size="sm" asChild>
                        <span>Browse Files</span>
                      </Button>
                    </label>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>

          <div className="pt-2">
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || (!sopText && !selectedFile)}
              data-testid="button-save-rulebook"
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Rulebook
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-3">Existing Rulebooks</h2>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : rulebooks && rulebooks.length > 0 ? (
          <div className="space-y-3">
            {rulebooks.map((rb) => (
              <Card key={rb.id} className="hover-elevate">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm" data-testid={`text-rulebook-title-${rb.id}`}>{rb.title}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {rb.sopFileUrl ? "Document" : "Text"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {rb.sopText ? rb.sopText.substring(0, 150) + "..." : rb.sopFileName || "Uploaded document"}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Created {new Date(rb.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => deleteMutation.mutate(rb.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-rulebook-${rb.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <BookOpen className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No rulebooks configured yet. Add your first SOP above.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function DataConfigTab() {
  const { toast } = useToast();

  const { data: dataConfig, isLoading } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });
  const { data: dpdStages = [] } = useQuery<DpdStage[]>({ queryKey: ["/api/dpd-stages"] });

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

  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<DpdStage | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageDesc, setStageDesc] = useState("");
  const [stageFrom, setStageFrom] = useState("");
  const [stageTo, setStageTo] = useState("");
  const [stageColor, setStageColor] = useState("blue");

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <>
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

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">DPD Configuration</CardTitle>
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
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => openEditStageDialog(stage)}
                              data-testid={`button-edit-stage-${stage.id}`}
                            >
                              <Pencil className="w-3.5 h-3.5 text-primary" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => deleteStageMutation.mutate(stage.id)}
                              data-testid={`button-delete-stage-${stage.id}`}
                            >
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

          <div className="pt-2 pb-8">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-dataconfig">
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Configuration
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
              <Input
                value={stageName}
                onChange={(e) => setStageName(e.target.value)}
                placeholder="e.g. Pre Due, Grace, Early"
                data-testid="input-stage-name"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Description</label>
              <Input
                value={stageDesc}
                onChange={(e) => setStageDesc(e.target.value)}
                placeholder="e.g. Accounts approaching due date"
                data-testid="input-stage-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1.5 block">From (days)</label>
                <Input
                  type="number"
                  value={stageFrom}
                  onChange={(e) => setStageFrom(e.target.value)}
                  placeholder="-5"
                  data-testid="input-stage-from"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">To (days)</label>
                <Input
                  type="number"
                  value={stageTo}
                  onChange={(e) => setStageTo(e.target.value)}
                  placeholder="0"
                  data-testid="input-stage-to"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Color</label>
              <div className="flex gap-2 flex-wrap">
                {STAGE_COLORS.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className={`w-8 h-8 rounded-full ${c.dot} ${stageColor === c.name ? "ring-2 ring-offset-2 ring-primary" : ""}`}
                    onClick={() => setStageColor(c.name)}
                    data-testid={`button-color-${c.name}`}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeStageDialog}>Cancel</Button>
            <Button
              onClick={handleSaveStage}
              disabled={createStageMutation.isPending || updateStageMutation.isPending}
              data-testid="button-save-stage"
            >
              {(createStageMutation.isPending || updateStageMutation.isPending) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {editingStage ? "Update Stage" : "Add Stage"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PromptConfigTab() {
  const { toast } = useToast();

  const { data: dataConfig } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });

  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT);
  const [outputFormat, setOutputFormat] = useState(DEFAULT_OUTPUT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (dataConfig && !hydrated) {
      if (dataConfig.promptTemplate) {
        setPromptTemplate(dataConfig.promptTemplate);
      }
      if (dataConfig.outputFormat) {
        setOutputFormat(dataConfig.outputFormat);
      }
      setHydrated(true);
    }
  }, [dataConfig, hydrated]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const method = dataConfig ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/data-config", {
        promptTemplate,
        outputFormat,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data-config"] });
      toast({ title: "Prompt configuration saved" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save.", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">AI Prompt Template</CardTitle>
            <CardDescription>Customize the prompt sent to AI along with customer data and SOP rules.</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromptTemplate(DEFAULT_PROMPT)}
            data-testid="button-reset-prompt"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            Reset to Default
          </Button>
        </CardHeader>
        <CardContent>
          <Textarea
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
            className="min-h-[500px] text-sm font-mono leading-relaxed whitespace-pre-wrap"
            data-testid="textarea-prompt"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expected Output Format</CardTitle>
          <CardDescription>Define the JSON structure expected from AI responses.</CardDescription>
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
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-prompt-config">
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Configuration
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
          <TabsTrigger value="rulebook" data-testid="tab-action-rulebook" disabled={!config}>
            <BookOpen className="w-3.5 h-3.5 mr-1.5" />
            Action Rulebook
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

        <TabsContent value="rulebook">
          <ActionRulebookTab />
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
