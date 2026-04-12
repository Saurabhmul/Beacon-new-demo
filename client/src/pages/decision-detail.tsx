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

  const situationConfidence = asNumber(finalAiOutput?.["customer_situation_confidence_score"]);
  const requiresAgentReview = asBoolean(finalAiOutput?.["requires_agent_review"]);
  const usedFields = asStringArray(finalAiOutput?.["used_fields"]);
  const usedRules = asStringArray(finalAiOutput?.["used_rules"]);
  const missingInfo = asStringArray(finalAiOutput?.["missing_information"]);
  const keyFactors = asStringArray(finalAiOutput?.["key_factors_considered"]);
  const blockedConditions = asStringArray(finalAiOutput?.["blocked_conditions"]);
  const paymentSummary = asString(finalAiOutput?.["recent_payment_history_summary"]);
  const convSummary = asString(finalAiOutput?.["conversation_summary"]);

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

          <Separator />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Recommended Treatment</p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold" data-testid="text-recommended-treatment">{recommendedTreatment}</p>
                {recommendedCode && (
                  <Badge variant="outline" className="text-xs font-mono">{recommendedCode}</Badge>
                )}
              </div>
            </div>
            {situationConfidence !== undefined && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Situation Confidence</p>
                <p className="text-sm" data-testid="text-situation-confidence">{situationConfidence}/10</p>
              </div>
            )}
          </div>

          {customerSituation && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Customer Situation</p>
              <p className="text-sm leading-relaxed" data-testid="text-customer-situation">{customerSituation}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SECTION 2 — Source Data */}
      <Card data-testid="section-source-data">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="w-4 h-4" />
            Source Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(() => {
            const cards = [
              { title: "Loan Data", content: loanData, extra: undefined },
              { title: "Payment History", content: paymentData, extra: paymentSummary },
              { title: "Conversations", content: conversationData, extra: convSummary },
              { title: "Income & Employment", content: incomeEmploymentData, extra: undefined },
              { title: "Bureau", content: bureauData, extra: undefined },
            ].filter(c => isNonEmptyValue(c.content));

            if (cards.length === 0) {
              return <p className="text-sm text-muted-foreground" data-testid="text-no-source-data">No source data available</p>;
            }

            return cards.map(c => (
              <SourceDataCard key={c.title} title={c.title} content={c.content} extra={c.extra} />
            ));
          })()}
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
              defaultOpen={derivedFieldsTrace.length <= 5}
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
                          {String(df["field_id"] ?? "")}
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

          {/* Structured Assessments */}
          <div>
            <h3 className="text-sm font-semibold mb-3">Structured Assessments</h3>
            {structuredAssessments.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-assessments">No assessments available</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Assessment</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {structuredAssessments.map((a, i) => (
                    <TableRow key={i} data-testid={`row-assessment-${i}`}>
                      <TableCell className="text-sm font-medium">{a.name}</TableCell>
                      <TableCell className="text-sm">
                        {a.value !== null && a.value !== undefined ? a.value : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{a.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <Separator />

          {/* Decision Factors */}
          {(usedFields || usedRules || missingInfo || keyFactors) && (
            <div>
              <h3 className="text-sm font-semibold mb-3">Decision Factors</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {usedFields && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Fields Used</p>
                    <StringList items={usedFields} />
                  </div>
                )}
                {usedRules && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Rules Applied</p>
                    <StringList items={usedRules} />
                  </div>
                )}
                {missingInfo && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Missing Information</p>
                    <StringList items={missingInfo} />
                  </div>
                )}
                {keyFactors && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Key Factors</p>
                    <StringList items={keyFactors} />
                  </div>
                )}
              </div>
              <Separator className="mt-4" />
            </div>
          )}

          {/* Treatment Rationale */}
          {(treatmentExplanation || (blockedConditions && blockedConditions.length > 0)) && (
            <div>
              <h3 className="text-sm font-semibold mb-3">Treatment Rationale</h3>
              {treatmentExplanation && (
                <p className="text-sm leading-relaxed mb-2" data-testid="text-treatment-explanation">{treatmentExplanation}</p>
              )}
              {blockedConditions && blockedConditions.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Blocked Conditions</p>
                  <StringList items={blockedConditions} />
                </div>
              )}
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

          {/* Policy & Guidance Used */}
          {hasTrace && usedRules && usedRules.length > 0 && (
            <>
              <Separator />
              <CollapsibleSection title="Policy & Guidance Used" defaultOpen={false}>
                {(() => {
                  const matched: Array<{ title: string; text: string }> = [];

                  const matchItem = (item: unknown): { title: string; text: string } | null => {
                    if (!item || typeof item !== "object") return null;
                    const obj = item as Record<string, unknown>;
                    const id = String(obj.id || "");
                    const label = String(obj.label || obj.title || obj.name || "");
                    const text = String(obj.text || obj.content || obj.description || label);
                    if (!label) return null;
                    return { title: label, text };
                  };

                  const allPolicyItems = [
                    ...(complianceRules || []),
                    ...(kbGuidance || []),
                  ];

                  for (const rule of usedRules) {
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
                      return label === rule;
                    });
                    if (byLabel) {
                      const m = matchItem(byLabel);
                      if (m) matched.push(m);
                    }
                  }

                  if (matched.length === 0) {
                    return <p className="text-sm text-muted-foreground">No policy or guidance items were used</p>;
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
