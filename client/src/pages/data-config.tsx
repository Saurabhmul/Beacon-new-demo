import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Database, Save, Loader2, X, Plus } from "lucide-react";
import type { DataConfig, ClientConfig } from "@shared/schema";

const MANDATORY_FIELDS = [
  "customer_id",
  "account_id",
  "dpd_bucket",
  "outstanding_amount",
  "current_due_amount",
  "current_due_date",
];

const OPTIONAL_FIELDS = [
  "conversation_history",
  "contactability_signals",
  "income_attributes",
  "employment_attributes",
  "bureau_attributes",
  "arrangements_ptps",
  "payment_plans",
  "broken_promises",
  "compliance_policy",
  "knowledge_base",
];

const DPD_BUCKETS = ["B1 (1-30)", "B2 (31-60)", "B3 (61-90)", "B4 (91-120)", "B5 (121-150)", "B6 (151-180)", "B7 (180+)"];

const DEFAULT_PROMPT = `You are an AI decision engine for early delinquency management. Analyze the customer data provided against the SOP rules.

For each customer, provide:
1. Combined CMD value
2. Problem description (max 5 lines)
3. Problem confidence score (1-10)
4. Problem evidence with specific data citations
5. Proposed solution (max 5 lines)
6. Solution confidence score (1-10)
7. Solution evidence
8. Internal action recommendation
9. Ability to pay score
10. Reason for ability to pay assessment
11. Count of latest consecutive failed payments
12. Proposed email to customer (or NO_ACTION)

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

export default function DataConfigPage() {
  const { toast } = useToast();

  const { data: config } = useQuery<ClientConfig>({ queryKey: ["/api/client-config"] });
  const { data: dataConfig, isLoading } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });

  const [mandatoryFields, setMandatoryFields] = useState<string[]>(MANDATORY_FIELDS);
  const [optionalFields, setOptionalFields] = useState<string[]>([]);
  const [dpdBuckets, setDpdBuckets] = useState<string[]>(DPD_BUCKETS);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT);
  const [outputFormat, setOutputFormat] = useState(DEFAULT_OUTPUT);
  const [customField, setCustomField] = useState("");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const method = dataConfig ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/data-config", {
        mandatoryFields,
        optionalFields,
        dpdBuckets,
        promptTemplate,
        outputFormat,
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

  if (!config) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="p-8 text-center">
            <Database className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium mb-1">Setup Required</h3>
            <p className="text-sm text-muted-foreground">Please configure your client details first.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-serif font-bold tracking-tight" data-testid="text-dataconfig-heading">
          Data Configuration
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure which data fields will be used for analysis and customize the AI prompt.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mandatory Data Fields</CardTitle>
          <CardDescription>These fields are required in every upload for the pilot.</CardDescription>
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
                <span className="text-sm capitalize">{f.replace(/_/g, " ")}</span>
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
          <CardTitle className="text-base">DPD Bucket Configuration</CardTitle>
          <CardDescription>Configure which delinquency buckets to process.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {DPD_BUCKETS.map((b) => (
              <label key={b} className="flex items-center gap-3 cursor-pointer">
                <Checkbox
                  checked={dpdBuckets.includes(b)}
                  onCheckedChange={(checked) => {
                    setDpdBuckets((prev) =>
                      checked ? [...prev, b] : prev.filter((x) => x !== b)
                    );
                  }}
                  data-testid={`checkbox-dpd-${b}`}
                />
                <span className="text-sm">{b}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Prompt Template</CardTitle>
          <CardDescription>Customize the prompt sent to AI along with customer data and SOP rules.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
            className="min-h-[200px] text-sm font-mono"
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
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-dataconfig">
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
