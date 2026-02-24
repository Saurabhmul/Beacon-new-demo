import { useState, useEffect } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Database, Save, Loader2, Plus, Pencil, Trash2 } from "lucide-react";
import type { DataConfig, ClientConfig, DpdStage } from "@shared/schema";

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

export default function DataConfigPage() {
  const { toast } = useToast();

  const { data: config } = useQuery<ClientConfig>({ queryKey: ["/api/client-config"] });
  const { data: dataConfig, isLoading } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });
  const { data: dpdStages = [] } = useQuery<DpdStage[]>({ queryKey: ["/api/dpd-stages"] });

  const [mandatoryFields] = useState<string[]>(MANDATORY_FIELDS);
  const [optionalFields, setOptionalFields] = useState<string[]>([]);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT);
  const [outputFormat, setOutputFormat] = useState(DEFAULT_OUTPUT);
  const [customField, setCustomField] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (dataConfig && !hydrated) {
      if (dataConfig.optionalFields && (dataConfig.optionalFields as string[]).length > 0) {
        setOptionalFields(dataConfig.optionalFields as string[]);
      }
      if (dataConfig.promptTemplate) {
        setPromptTemplate(dataConfig.promptTemplate);
      }
      if (dataConfig.outputFormat) {
        setOutputFormat(dataConfig.outputFormat);
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
        dpdBuckets: [],
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

  if (!config) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
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
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-dataconfig-heading">
          Data Configuration
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure which data fields will be used for analysis and customize the AI prompt.
        </p>
      </div>

      <Tabs defaultValue="data-fields" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="data-fields" data-testid="tab-data-fields">Data Fields</TabsTrigger>
          <TabsTrigger value="prompt-config" data-testid="tab-prompt-config">Prompt Config</TabsTrigger>
        </TabsList>

        <TabsContent value="data-fields" className="space-y-6">
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
        </TabsContent>

        <TabsContent value="prompt-config" className="space-y-6">
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
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-prompt-config">
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Configuration
            </Button>
          </div>
        </TabsContent>
      </Tabs>

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
    </div>
  );
}
