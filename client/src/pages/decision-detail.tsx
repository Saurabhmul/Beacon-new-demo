import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Mail,
  Brain,
  Database,
} from "lucide-react";
import type { Decision } from "@shared/schema";

const LEGACY_FALLBACK_MSG = "This decision was generated before v2.1 detail tracing was available.";

function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getCustomerId(decision: Decision): string {
  const cdata = decision.customerData as Record<string, unknown> | null | undefined;
  return decision.customerGuid || String(cdata?.["customer_guid"] ?? cdata?.["legacy_id"] ?? "Unknown");
}

function getRecommendedTreatment(decision: Decision): string {
  return decision.recommendedTreatmentName || decision.proposedSolution || "Unknown";
}

function statusBadgeVariant(status: string) {
  if (status === "approved") return "default" as const;
  if (status === "rejected") return "destructive" as const;
  if (status === "needs_review") return "secondary" as const;
  return "outline" as const;
}

function statusLabel(status: string): string {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "needs_review") return "Needs Review";
  return "Pending Review";
}

function isNonEmptyValue(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === "string") return val.length > 0;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === "object") return Object.keys(val as object).length > 0;
  return true;
}

function CollapsibleSection({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-muted/30 transition-colors"
        data-testid={`section-toggle-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="font-medium text-sm">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function StringList({ items, emptyText = "None" }: { items: unknown; emptyText?: string }) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return <span className="text-sm text-muted-foreground">{emptyText}</span>;
  return (
    <ul className="list-disc list-inside space-y-1">
      {arr.map((item, i) => (
        <li key={i} className="text-sm">{String(item)}</li>
      ))}
    </ul>
  );
}

function SourceDataCard({ title, content, extra }: { title: string; content: unknown; extra?: string }) {
  if (!isNonEmptyValue(content)) return null;

  let rows: Array<[string, string]> = [];

  if (Array.isArray(content)) {
    return (
      <Card className="overflow-hidden">
        <CardHeader className="py-3 px-4 bg-muted/30">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {extra && <p className="text-sm px-4 pt-3 pb-1 text-muted-foreground italic">{extra}</p>}
          <div className="overflow-x-auto max-h-56 overflow-y-auto">
            <Table>
              <TableBody>
                {(content as Record<string, unknown>[]).slice(0, 20).map((row, i) => (
                  Object.entries(row).map(([k, v]) => (
                    <TableRow key={`${i}-${k}`}>
                      <TableCell className="text-xs font-medium text-muted-foreground w-40">{k}</TableCell>
                      <TableCell className="text-xs">{String(v ?? "")}</TableCell>
                    </TableRow>
                  ))
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (typeof content === "object" && content !== null) {
    rows = Object.entries(content as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && String(v).length > 0)
      .map(([k, v]) => [k, String(v)]);
  }

  if (rows.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-3 px-4 bg-muted/30">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {extra && <p className="text-sm px-4 pt-3 pb-1 text-muted-foreground italic">{extra}</p>}
        <Table>
          <TableBody>
            {rows.map(([k, v]) => (
              <TableRow key={k}>
                <TableCell className="text-xs font-medium text-muted-foreground w-40">{k}</TableCell>
                <TableCell className="text-xs">{v}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function DecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";

  const [agentReason, setAgentReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);

  const { data: decision, isLoading } = useQuery<Decision>({
    queryKey: ["/api/decisions", params.id],
  });

  const reviewMutation = useMutation({
    mutationFn: async (data: { agentAgreed: boolean; agentReason?: string }) => {
      const res = await apiRequest("PATCH", `/api/decisions/${params.id}/review`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", params.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions/stats"] });
      toast({ title: "Decision reviewed", description: "Your review has been recorded." });
      setLocation("/review");
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to submit review.", variant: "destructive" });
    },
  });

  const emailMutation = useMutation({
    mutationFn: async (data: { emailAccepted: boolean; emailRejectReason?: string }) => {
      const res = await apiRequest("PATCH", `/api/decisions/${params.id}/email-review`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", params.id] });
      toast({ title: "Email review saved" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save email review.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!decision) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground" data-testid="text-not-found">Decision not found.</p>
      </div>
    );
  }

  const traceJson = decision.decisionTraceJson ?? null;
  const hasTrace = Boolean(traceJson);
  const trace: Record<string, unknown> | null = traceJson && typeof traceJson === "object" ? traceJson as Record<string, unknown> : null;

  function asRecord(val: unknown): Record<string, unknown> | undefined {
    if (val && typeof val === "object" && !Array.isArray(val)) return val as Record<string, unknown>;
    return undefined;
  }
  function asArray(val: unknown): unknown[] {
    return Array.isArray(val) ? val : [];
  }
  function asString(val: unknown): string | undefined {
    return typeof val === "string" ? val : undefined;
  }
  function asNumber(val: unknown): number | undefined {
    return typeof val === "number" ? val : undefined;
  }
  function asBoolean(val: unknown): boolean | undefined {
    return typeof val === "boolean" ? val : undefined;
  }
  function asStringArray(val: unknown): string[] | undefined {
    if (!Array.isArray(val)) return undefined;
    return val.filter((v): v is string => typeof v === "string");
  }

  const packet = asRecord(trace?.["decision_packet"]);
  const packetCustomer = asRecord(packet?.["customer"]);
  const groupedSourceData = asRecord(packetCustomer?.["groupedSourceData"]);
  const businessFieldsTrace = asArray(trace?.["business_fields_trace"]);
  const derivedFieldsTrace = asArray(trace?.["derived_fields_trace"]);
  const finalAiOutput = asRecord(trace?.["final_ai_output"]);

  const customerData = asRecord(decision.customerData) ?? {};
  const customerId = getCustomerId(decision);
  const recommendedTreatment = decision.recommendedTreatmentName || decision.proposedSolution || "Unknown";
  const recommendedCode = decision.recommendedTreatmentCode || "";
  const customerSituation = decision.customerSituation || decision.problemDescription || "";
  const treatmentExplanation = decision.treatmentEligibilityExplanation || decision.solutionEvidence || "";
  const structuredAssessments = decision.structuredAssessments || [];
  const proposedEmail = decision.proposedEmailToCustomer || "NO_ACTION";
  const internalAction = decision.internalAction || "";

  const requiresAgentReview = asBoolean(finalAiOutput?.["requires_agent_review"]);
  const treatmentDecision = asRecord(finalAiOutput?.["treatment_decision"]);
  const decisionFactors = asRecord(finalAiOutput?.["decision_factors"]);
  const rulesApplied = asStringArray(decisionFactors?.["rules_applied"]);
  const treatmentRationale = asString(treatmentDecision?.["treatment_rationale"]);
  const decisionStatus = asString(treatmentDecision?.["decision_status"]);
  const internalActionRationale = asString(finalAiOutput?.["internal_action_rationale"]);

  const loanData = groupedSourceData?.["loanData"] ?? customerData;
  const paymentData = asArray(groupedSourceData?.["paymentData"] ?? customerData["_payments"]);
  const conversationData = asArray(groupedSourceData?.["conversationData"] ?? customerData["_conversations"]);
  const bureauData = asRecord(groupedSourceData?.["bureauData"]) ?? {};
  const incomeEmploymentData = asRecord(groupedSourceData?.["incomeEmploymentData"]) ?? {};

  const complianceRules = asArray(asRecord(packet?.["policy"])?.["compliancePolicyInternalRules"]);
  const kbGuidance = asArray(asRecord(packet?.["guidance"])?.["knowledgeBaseAgentGuidance"]);

  const isPending = decision.status === "pending";

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <Button
        variant="ghost"
        onClick={() => setLocation("/review")}
        className="gap-2"
        data-testid="button-back-to-queue"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Queue
      </Button>

      {/* SECTION 1 — Top Summary */}
      <Card data-testid="section-top-summary">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="w-4 h-4" />
            Decision Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Customer ID</p>
              <p className="text-sm font-mono break-all" data-testid="text-customer-guid">{customerId}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Status</p>
              <Badge variant={statusBadgeVariant(decision.status)} data-testid="badge-status">
                {statusLabel(decision.status)}
              </Badge>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Last AI Run Date</p>
              <p className="text-sm text-muted-foreground" data-testid="text-run-date">{formatDate(decision.createdAt)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Requires Agent Review</p>
              {requiresAgentReview !== undefined ? (
                <Badge variant={requiresAgentReview ? "destructive" : "default"} data-testid="badge-agent-review">
                  {requiresAgentReview ? "Yes" : "No"}
                </Badge>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>

          {customerSituation && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Customer Situation</p>
              <p className="text-sm leading-relaxed" data-testid="text-customer-situation">{customerSituation}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SECTION 3 — Business Fields */}
      <Card data-testid="section-business-fields">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Business Fields</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasTrace ? (
            <p className="text-sm text-muted-foreground italic">{LEGACY_FALLBACK_MSG}</p>
          ) : businessFieldsTrace.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-business-fields">No business fields available</p>
          ) : (
            <CollapsibleSection
              title={`Business Fields (${businessFieldsTrace.length})`}
              defaultOpen={businessFieldsTrace.length <= 5}
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field Label</TableHead>
                      <TableHead>Inferred Value</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Rationale</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {businessFieldsTrace.map((bfRaw, i) => {
                      const bf = bfRaw as Record<string, unknown>;
                      return (
                      <TableRow key={i} data-testid={`row-business-field-${i}`}>
                        <TableCell className="text-sm font-medium">{String(bf["field_label"] ?? "")}</TableCell>
                        <TableCell className="text-sm">
                          {bf["value"] !== null && bf["value"] !== undefined ? String(bf["value"]) : (
                            <span className="text-muted-foreground text-xs">{String(bf["null_reason"] ?? "null")}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {typeof bf["confidence"] === "number"
                            ? `${(bf["confidence"] * 100).toFixed(0)}%`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-xs">{String(bf["rationale"] ?? "—") || "—"}</TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleSection>
          )}
        </CardContent>
      </Card>

      {/* SECTION 4 — Derived Fields */}
      <Card data-testid="section-derived-fields">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Derived Fields</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasTrace ? (
            <p className="text-sm text-muted-foreground italic">{LEGACY_FALLBACK_MSG}</p>
          ) : derivedFieldsTrace.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-derived-fields">No derived fields available</p>
          ) : (
            <CollapsibleSection
              title={`Derived Fields (${derivedFieldsTrace.length})`}
              defaultOpen={false}
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field Label</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Formula</TableHead>
                      <TableHead>Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {derivedFieldsTrace.map((dfRaw, i) => {
                      const df = dfRaw as Record<string, unknown>;
                      return (
                      <TableRow key={i} data-testid={`row-derived-field-${i}`}>
                        <TableCell className="text-sm font-medium">
                          {String(df["field_label"] ?? df["field_id"] ?? "")}
                          {df["typeMismatchWarning"] === true && (
                            <Badge variant="outline" className="ml-2 text-xs text-yellow-600 border-yellow-400">
                              Type mismatch risk
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {df["output_value"] !== null && df["output_value"] !== undefined
                            ? String(df["output_value"])
                            : <span className="text-muted-foreground text-xs">{String(df["nullReason"] ?? "null")}</span>}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-xs truncate">{String(df["formula"] ?? "—") || "—"}</TableCell>
                        <TableCell className="text-xs">{String(df["output_type"] ?? "")}</TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleSection>
          )}
        </CardContent>
      </Card>

      {/* SECTION 5 — Treatment Decision / Validation / Email */}
      <Card data-testid="section-treatment-decision">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Treatment Decision</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">

          {/* Recommended Treatment — prominent, moved from top summary */}
          <div data-testid="text-recommended-treatment-prominent">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Recommended Treatment</p>
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-xl font-bold" data-testid="text-recommended-treatment">{recommendedTreatment}</p>
              {recommendedCode && (
                <Badge variant="outline" className="text-xs font-mono">{recommendedCode}</Badge>
              )}
              {decisionStatus && (
                <Badge
                  variant={decisionStatus === "AGENT_REVIEW" ? "destructive" : "secondary"}
                  className="text-xs"
                  data-testid="badge-decision-status"
                >
                  {decisionStatus}
                </Badge>
              )}
            </div>
          </div>

          <Separator />

          {/* Treatment Rationale — prefer new nested treatmentRationale, fall back to DB column */}
          {(treatmentRationale || treatmentExplanation) && (
            <div>
              <h3 className="text-sm font-semibold mb-3">Treatment Rationale</h3>
              <p className="text-sm leading-relaxed mb-2" data-testid="text-treatment-explanation">
                {treatmentRationale || treatmentExplanation}
              </p>
              <Separator className="mt-4" />
            </div>
          )}

          {/* Internal Action */}
          {internalAction && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Internal Action</h3>
              <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-internal-action">{internalAction}</p>
              <Separator className="mt-4" />
            </div>
          )}

          {/* Internal Action Rationale — separate block */}
          {internalActionRationale && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Internal Action Rationale</h3>
              <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-internal-action-rationale">{internalActionRationale}</p>
              <Separator className="mt-4" />
            </div>
          )}

          {/* Email Draft */}
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Email Draft
            </h3>
            {!proposedEmail || proposedEmail === "NO_ACTION" ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-email">No email draft generated</p>
            ) : (
              <div className="space-y-3">
                <div className="bg-muted/40 rounded p-3">
                  <p className="text-sm whitespace-pre-line leading-relaxed" data-testid="text-email-draft">{proposedEmail}</p>
                </div>
                {!isSuperAdmin && decision.emailAccepted === null && !decision.reviewedAt && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => emailMutation.mutate({ emailAccepted: true })}
                      disabled={emailMutation.isPending}
                      data-testid="button-accept-email"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Accept Email
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => emailMutation.mutate({ emailAccepted: false })}
                      disabled={emailMutation.isPending}
                      data-testid="button-reject-email"
                    >
                      <XCircle className="w-3.5 h-3.5 mr-1" /> Reject Email
                    </Button>
                  </div>
                )}
                {decision.emailAccepted !== null && decision.emailAccepted !== undefined && (
                  <Badge variant={decision.emailAccepted ? "default" : "destructive"} data-testid="badge-email-decision">
                    {decision.emailAccepted ? "Email Accepted" : "Email Rejected"}
                  </Badge>
                )}
              </div>
            )}
          </div>

          {/* Policy & Guidance Used — match against rulesApplied (new schema) or fall back gracefully */}
          {hasTrace && rulesApplied && rulesApplied.length > 0 && (
            <>
              <Separator />
              <CollapsibleSection title="Policy & Guidance Used" defaultOpen={false}>
                {(() => {
                  const matched: Array<{ title: string; text: string }> = [];

                  const matchItem = (item: unknown): { title: string; text: string } | null => {
                    if (!item || typeof item !== "object") return null;
                    const obj = item as Record<string, unknown>;
                    const label = String(obj.label || obj.title || obj.name || "");
                    const text = String(obj.text || obj.content || obj.description || label);
                    if (!label) return null;
                    return { title: label, text };
                  };

                  const allPolicyItems = [
                    ...(complianceRules || []),
                    ...(kbGuidance || []),
                  ];

                  for (const rule of rulesApplied) {
                    const byId = allPolicyItems.find(item => {
                      if (!item || typeof item !== "object") return false;
                      const obj = item as Record<string, unknown>;
                      return String(obj["id"] ?? "") === rule;
                    });
                    if (byId) {
                      const m = matchItem(byId);
                      if (m) { matched.push(m); continue; }
                    }
                    const byLabel = allPolicyItems.find(item => {
                      if (!item || typeof item !== "object") return false;
                      const obj = item as Record<string, unknown>;
                      const label = String(obj.label || obj.title || obj.name || "");
                      return label === rule || label.toLowerCase() === rule.toLowerCase();
                    });
                    if (byLabel) {
                      const m = matchItem(byLabel);
                      if (m) matched.push(m);
                    }
                  }

                  if (matched.length === 0) {
                    return (
                      <div className="space-y-1">
                        {rulesApplied.map((rule, i) => (
                          <div key={i} className="border rounded p-3">
                            <p className="text-xs text-muted-foreground">{rule}</p>
                          </div>
                        ))}
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      {matched.map((item, i) => (
                        <div key={i} className="border rounded p-3">
                          <p className="text-xs font-medium mb-1">{item.title}</p>
                          <p className="text-xs text-muted-foreground">{item.text}</p>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </CollapsibleSection>
            </>
          )}

          <Separator />

          {/* Agent Review Form */}
          {!isSuperAdmin && isPending && (
            <div data-testid="section-agent-review">
              <h3 className="text-sm font-semibold mb-3">Agent Review</h3>
              <div className="space-y-3">
                {!showRejectForm ? (
                  <div className="flex gap-3">
                    <Button
                      onClick={() => reviewMutation.mutate({ agentAgreed: true })}
                      disabled={reviewMutation.isPending}
                      data-testid="button-approve"
                    >
                      {reviewMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                      )}
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setShowRejectForm(true)}
                      disabled={reviewMutation.isPending}
                      data-testid="button-show-reject"
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Textarea
                      placeholder="Reason for rejection (optional)"
                      value={agentReason}
                      onChange={(e) => setAgentReason(e.target.value)}
                      rows={3}
                      data-testid="textarea-reject-reason"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        onClick={() => reviewMutation.mutate({ agentAgreed: false, agentReason })}
                        disabled={reviewMutation.isPending}
                        data-testid="button-confirm-reject"
                      >
                        {reviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Confirm Rejection
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { setShowRejectForm(false); setAgentReason(""); }}
                        disabled={reviewMutation.isPending}
                        data-testid="button-cancel-reject"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!isPending && (
            <div className="flex items-center gap-2 py-2">
              {decision.agentAgreed ? (
                <><CheckCircle2 className="w-4 h-4 text-green-600" /><span className="text-sm font-medium text-green-700">Approved</span></>
              ) : (
                <><XCircle className="w-4 h-4 text-destructive" /><span className="text-sm font-medium text-destructive">Rejected</span></>
              )}
              {decision.agentReason && (
                <span className="text-sm text-muted-foreground ml-2">— {decision.agentReason}</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
