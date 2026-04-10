import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAnalysis } from "@/hooks/use-analysis";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ClipboardList,
  ArrowRight,
  Search,
  Play,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Building2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ShieldAlert,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { Decision } from "@shared/schema";

type TabType = "pending" | "completed";
type ValidationFilter = "all" | "passed" | "warnings" | "failed" | "system_hold";
type ReviewFilter = "all" | "needs_review";

const PAGE_SIZE = 25;

// ── V2 data helpers ────────────────────────────────────────────────────────────

// Patterns in runFallbackReason that indicate a system hold (not an agent-review choice)
const SYSTEM_HOLD_PATTERNS = [
  "policy completeness",
  "business field",
  "critical information",
  "hard guardrail",
  "unexpected pipeline",
  "timed out",
  "required tier",
  "cap reached",
  "stage budget exhausted",
];

function extractCustomerName(d: Decision): string | null {
  const data = ((d.customerData || {}) as Record<string, unknown>);
  const NAME_KEYS = [
    "customer name", "customer_name", "name", "full name", "full_name",
    "first name", "first_name", "client name", "client_name",
    "borrower name", "borrower_name", "account name", "account_name",
  ];
  for (const key of NAME_KEYS) {
    for (const [k, v] of Object.entries(data)) {
      if (k.toLowerCase().trim() === key && v != null && String(v).trim()) {
        return String(v).trim();
      }
    }
  }
  return null;
}

function getV2Data(d: Decision) {
  const raw = ((d.aiRawOutput || {}) as Record<string, unknown>);
  const engineVersion = raw.engineVersion as string | undefined;
  const isV2 = typeof engineVersion === "string" && engineVersion.startsWith("decision-layer-v2");
  const finalAI = ((raw.finalAIOutput || {}) as Record<string, unknown>);
  const validation = ((raw.validation || {}) as Record<string, unknown>);
  const decisionPacket = ((raw.decisionPacket || {}) as Record<string, unknown>);
  const trace = ((raw.treatmentSelectionTrace || []) as Array<Record<string, unknown>>);

  return {
    isV2,
    engineVersion,
    // v2 payload internal_action (authoritative for v2 system hold)
    v2InternalAction: (finalAI.internal_action as string) || null,
    recommendedTreatmentCode: (finalAI.recommended_treatment_code as string) || null,
    recommendedTreatmentName: (finalAI.recommended_treatment_name as string) || null,
    treatmentRationale: (finalAI.treatment_eligibility_explanation as string) || null,
    confidenceScore: (finalAI.proposed_next_best_confidence_score as number) ?? null,
    requiresAgentReview: !!(finalAI.requires_agent_review),
    validationStatus: (validation.status as string) || null,
    validationFailureType: (validation.failureType as string) || null,
    warnings: ((validation.warnings || []) as Array<Record<string, unknown>>),
    blockingIssues: ((validation.blockingIssues || []) as Array<Record<string, unknown>>),
    preferredTreatments: ((decisionPacket.preferredTreatments || []) as Array<Record<string, unknown>>),
    runFallbackReason: (raw.runFallbackReason as string) || null,
    trace,
  };
}

function isSystemHold(d: Decision, v2: ReturnType<typeof getV2Data>): boolean {
  // Check DB-persisted internalAction column (covers all versions)
  if (d.internalAction?.startsWith("SYSTEM_HOLD:")) return true;
  // For v2 decisions check the authoritative payload field
  if (v2.isV2 && v2.v2InternalAction?.startsWith("SYSTEM_HOLD:")) return true;
  // DB status set to failed_validation = system decided not to proceed
  if (d.status === "failed_validation") return true;
  // runFallbackReason patterns (from orchestrator spec)
  if (v2.runFallbackReason) {
    const r = v2.runFallbackReason.toLowerCase();
    if (SYSTEM_HOLD_PATTERNS.some((p) => r.includes(p))) return true;
  }
  return false;
}

function hasPriorityDeviation(v2: ReturnType<typeof getV2Data>): boolean {
  if (!v2.isV2 || !v2.recommendedTreatmentCode) return false;
  if (v2.recommendedTreatmentCode === "AGENT_REVIEW") return false;
  if (!v2.preferredTreatments || v2.preferredTreatments.length === 0) return false;
  const topCode = (v2.preferredTreatments[0].code as string) || null;
  if (!topCode) return false;
  return topCode !== v2.recommendedTreatmentCode;
}

// Normalise validation state across v2 payload and legacy DB status field
function resolveValidationState(d: Decision, v2: ReturnType<typeof getV2Data>) {
  const failed =
    v2.validationStatus === "failed" ||
    d.status === "failed_validation";
  const hasWarnings = v2.warnings.length > 0;
  const passed = !failed && (v2.validationStatus === "passed" || (v2.isV2 && !hasWarnings));
  return { failed, hasWarnings, passed };
}

function validationBadgeInfo(d: Decision, v2: ReturnType<typeof getV2Data>) {
  if (isSystemHold(d, v2)) {
    return { label: "System hold", variant: "destructive" as const, icon: ShieldAlert };
  }
  if (!v2.isV2 && d.status !== "failed_validation") {
    // Legacy decision without v2 payload — no badge
    return null;
  }
  const { failed, hasWarnings, passed } = resolveValidationState(d, v2);
  if (failed) {
    return { label: "Failed", variant: "destructive" as const, icon: XCircle };
  }
  if (hasWarnings) {
    return { label: "Warnings", variant: "secondary" as const, icon: AlertTriangle };
  }
  if (passed) {
    return { label: "Passed", variant: "default" as const, icon: CheckCircle2 };
  }
  return null;
}

function getFilterCategory(d: Decision, v2: ReturnType<typeof getV2Data>): ValidationFilter {
  if (isSystemHold(d, v2)) return "system_hold";
  if (!v2.isV2 && d.status !== "failed_validation") return "passed"; // legacy: skip filter
  const { failed, hasWarnings } = resolveValidationState(d, v2);
  if (failed) return "failed";
  if (hasWarnings) return "warnings";
  return "passed";
}

export default function ReviewQueuePage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";
  const noCompanySelected = isSuperAdmin && !user?.viewingCompanyId;

  const [activeTab, setActiveTab] = useState<TabType>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [validationFilter, setValidationFilter] = useState<ValidationFilter>("all");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [treatmentFilter, setTreatmentFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  const { analyzing, progress, startAnalysis } = useAnalysis();

  const { data: pendingData, isLoading: pendingLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions", "pending"],
    enabled: !noCompanySelected,
  });

  const { data: allData, isLoading: allLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions", "all"],
    enabled: !noCompanySelected,
  });

  const pendingDecisions = pendingData?.filter((d) => d.status === "pending") || [];
  const completedDecisions = allData?.filter((d) => d.status !== "pending") || [];

  const isLoading = activeTab === "pending" ? pendingLoading : allLoading;
  const currentDecisions = activeTab === "pending" ? pendingDecisions : completedDecisions;

  const filteredDecisions = currentDecisions.filter((d) => {
    const v2 = getV2Data(d);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchesId = d.customerGuid.toLowerCase().includes(q);
      const matchesSolution = d.proposedSolution?.toLowerCase().includes(q);
      const matchesTreatment =
        v2.recommendedTreatmentName?.toLowerCase().includes(q) ||
        v2.recommendedTreatmentCode?.toLowerCase().includes(q);
      if (!matchesId && !matchesSolution && !matchesTreatment) return false;
    }
    if (validationFilter !== "all") {
      const cat = getFilterCategory(d, v2);
      if (cat !== validationFilter) return false;
    }
    if (reviewFilter === "needs_review") {
      // System holds are NOT the same as requires-agent-review;
      // show only rows explicitly flagged by the model for human review.
      if (!v2.requiresAgentReview) return false;
    }
    if (treatmentFilter) {
      const tf = treatmentFilter.toLowerCase();
      const matchesCode = v2.recommendedTreatmentCode?.toLowerCase().includes(tf);
      const matchesName = v2.recommendedTreatmentName?.toLowerCase().includes(tf);
      const matchesSolution = d.proposedSolution?.toLowerCase().includes(tf);
      if (!matchesCode && !matchesName && !matchesSolution) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredDecisions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * PAGE_SIZE;
  const pageDecisions = filteredDecisions.slice(startIdx, startIdx + PAGE_SIZE);

  const pageIds = pageDecisions.map((d) => d.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const deleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      setDeleting(true);
      await apiRequest("DELETE", "/api/decisions/bulk", { ids });
    },
    onSuccess: () => {
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions/stats"] });
      toast({ title: "Deleted", description: "Selected decisions have been deleted." });
    },
    onError: () => {
      toast({ title: "Delete failed", description: "Something went wrong.", variant: "destructive" });
    },
    onSettled: () => setDeleting(false),
  });

  const handleBulkDelete = () => {
    const count = selectedIds.size;
    if (count === 0) return;
    if (!window.confirm(`Are you sure you want to delete ${count} selected decision${count > 1 ? "s" : ""}? This cannot be undone.`)) return;
    deleteMutation.mutate(Array.from(selectedIds));
  };

  const resetFilters = () => {
    setSearchQuery("");
    setValidationFilter("all");
    setReviewFilter("all");
    setTreatmentFilter("");
    setPage(1);
    clearSelection();
  };

  if (noCompanySelected) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Select a Company</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Please select a company from the dropdown in the sidebar to view the review queue.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-review-heading">
            Review Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Validate Beacon's recommendations before execution.
          </p>
        </div>
        {!isSuperAdmin && (
          <Button onClick={startAnalysis} disabled={analyzing} data-testid="button-start-analyzing">
            {analyzing ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing...</>
            ) : (
              <><Play className="w-4 h-4 mr-2" /> Start Analyzing</>
            )}
          </Button>
        )}
      </div>

      {analyzing && progress && (
        <Card data-testid="card-analysis-progress">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Analyzing customer {progress.completed + progress.failed} of {progress.total}...
              </span>
              <span className="font-medium">
                {Math.round(((progress.completed + progress.failed) / progress.total) * 100)}%
              </span>
            </div>
            <Progress value={((progress.completed + progress.failed) / progress.total) * 100} />
            {progress.failed > 0 && (
              <p className="text-xs text-destructive">{progress.failed} failed</p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => { setActiveTab("pending"); setPage(1); clearSelection(); }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === "pending"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-pending-review"
        >
          Pending Review
        </button>
        <button
          type="button"
          onClick={() => { setActiveTab("completed"); setPage(1); clearSelection(); }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === "completed"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-completed"
        >
          Completed
        </button>
      </div>

      <Card>
        <CardContent className="p-4 pb-0">
          {/* ── Filter bar ────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="filter-bar">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by ID or treatment..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); clearSelection(); }}
                className="pl-9"
                data-testid="input-search-decisions"
              />
            </div>
            <Select
              value={validationFilter}
              onValueChange={(v) => { setValidationFilter(v as ValidationFilter); setPage(1); clearSelection(); }}
              data-testid="select-validation-filter"
            >
              <SelectTrigger className="w-[150px]" data-testid="trigger-validation-filter">
                <SelectValue placeholder="Validation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="passed">Passed</SelectItem>
                <SelectItem value="warnings">Warnings</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="system_hold">System hold</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={reviewFilter}
              onValueChange={(v) => { setReviewFilter(v as ReviewFilter); setPage(1); clearSelection(); }}
              data-testid="select-review-filter"
            >
              <SelectTrigger className="w-[150px]" data-testid="trigger-review-filter">
                <SelectValue placeholder="Review flag" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All decisions</SelectItem>
                <SelectItem value="needs_review">Needs review only</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Filter by treatment..."
              value={treatmentFilter}
              onChange={(e) => { setTreatmentFilter(e.target.value); setPage(1); clearSelection(); }}
              className="w-[160px]"
              data-testid="input-treatment-filter"
            />
            {(searchQuery || validationFilter !== "all" || reviewFilter !== "all" || treatmentFilter) && (
              <Button variant="ghost" size="sm" onClick={resetFilters} data-testid="button-clear-filters">
                Clear filters
              </Button>
            )}
            {selectedIds.size > 0 && !isSuperAdmin && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={deleting}
                data-testid="button-bulk-delete"
              >
                {deleting ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Deleting...</>
                ) : (
                  <><Trash2 className="w-4 h-4 mr-1" /> Delete ({selectedIds.size})</>
                )}
              </Button>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-3 pb-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : filteredDecisions.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    {!isSuperAdmin && (
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                          onCheckedChange={toggleSelectAll}
                          aria-label="Select all on this page"
                          data-testid="checkbox-select-all"
                        />
                      </TableHead>
                    )}
                    <TableHead>Customer ID</TableHead>
                    <TableHead>Run Date</TableHead>
                    <TableHead>Recommended Treatment</TableHead>
                    <TableHead className="whitespace-nowrap">Confidence</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageDecisions.map((d) => {
                    const v2 = getV2Data(d);
                    const sysHold = isSystemHold(d, v2);
                    const deviation = hasPriorityDeviation(v2);
                    const badgeInfo = validationBadgeInfo(d, v2);
                    const treatmentName = v2.recommendedTreatmentName || v2.recommendedTreatmentCode || d.proposedSolution || "—";
                    const rationale = v2.treatmentRationale;
                    const customerName = extractCustomerName(d);

                    return (
                      <TableRow key={d.id} className={selectedIds.has(d.id) ? "bg-muted/50" : ""}>
                        {!isSuperAdmin && (
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.has(d.id)}
                              onCheckedChange={() => toggleSelect(d.id)}
                              aria-label={`Select ${d.customerGuid}`}
                              data-testid={`checkbox-select-${d.id}`}
                            />
                          </TableCell>
                        )}
                        <TableCell>
                          <div className="space-y-0.5">
                            {customerName && (
                              <p className="text-sm font-medium" data-testid={`text-customer-name-${d.id}`}>{customerName}</p>
                            )}
                            <span className={`font-mono ${customerName ? "text-xs text-muted-foreground" : "font-medium text-sm"}`} data-testid={`text-customer-id-${d.id}`}>
                              {d.customerGuid}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-run-date-${d.id}`}>
                          {new Date(d.createdAt).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium" data-testid={`text-treatment-name-${d.id}`}>
                                {treatmentName.length > 40 ? treatmentName.substring(0, 40) + "…" : treatmentName}
                              </span>
                              {deviation && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 py-0 border-amber-400 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300"
                                  data-testid={`badge-priority-deviation-${d.id}`}
                                >
                                  Priority deviation
                                </Badge>
                              )}
                              {sysHold && (
                                <Badge
                                  variant="destructive"
                                  className="text-[10px] px-1.5 py-0"
                                  data-testid={`badge-system-hold-${d.id}`}
                                >
                                  System hold
                                </Badge>
                              )}
                              {v2.requiresAgentReview && !sysHold && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0 border-orange-400 text-orange-700 bg-orange-50 dark:bg-orange-950 dark:text-orange-300"
                                  data-testid={`badge-needs-review-${d.id}`}
                                >
                                  Needs review
                                </Badge>
                              )}
                            </div>
                            {rationale && (
                              <p className="text-xs text-muted-foreground line-clamp-1" data-testid={`text-rationale-${d.id}`}>
                                {rationale}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap" data-testid={`text-confidence-${d.id}`}>
                          {v2.confidenceScore != null ? (
                            <div className="flex items-center gap-1.5">
                              <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${v2.confidenceScore >= 0.7 ? "bg-green-500" : v2.confidenceScore >= 0.4 ? "bg-amber-400" : "bg-red-400"}`}
                                  style={{ width: `${Math.round(v2.confidenceScore * 100)}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground">{Math.round(v2.confidenceScore * 100)}%</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {badgeInfo ? (
                            <Badge variant={badgeInfo.variant} className="gap-1 text-xs" data-testid={`badge-validation-${d.id}`}>
                              <badgeInfo.icon className="w-3 h-3" />
                              {badgeInfo.label}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground" data-testid={`badge-validation-${d.id}`}>—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link href={`/review/${d.id}`}>
                            <Button
                              variant={activeTab === "pending" ? "default" : "outline"}
                              size="sm"
                              data-testid={`button-review-${d.id}`}
                            >
                              Review <ArrowRight className="w-3.5 h-3.5 ml-1" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between py-4 px-1">
                <p className="text-sm text-muted-foreground" data-testid="text-pagination-info">
                  Showing {startIdx + 1}–{Math.min(startIdx + PAGE_SIZE, filteredDecisions.length)} of {filteredDecisions.length} items
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safePage <= 1}
                    onClick={() => setPage(safePage - 1)}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" /> Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(safePage + 1)}
                    data-testid="button-next-page"
                  >
                    Next <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="py-12 text-center">
              <ClipboardList className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchQuery || validationFilter !== "all" || reviewFilter !== "all" || treatmentFilter
                  ? "No cases match the current filters."
                  : activeTab === "pending"
                  ? "No pending decisions. Click 'Start Analyzing' to generate recommendations."
                  : "No completed reviews yet."}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
