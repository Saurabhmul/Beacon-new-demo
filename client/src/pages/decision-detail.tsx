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
  Brain,
  AlertTriangle,
  Loader2,
  Shield,
  DollarSign,
  Calendar,
  HelpCircle,
  ThumbsUp,
  ThumbsDown,
  CircleDot,
  MessageSquare,
  CreditCard,
  ShieldAlert,
  TrendingUp,
  Heart,
  Mail,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Copy,
  Code2,
  Info,
  CheckSquare,
  ListTree,
} from "lucide-react";
import type { Decision } from "@shared/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEvidence(evidence: string | null | undefined): string[] {
  if (!evidence) return [];
  return evidence.split(/[\n;•·]/).map((l) => l.trim()).filter((l) => l.length > 0);
}

function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function extractCustomerMetrics(decision: Decision) {
  const data = decision.customerData || {};
  const findValue = (keys: string[]) => {
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith("_")) continue;
        if (k.toLowerCase().includes(lowerKey) && v != null && v !== "") return String(v);
      }
    }
    return null;
  };
  return {
    totalDue: findValue(["amount_due", "total_due", "outstanding", "balance"]),
    dpdBucket: findValue(["dpd_bucket", "dpd", "days_past_due"]),
    minimumDue: findValue(["minimum_due", "min_due"]),
    dueDate: findValue(["due_date", "duedate", "payment_due"]),
  };
}

function getRaw(decision: Decision): Record<string, unknown> {
  return (decision.aiRawOutput || {}) as Record<string, unknown>;
}

// ── V2 type helpers ───────────────────────────────────────────────────────────

function str(v: unknown): string { return v != null ? String(v) : ""; }
function num(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function getV2Raw(raw: Record<string, unknown>) {
  const engineVersion = str(raw.engineVersion);
  const isV2 = engineVersion.startsWith("decision-layer-v2");
  const finalAI = ((raw.finalAIOutput || {}) as Record<string, unknown>);
  const validation = ((raw.validation || {}) as Record<string, unknown>);
  const dp = ((raw.decisionPacket || {}) as Record<string, unknown>);
  const trace = ((raw.treatmentSelectionTrace || []) as Array<Record<string, unknown>>);
  const srcTrace = ((raw.sourceResolutionTrace || {}) as Record<string, Record<string, unknown>>);
  const derivedTrace = ((raw.derivedFieldTrace || {}) as Record<string, Record<string, unknown>>);
  const bizTrace = ((raw.businessFieldTrace || {}) as Record<string, Record<string, unknown>>);

  return {
    isV2,
    engineVersion,
    runFallbackReason: str(raw.runFallbackReason) || null,
    finalAI,
    validation,
    validationStatus: str(validation.status) || null,
    validationFailureType: str(validation.failureType) || null,
    blockingIssues: ((validation.blockingIssues || []) as Array<Record<string, unknown>>),
    warnings: ((validation.warnings || []) as Array<Record<string, unknown>>),
    dp,
    preferredTreatments: ((dp.preferredTreatments || []) as Array<Record<string, unknown>>),
    blockedTreatments: ((dp.blockedTreatments || []) as Array<Record<string, unknown>>),
    rankedEligible: ((dp.rankedEligibleTreatments || []) as Array<Record<string, unknown>>),
    escalationFlags: ((dp.escalationFlags || []) as Array<Record<string, unknown>>),
    guardrailFlags: ((dp.guardrailFlags || []) as Array<Record<string, unknown>>),
    reviewTriggers: ((dp.reviewTriggers || []) as Array<Record<string, unknown>>),
    missingCritical: ((dp.missingCriticalInformation || []) as Array<Record<string, unknown>>),
    trace,
    srcTrace,
    derivedTrace,
    bizTrace,
    recommendedCode: str(finalAI.recommended_treatment_code) || null,
    recommendedName: str(finalAI.recommended_treatment_name) || null,
    requiresAgentReview: !!(finalAI.requires_agent_review),
    customerSituation: str(finalAI.customer_situation) || null,
    customerSituationConfidenceScore: num(finalAI.customer_situation_confidence_score),
    confidenceScore: num(finalAI.proposed_next_best_confidence_score),
    // structured_assessments is Array<{name?,value?,reason?}> — not plain strings
    structuredAssessments: ((finalAI.structured_assessments || []) as Array<Record<string, unknown>>),
    proposedNextBestAction: str(finalAI.proposed_next_best_action) || null,
    treatmentEligibilityExplanation: str(finalAI.treatment_eligibility_explanation) || null,
    // blocked_conditions is unknown[] — elements may be strings or structured objects
    blockedConditions: ((finalAI.blocked_conditions || []) as unknown[]),
    internalAction: str(finalAI.internal_action) || null,
    proposedNextBestEvidence: str(finalAI.proposed_next_best_evidence) || null,
  };
}

// Same patterns as review-queue — must stay in sync
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

function isSystemHoldDecision(
  decision: Decision,
  v2: ReturnType<typeof getV2Raw>
): boolean {
  // DB-persisted internalAction (covers all versions)
  if (decision.internalAction?.startsWith("SYSTEM_HOLD:")) return true;
  // v2 payload finalAIOutput.internal_action (authoritative for v2 system hold)
  if (v2.isV2 && v2.internalAction?.startsWith("SYSTEM_HOLD:")) return true;
  // DB status set to failed_validation = system decided not to proceed
  if (decision.status === "failed_validation") return true;
  // runFallbackReason patterns (from orchestrator spec)
  if (v2.runFallbackReason) {
    const r = v2.runFallbackReason.toLowerCase();
    if (SYSTEM_HOLD_PATTERNS.some((p) => r.includes(p))) return true;
  }
  return false;
}

function chosenVsPreferred(v2: ReturnType<typeof getV2Raw>) {
  const chosenCode = v2.recommendedCode;
  const preferred = v2.preferredTreatments;
  if (!chosenCode || chosenCode === "AGENT_REVIEW" || !preferred.length) return null;
  const topPreferred = preferred[0];
  const topCode = str(topPreferred.code) || null;
  if (!topCode || topCode === chosenCode) return null;
  const chosenEntry = v2.trace.find(t => str(t.treatmentCode) === chosenCode);
  return {
    topPreferredCode: topCode,
    topPreferredName: str(topPreferred.name) || topCode,
    chosenCode,
    chosenName: v2.recommendedName || chosenCode,
    selectionMode: str(chosenEntry?.selectionMode) || null,
    selectionReason: str(chosenEntry?.selectionReason) || null,
  };
}

function derivedStatusLabel(status: string, nullReason: string, errorMsg: string): string {
  if (status === "computed") return "computed";
  if (status === "error") return `error — ${errorMsg || "unknown error"}`;
  if (status === "skipped") return "Skipped — not required for this decision";
  if (status === "null") {
    const r = (nullReason || "").toLowerCase();
    if (r.includes("missing") || r.includes("source")) return "Null — missing source fields";
    if (r.includes("retry") || r.includes("invalid")) return "Null — model output invalid after retry";
    return "Null — insufficient evidence";
  }
  return status;
}

function bizNullLabel(nullReason: string): string {
  const r = (nullReason || "").toLowerCase();
  if (r.includes("retry") || r.includes("invalid") || r.includes("parse")) return "Null — model output invalid after retry";
  return "Null — insufficient evidence";
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionPanel({
  title,
  typeLabel,
  icon: Icon,
  defaultOpen = false,
  children,
  testId,
}: {
  title: string;
  typeLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card data-testid={testId}>
      <button
        type="button"
        className="w-full text-left"
        onClick={() => setOpen(!open)}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 cursor-pointer">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-muted-foreground" />
            <span className="text-base font-semibold">{title}</span>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 uppercase tracking-wide">
              {typeLabel}
            </Badge>
          </div>
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </CardHeader>
      </button>
      {open && (
        <CardContent className="pt-0">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

function ValidationBadge({ status, failureType, warnings }: {
  status: string | null;
  failureType: string | null;
  warnings: Array<Record<string, unknown>>;
}) {
  if (!status) return null;
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1" data-testid="badge-v2-validation-status">
        <XCircle className="w-3 h-3" />
        {failureType ? `Failed — ${failureType.replace(/_/g, " ")}` : "Failed"}
      </Badge>
    );
  }
  if (warnings.length > 0) {
    return (
      <Badge variant="secondary" className="gap-1 border-amber-400 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300" data-testid="badge-v2-validation-status">
        <AlertTriangle className="w-3 h-3" />
        {warnings.length} warning{warnings.length > 1 ? "s" : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="gap-1 bg-green-600 dark:bg-green-700" data-testid="badge-v2-validation-status">
      <CheckCircle2 className="w-3 h-3" />
      Passed
    </Badge>
  );
}

// Confidence scores from the backend are 1–10 integers (not 0–1 fractions).
// Display as X/10 and fill bar proportionally.
function ConfidenceBar({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const clamped = Math.max(0, Math.min(10, value));
  const pct = Math.round((clamped / 10) * 100);
  const color = clamped >= 7 ? "bg-green-500" : clamped >= 4 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{clamped}/10</span>
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { toast } = useToast();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs gap-1"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          toast({ title: "Copied to clipboard" });
        });
      }}
      data-testid="button-copy"
    >
      <Copy className="w-3 h-3" />
      {label}
    </Button>
  );
}

function EmailWidget({
  emailText,
  emailFeedback,
  emailComment,
  setEmailFeedback,
  setEmailComment,
}: {
  emailText: string;
  emailFeedback: "agree" | "disagree" | null;
  emailComment: string;
  setEmailFeedback: (v: "agree" | "disagree" | null) => void;
  setEmailComment: (v: string) => void;
}) {
  if (!emailText || emailText === "NO_ACTION") {
    return (
      <div className="text-center py-4">
        <Mail className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No email action recommended for this customer.</p>
      </div>
    );
  }

  const normalized = emailText.replace(/\\n/g, "\n");
  const subjectMatch = normalized.match(/^Subject:\s*(.+?)(?:\n|$)/im);
  const bodyMatch = normalized.match(/(?:^|\n)Body:\s*([\s\S]*)/im);

  return (
    <div className="space-y-4">
      <div className="bg-muted/50 rounded-md p-4" data-testid="text-proposed-email">
        {subjectMatch && bodyMatch ? (
          <div className="space-y-3">
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Subject</span>
              <p className="text-sm font-semibold mt-1">{subjectMatch[1].trim()}</p>
            </div>
            <Separator />
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Body</span>
              <div className="text-sm mt-1 space-y-2">
                {bodyMatch[1].trim().split(/\n\n+/).map((para, i) => (
                  <p key={i}>{para.replace(/\n/g, " ").trim()}</p>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm space-y-2">
            {normalized.split(/\n\n+/).map((para, i) => (
              <p key={i}>{para.replace(/\n/g, " ").trim()}</p>
            ))}
          </div>
        )}
      </div>
      <Separator />
      <div>
        <p className="text-xs text-muted-foreground mb-2">Do you agree with this proposed email?</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline" size="sm"
            className={`gap-1.5 ${emailFeedback === "agree" ? "border-primary bg-primary/10" : ""}`}
            onClick={() => setEmailFeedback(emailFeedback === "agree" ? null : "agree")}
            data-testid="button-email-agree"
          >
            <ThumbsUp className="w-3.5 h-3.5" /> Agree
          </Button>
          <Button
            variant="outline" size="sm"
            className={`gap-1.5 ${emailFeedback === "disagree" ? "border-destructive bg-destructive/10" : ""}`}
            onClick={() => setEmailFeedback(emailFeedback === "disagree" ? null : "disagree")}
            data-testid="button-email-disagree"
          >
            <ThumbsDown className="w-3.5 h-3.5" /> Disagree
          </Button>
        </div>
        {emailFeedback === "disagree" && (
          <Textarea
            value={emailComment}
            onChange={(e) => setEmailComment(e.target.value)}
            placeholder="Please explain why you disagree with this email..."
            className="mt-3 min-h-[80px]"
            data-testid="textarea-email-comment"
          />
        )}
      </div>
    </div>
  );
}

// ── V2 Section 1: Case Summary ─────────────────────────────────────────────────

function CaseSummarySection({ v2 }: { v2: ReturnType<typeof getV2Raw> }) {
  return (
    <SectionPanel title="Case Summary" typeLabel="recommendation" icon={Brain} testId="section-case-summary">
      <div className="space-y-5">
        {v2.structuredAssessments.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Structured Assessments</p>
            <ul className="space-y-2">
              {v2.structuredAssessments.map((a, i) => {
                // schema: { name?, value?, reason? } — never render raw object
                const name = str(a.name);
                const value = str(a.value);
                const reason = str(a.reason);
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <CheckSquare className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                    <div>
                      {name ? (
                        <>
                          <span className="font-medium">{name}:</span>{" "}
                          <span>{value || "—"}</span>
                          {reason && <p className="text-xs text-muted-foreground mt-0.5">{reason}</p>}
                        </>
                      ) : (
                        <span>{value || JSON.stringify(a)}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {v2.proposedNextBestAction && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Proposed Next Best Action</p>
            <p className="text-sm" data-testid="text-proposed-next-best-action">{v2.proposedNextBestAction}</p>
          </div>
        )}
        {v2.treatmentEligibilityExplanation && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Treatment Eligibility Explanation</p>
            <p className="text-sm leading-relaxed" data-testid="text-eligibility-explanation">{v2.treatmentEligibilityExplanation}</p>
          </div>
        )}
        {v2.blockedConditions.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Blocked Conditions</p>
            <ul className="space-y-1.5">
              {v2.blockedConditions.map((bc, i) => {
                // elements may be strings or structured objects — render defensively
                const bcStr = typeof bc === "string" ? bc : str((bc as Record<string, unknown>)?.description ?? (bc as Record<string, unknown>)?.reason ?? bc);
                const lower = bcStr.toLowerCase();
                const isHard = lower.includes("hard") || lower.includes("must not") || lower.includes("cannot");
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Badge
                      variant={isHard ? "destructive" : "secondary"}
                      className="text-[10px] shrink-0 mt-0.5"
                    >
                      {isHard ? "hard blocker" : "soft blocker"}
                    </Badge>
                    <span>{bcStr}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {v2.internalAction && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Internal Action</p>
            <p className="text-sm font-mono bg-muted/50 rounded px-2 py-1" data-testid="text-v2-internal-action">{v2.internalAction}</p>
          </div>
        )}
      </div>
    </SectionPanel>
  );
}

// ── V2 Section 2: Source Data ─────────────────────────────────────────────────

function SourceDataSection({ srcTrace }: { srcTrace: Record<string, Record<string, unknown>> }) {
  const [showNulls, setShowNulls] = useState(false);
  const entries = Object.entries(srcTrace);
  const nonNullEntries = entries.filter(([, t]) => t.rawValue != null && t.rawValue !== "");
  const nullEntries = entries.filter(([, t]) => t.rawValue == null || t.rawValue === "");
  const display = showNulls ? entries : nonNullEntries;

  return (
    <SectionPanel title="Source Data" typeLabel="facts" icon={ListTree} testId="section-source-data">
      <div className="space-y-3">
        {nullEntries.length > 0 && (
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">{nonNullEntries.length} fields with values; {nullEntries.length} null/unresolved</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setShowNulls(!showNulls)}
              data-testid="button-toggle-null-fields"
            >
              {showNulls ? "Hide null fields" : "Show null fields"}
            </Button>
          </div>
        )}
        {display.length === 0 ? (
          <p className="text-sm text-muted-foreground">Unavailable — generated before v2.1</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {display.map(([fieldId, trace]) => {
              const label = str(trace.rawKey) || fieldId;
              const isNull = trace.rawValue == null || trace.rawValue === "";
              const method = str(trace.method);
              return (
                <div key={fieldId} className="py-1 border-b border-border/50 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-muted-foreground break-all">{label}</p>
                    {method === "alias" && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">alias</Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium mt-0.5 break-words" data-testid={`text-source-value-${fieldId}`}>
                    {isNull
                      ? <span className="text-muted-foreground italic text-xs">{method === "unresolved" ? "Unresolved" : "Null — missing from source data"}</span>
                      : String(trace.rawValue)}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionPanel>
  );
}

// ── V2 Section 3: Derived Fields ──────────────────────────────────────────────

function DerivedFieldsSection({ derivedTrace }: { derivedTrace: Record<string, Record<string, unknown>> }) {
  const entries = Object.entries(derivedTrace);
  return (
    <SectionPanel title="Derived Fields" typeLabel="computed facts" icon={TrendingUp} testId="section-derived-fields">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Unavailable — generated before v2.1</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Formula / Inputs</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map(([fieldId, trace]) => {
              const status = str(trace.status);
              const formula = str(trace.formula);
              const inputsUsed = ((trace.inputsUsed || []) as string[]);
              const outputValue = trace.outputValue;
              const nullReason = str(trace.nullReason);
              const errorMsg = str(trace.error);
              const statusLabel = derivedStatusLabel(status, nullReason, errorMsg);
              const isComputed = status === "computed";

              return (
                <TableRow key={fieldId}>
                  <TableCell className="text-xs font-mono text-muted-foreground break-all max-w-[120px]" data-testid={`text-derived-field-${fieldId}`}>
                    {fieldId}
                  </TableCell>
                  <TableCell className="text-xs max-w-[200px]">
                    {formula && <p className="font-mono text-muted-foreground mb-1">{formula}</p>}
                    {inputsUsed.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {inputsUsed.map((inp, i) => (
                          <Badge key={i} variant="outline" className="text-[9px] px-1 py-0">{inp}</Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm" data-testid={`text-derived-value-${fieldId}`}>
                    {isComputed && outputValue != null ? String(outputValue) : <span className="italic text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={isComputed ? "default" : status === "error" ? "destructive" : "secondary"}
                      className="text-[10px] whitespace-nowrap"
                      data-testid={`badge-derived-status-${fieldId}`}
                    >
                      {statusLabel}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SectionPanel>
  );
}

// ── V2 Section 4: Business Fields ─────────────────────────────────────────────

function BusinessFieldEntry({
  fieldId,
  trace,
}: {
  fieldId: string;
  trace: Record<string, unknown>;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const label = str(trace.fieldLabel) || fieldId;
  const tier = num(trace.tier);
  const value = trace.value;
  const confidence = num(trace.confidence);
  const rationale = str(trace.rationale) || null;
  const nullReason = str(trace.nullReason) || null;
  const evidence = ((trace.evidence || []) as string[]);
  const hasValue = value != null;

  return (
    <div className="border rounded-md p-3 space-y-2" data-testid={`card-biz-field-${fieldId}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground font-mono">{fieldId}</p>
        </div>
        {tier != null && (
          <Badge variant="outline" className="text-[10px] shrink-0">Tier {tier}</Badge>
        )}
      </div>
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-0.5">Value</p>
        <p className="text-sm font-semibold" data-testid={`text-biz-value-${fieldId}`}>
          {hasValue ? String(value) : (
            <span className="italic text-muted-foreground font-normal text-xs">
              {nullReason ? bizNullLabel(nullReason) : "Null — insufficient evidence"}
            </span>
          )}
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Confidence</p>
        <ConfidenceBar value={confidence} />
      </div>
      {rationale && (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-0.5">Rationale</p>
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid={`text-biz-rationale-${fieldId}`}>{rationale}</p>
        </div>
      )}
      {evidence.length > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setEvidenceOpen(!evidenceOpen)}
            data-testid={`button-biz-evidence-${fieldId}`}
          >
            {evidenceOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {evidence.length} evidence item{evidence.length > 1 ? "s" : ""}
          </button>
          {evidenceOpen && (
            <ul className="mt-1.5 space-y-1">
              {evidence.map((e, i) => (
                <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <CircleDot className="w-3 h-3 mt-0.5 shrink-0" />
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BusinessFieldsSection({ bizTrace }: { bizTrace: Record<string, Record<string, unknown>> }) {
  const entries = Object.entries(bizTrace);
  return (
    <SectionPanel title="Business Fields" typeLabel="inferred judgments" icon={Brain} testId="section-business-fields">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Unavailable — generated before v2.1</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {entries.map(([fieldId, trace]) => (
            <BusinessFieldEntry key={fieldId} fieldId={fieldId} trace={trace} />
          ))}
        </div>
      )}
    </SectionPanel>
  );
}

// ── V2 Section 5: Treatment Decision & Validation ─────────────────────────────

function TreatmentDecisionSection({
  decision,
  v2,
  emailFeedback,
  emailComment,
  setEmailFeedback,
  setEmailComment,
}: {
  decision: Decision;
  v2: ReturnType<typeof getV2Raw>;
  emailFeedback: "agree" | "disagree" | null;
  emailComment: string;
  setEmailFeedback: (v: "agree" | "disagree" | null) => void;
  setEmailComment: (v: string) => void;
}) {
  const [showRawTrace, setShowRawTrace] = useState(false);
  const deviation = chosenVsPreferred(v2);
  const issuesText = JSON.stringify(
    { blockingIssues: v2.blockingIssues, warnings: v2.warnings },
    null,
    2
  );
  const fullTraceText = JSON.stringify(decision.aiRawOutput, null, 2);

  return (
    <SectionPanel title="Treatment Decision & Validation" typeLabel="recommendation" icon={Shield} testId="section-treatment-decision">
      <div className="space-y-5">
        {/* Preferred vs chosen */}
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Treatment Selection</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Preferred */}
            <div className="bg-muted/40 rounded-md p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Policy preferred</p>
              {v2.preferredTreatments.length > 0 ? (
                v2.preferredTreatments.map((pt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">{str(pt.code)}</Badge>
                    <span className="text-sm">{str(pt.name)}</span>
                    {num(pt.priority) != null && (
                      <span className="text-xs text-muted-foreground">Priority {num(pt.priority)}</span>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground italic">None configured</p>
              )}
            </div>
            {/* Chosen */}
            <div className="bg-muted/40 rounded-md p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">AI chose</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={v2.recommendedCode === "AGENT_REVIEW" ? "destructive" : "default"} className="text-xs">
                  {v2.recommendedCode || "—"}
                </Badge>
                <span className="text-sm">{v2.recommendedName || "—"}</span>
              </div>
              {deviation && (
                <div className="mt-2 space-y-1">
                  <Badge
                    variant="secondary"
                    className="text-[10px] border-amber-400 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300"
                    data-testid="badge-priority-deviation-detail"
                  >
                    Priority deviation
                  </Badge>
                  {deviation.selectionMode && (
                    <p className="text-xs text-muted-foreground">Mode: <span className="font-mono">{deviation.selectionMode}</span></p>
                  )}
                  {deviation.selectionReason && (
                    <p className="text-xs text-muted-foreground leading-relaxed" data-testid="text-selection-reason">{deviation.selectionReason}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Evidence for choice */}
        {v2.proposedNextBestEvidence && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Evidence for Recommendation</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{v2.proposedNextBestEvidence}</p>
          </div>
        )}

        {/* Blocked conditions — also surfaced here for treatment decision context */}
        {v2.blockedConditions.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Blocked Conditions</p>
            <ul className="space-y-1.5">
              {v2.blockedConditions.map((bc, i) => {
                const bcStr = typeof bc === "string" ? bc : str((bc as Record<string, unknown>)?.description ?? (bc as Record<string, unknown>)?.reason ?? bc);
                const lower = bcStr.toLowerCase();
                const isHard = lower.includes("hard") || lower.includes("must not") || lower.includes("cannot");
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Badge variant={isHard ? "destructive" : "secondary"} className="text-[10px] shrink-0 mt-0.5">
                      {isHard ? "hard blocker" : "soft blocker"}
                    </Badge>
                    <span className="text-muted-foreground">{bcStr}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Validation result */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Validation Result</p>
            <div className="flex items-center gap-2">
              <ValidationBadge
                status={v2.validationStatus}
                failureType={v2.validationFailureType}
                warnings={v2.warnings}
              />
              {(v2.blockingIssues.length > 0 || v2.warnings.length > 0) && (
                <CopyButton text={issuesText} label="Copy issues" />
              )}
            </div>
          </div>
          {v2.blockingIssues.length > 0 && (
            <div className="space-y-1.5 mb-3">
              <p className="text-xs text-muted-foreground font-medium">Blocking issues:</p>
              {v2.blockingIssues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-destructive">
                  <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{str(issue.message)}</span>
                </div>
              ))}
            </div>
          )}
          {v2.warnings.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium">Warnings:</p>
              {v2.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{str(w.message)}</span>
                </div>
              ))}
            </div>
          )}
          {v2.blockingIssues.length === 0 && v2.warnings.length === 0 && v2.validationStatus && (
            <p className="text-xs text-muted-foreground">No issues or warnings recorded.</p>
          )}
        </div>

        <Separator />

        {/* Email draft */}
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Proposed Email</p>
          <EmailWidget
            emailText={decision.proposedEmailToCustomer || ""}
            emailFeedback={emailFeedback}
            emailComment={emailComment}
            setEmailFeedback={setEmailFeedback}
            setEmailComment={setEmailComment}
          />
        </div>

        <Separator />

        {/* Raw trace toggle */}
        <div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowRawTrace(!showRawTrace)}
              data-testid="button-inspect-raw-trace"
            >
              <Code2 className="w-3.5 h-3.5" />
              {showRawTrace ? "Hide raw trace" : "Inspect raw trace"}
              {showRawTrace ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            {showRawTrace && <CopyButton text={fullTraceText} label="Copy JSON" />}
          </div>
          {showRawTrace && (
            <pre className="mt-2 text-[10px] font-mono bg-muted/50 rounded-md p-3 overflow-auto max-h-96 text-muted-foreground" data-testid="text-raw-trace">
              {fullTraceText}
            </pre>
          )}
        </div>
      </div>
    </SectionPanel>
  );
}

// ── V2 Top Summary ─────────────────────────────────────────────────────────────

function V2TopSummary({
  decision,
  v2,
  sysHold,
}: {
  decision: Decision;
  v2: ReturnType<typeof getV2Raw>;
  sysHold: boolean;
}) {
  return (
    <Card data-testid="card-v2-summary">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Customer</p>
            </div>
            <p className="text-base font-mono font-semibold break-all" data-testid="text-customer-guid">{decision.customerGuid}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sysHold && (
              <Badge variant="destructive" className="gap-1" data-testid="badge-system-hold">
                <ShieldAlert className="w-3 h-3" /> System hold
              </Badge>
            )}
            {v2.requiresAgentReview && !sysHold && (
              <Badge variant="outline" className="gap-1 border-orange-400 text-orange-700 bg-orange-50 dark:bg-orange-950 dark:text-orange-300" data-testid="badge-needs-review">
                <Info className="w-3 h-3" /> Needs review
              </Badge>
            )}
            <ValidationBadge
              status={v2.validationStatus}
              failureType={v2.validationFailureType}
              warnings={v2.warnings}
            />
            <Badge
              variant={decision.status === "pending" ? "outline" : decision.agentAgreed ? "default" : "destructive"}
              data-testid="badge-status"
            >
              {decision.status === "pending" ? "Pending Review" : decision.agentAgreed ? "Approved" : "Rejected"}
            </Badge>
          </div>
        </div>

        <Separator className="my-3" />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Recommended Treatment</p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={v2.recommendedCode === "AGENT_REVIEW" ? "secondary" : "default"}
                className="text-sm px-2"
                data-testid="badge-recommended-treatment"
              >
                {v2.recommendedCode || "—"}
              </Badge>
              {v2.recommendedName && v2.recommendedName !== v2.recommendedCode && (
                <span className="text-sm text-muted-foreground">{v2.recommendedName}</span>
              )}
              {v2.confidenceScore != null && (
                <span className="text-xs text-muted-foreground">({Math.max(0, Math.min(10, v2.confidenceScore))}/10 confidence)</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              <Calendar className="w-3.5 h-3.5 inline mr-1" />
              Analyzed
            </p>
            <p className="text-sm" data-testid="text-analyzed-date">{formatDate(decision.createdAt)}</p>
          </div>
        </div>

        {v2.customerSituation && (
          <>
            <Separator className="my-3" />
            <div>
              <div className="flex items-center gap-2 mb-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Customer Situation</p>
                {v2.customerSituationConfidenceScore != null && (
                  <ConfidenceBar value={v2.customerSituationConfidenceScore} />
                )}
              </div>
              <p className="text-sm leading-relaxed" data-testid="text-customer-situation">{v2.customerSituation}</p>
            </div>
          </>
        )}

        {v2.runFallbackReason && (
          <>
            <Separator className="my-3" />
            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded p-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
              <span><span className="font-medium">Fallback reason:</span> {v2.runFallbackReason}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";

  // Legacy state
  const [atpFeedback, setAtpFeedback] = useState<"correct" | "incorrect" | "undetermined" | null>(null);
  const [atpComment, setAtpComment] = useState("");
  const [solutionFeedback, setSolutionFeedback] = useState<"agree" | "disagree" | null>(null);
  const [solutionComment, setSolutionComment] = useState("");
  const [emailFeedback, setEmailFeedback] = useState<"agree" | "disagree" | null>(null);
  const [emailComment, setEmailComment] = useState("");

  // These are used in both v1 review and v2 review widget
  const [agentReason, setAgentReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);

  const { toast } = useToast();

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

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
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

  const raw = getRaw(decision);
  const v2 = getV2Raw(raw);

  // ── V2 Layout ───────────────────────────────────────────────────────────────
  if (v2.isV2) {
    const sysHold = isSystemHoldDecision(decision, v2);
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Button
          variant="ghost"
          onClick={() => setLocation("/review")}
          className="gap-2"
          data-testid="button-back-to-queue"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Queue
        </Button>

        <V2TopSummary decision={decision} v2={v2} sysHold={sysHold} />

        <CaseSummarySection v2={v2} />
        <SourceDataSection srcTrace={v2.srcTrace} />
        <DerivedFieldsSection derivedTrace={v2.derivedTrace} />
        <BusinessFieldsSection bizTrace={v2.bizTrace} />
        <TreatmentDecisionSection
          decision={decision}
          v2={v2}
          emailFeedback={emailFeedback}
          emailComment={emailComment}
          setEmailFeedback={setEmailFeedback}
          setEmailComment={setEmailComment}
        />

        {!isSuperAdmin && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your Decision</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {decision.status !== "pending" ? (
                decision.agentReason ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Agent's Reason for Rejection</p>
                    <p className="text-sm" data-testid="text-agent-reason">{decision.agentReason}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Review submitted.</p>
                )
              ) : showRejectForm ? (
                <div className="space-y-3">
                  <Textarea
                    value={agentReason}
                    onChange={(e) => setAgentReason(e.target.value)}
                    placeholder="Please explain why you disagree with the AI recommendation..."
                    className="min-h-[100px]"
                    data-testid="textarea-reject-reason"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="destructive"
                      onClick={() => reviewMutation.mutate({ agentAgreed: false, agentReason })}
                      disabled={!agentReason.trim() || reviewMutation.isPending}
                      data-testid="button-confirm-reject"
                    >
                      {reviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <XCircle className="w-4 h-4 mr-2" />}
                      Submit Rejection
                    </Button>
                    <Button variant="outline" onClick={() => setShowRejectForm(false)} data-testid="button-cancel-reject">
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    onClick={() => reviewMutation.mutate({ agentAgreed: true })}
                    disabled={reviewMutation.isPending}
                    data-testid="button-approve"
                  >
                    {reviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                    Agree with AI
                  </Button>
                  <Button variant="outline" onClick={() => setShowRejectForm(true)} data-testid="button-disagree">
                    <XCircle className="w-4 h-4 mr-2" /> Disagree
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ── Legacy (v1) Layout ──────────────────────────────────────────────────────
  const isPending = decision.status === "pending";
  const metrics = extractCustomerMetrics(decision);
  const problemBullets = parseEvidence(decision.problemEvidence);
  const solutionBullets = parseEvidence(decision.solutionEvidence);

  const paymentHistory = String(raw.payment_history || "");
  const conversationSummary = String(raw.conversation || "");
  const vulnerability = raw.vulnerability === true || raw.vulnerability === "true";
  const reasonForVulnerability = String(raw.reason_for_vulnerability || "");
  const affordability = String(raw.affordability || "not sure");
  const reasonForAffordability = String(raw.reason_for_affordability || "");
  const willingness = String(raw.willingness || "not sure");
  const reasonForWillingness = String(raw.reason_for_willingness || "");

  const levelBadgeVariant = (level: string) => {
    const l = level.toLowerCase();
    if (l === "high") return "default" as const;
    if (l === "medium") return "secondary" as const;
    if (l === "low" || l === "very low") return "destructive" as const;
    return "outline" as const;
  };

  return (
    <div className="p-6 space-y-6">
      <Button
        variant="ghost"
        onClick={() => setLocation("/review")}
        className="gap-2"
        data-testid="button-back-to-queue"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Queue
      </Button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Customer Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Customer ID</p>
                <p className="text-sm font-mono break-all" data-testid="text-customer-guid">{decision.customerGuid}</p>
              </div>
              <Separator />
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Status</p>
                <Badge
                  variant={decision.status === "pending" ? "outline" : decision.agentAgreed ? "default" : "destructive"}
                  data-testid="badge-status"
                >
                  {decision.status === "pending" ? "Pending Review" : decision.agentAgreed ? "Approved" : "Rejected"}
                </Badge>
              </div>
              {metrics.totalDue && (
                <>
                  <Separator />
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Amount Due</p>
                    <p className="text-sm font-semibold" data-testid="text-total-due">{metrics.totalDue}</p>
                  </div>
                </>
              )}
              {metrics.dpdBucket && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">DPD Bucket</p>
                  <p className="text-sm" data-testid="text-dpd-bucket">{metrics.dpdBucket}</p>
                </div>
              )}
              {metrics.minimumDue && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Minimum Due</p>
                  <p className="text-sm" data-testid="text-minimum-due">{metrics.minimumDue}</p>
                </div>
              )}
              {metrics.dueDate && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Due Date</p>
                  <p className="text-sm" data-testid="text-due-date">{metrics.dueDate}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {paymentHistory && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <CreditCard className="w-4 h-4" /> Payment History
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-line" data-testid="text-payment-history">{paymentHistory}</p>
              </CardContent>
            </Card>
          )}

          {conversationSummary && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" /> Conversation Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-line" data-testid="text-conversation-summary">{conversationSummary}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" /> Vulnerability
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Badge variant={vulnerability ? "destructive" : "default"} data-testid="badge-vulnerability">
                {vulnerability ? "Vulnerable" : "Not Vulnerable"}
              </Badge>
              {vulnerability && reasonForVulnerability && (
                <p className="text-sm text-muted-foreground leading-relaxed mt-2" data-testid="text-vulnerability-reason">{reasonForVulnerability}</p>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" /> Affordability
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant={levelBadgeVariant(affordability)} className="capitalize" data-testid="badge-affordability">{affordability}</Badge>
                {reasonForAffordability && <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-affordability-reason">{reasonForAffordability}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Heart className="w-4 h-4" /> Willingness
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant={levelBadgeVariant(willingness)} className="capitalize" data-testid="badge-willingness">{willingness}</Badge>
                {reasonForWillingness && <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-willingness-reason">{reasonForWillingness}</p>}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="w-4 h-4" /> Ability to Pay
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-3xl font-bold" data-testid="text-atp-value">
                  {decision.abilityToPay != null ? decision.abilityToPay.toFixed(2) : "N/A"}
                </div>
                {decision.reasonForAbilityToPay && (
                  <p className="text-sm text-muted-foreground flex-1" data-testid="text-atp-reason">{decision.reasonForAbilityToPay}</p>
                )}
              </div>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2">Is this assessment accurate?</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" className={`gap-1.5 ${atpFeedback === "correct" ? "border-primary bg-primary/10" : ""}`} onClick={() => setAtpFeedback(atpFeedback === "correct" ? null : "correct")} data-testid="button-atp-correct">
                    <ThumbsUp className="w-3.5 h-3.5" /> Correct
                  </Button>
                  <Button variant="outline" size="sm" className={`gap-1.5 ${atpFeedback === "incorrect" ? "border-destructive bg-destructive/10" : ""}`} onClick={() => setAtpFeedback(atpFeedback === "incorrect" ? null : "incorrect")} data-testid="button-atp-incorrect">
                    <ThumbsDown className="w-3.5 h-3.5" /> Incorrect
                  </Button>
                  <Button variant="outline" size="sm" className={`gap-1.5 ${atpFeedback === "undetermined" ? "border-muted-foreground bg-muted" : ""}`} onClick={() => setAtpFeedback(atpFeedback === "undetermined" ? null : "undetermined")} data-testid="button-atp-undetermined">
                    <HelpCircle className="w-3.5 h-3.5" /> Cannot Determine
                  </Button>
                </div>
                {atpFeedback && (
                  <Textarea value={atpComment} onChange={(e) => setAtpComment(e.target.value)} placeholder="Add optional comments about this assessment..." className="mt-3 min-h-[80px]" data-testid="textarea-atp-comment" />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="w-4 h-4" /> Problem Customer is Facing
              </CardTitle>
              <div className="flex items-center gap-1.5 text-muted-foreground shrink-0">
                <Calendar className="w-3.5 h-3.5" />
                <span className="text-xs" data-testid="text-analyzed-date">Analyzed {formatDate(decision.createdAt)}</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {decision.problemDescription && (
                <div>
                  <p className="text-sm leading-relaxed" data-testid="text-problem-desc">{decision.problemDescription}</p>
                  {decision.problemConfidenceScore != null && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-muted-foreground">Confidence:</span>
                      <Badge variant={decision.problemConfidenceScore >= 7 ? "destructive" : decision.problemConfidenceScore >= 4 ? "secondary" : "default"} data-testid="badge-problem-confidence">
                        {decision.problemConfidenceScore}/10
                      </Badge>
                    </div>
                  )}
                </div>
              )}
              {problemBullets.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Evidence</p>
                  <ul className="space-y-1.5" data-testid="list-problem-evidence">
                    {problemBullets.map((bullet, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4" /> Proposed Solution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {decision.internalAction && (
                <p className="text-sm leading-relaxed break-words" data-testid="text-internal-action">
                  <span className="font-medium">Internal Action: </span>{decision.internalAction}
                </p>
              )}
              {decision.proposedSolution && (
                <div>
                  <p className="text-sm leading-relaxed" data-testid="text-proposed-solution">{decision.proposedSolution}</p>
                  {decision.solutionConfidenceScore != null && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-muted-foreground">Confidence:</span>
                      <Badge variant={decision.solutionConfidenceScore >= 7 ? "default" : decision.solutionConfidenceScore >= 4 ? "secondary" : "destructive"} data-testid="badge-solution-confidence">
                        {decision.solutionConfidenceScore}/10
                      </Badge>
                    </div>
                  )}
                </div>
              )}
              {solutionBullets.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Evidence</p>
                  <ul className="space-y-1.5" data-testid="list-solution-evidence">
                    {solutionBullets.map((bullet, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <CircleDot className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2">Do you agree with this proposed solution?</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" className={`gap-1.5 ${solutionFeedback === "agree" ? "border-primary bg-primary/10" : ""}`} onClick={() => setSolutionFeedback(solutionFeedback === "agree" ? null : "agree")} data-testid="button-solution-agree">
                    <ThumbsUp className="w-3.5 h-3.5" /> Agree
                  </Button>
                  <Button variant="outline" size="sm" className={`gap-1.5 ${solutionFeedback === "disagree" ? "border-destructive bg-destructive/10" : ""}`} onClick={() => setSolutionFeedback(solutionFeedback === "disagree" ? null : "disagree")} data-testid="button-solution-disagree">
                    <ThumbsDown className="w-3.5 h-3.5" /> Disagree
                  </Button>
                </div>
                {solutionFeedback === "disagree" && (
                  <Textarea value={solutionComment} onChange={(e) => setSolutionComment(e.target.value)} placeholder="Please explain why you disagree with the proposed solution..." className="mt-3 min-h-[80px]" data-testid="textarea-solution-comment" />
                )}
              </div>
            </CardContent>
          </Card>

          {!!(raw.arrears_clearance_plan && typeof raw.arrears_clearance_plan === "object") && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" /> Arrears Clearance Plan
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {(() => {
                  const plan = raw.arrears_clearance_plan as {
                    monthly_payment_recommended?: number;
                    surplus_above_mad?: number;
                    total_arrears?: number;
                    months_to_clear?: number;
                    projected_timeline?: Array<{ month: number; payment: number; remaining_arrears: number }>;
                  };
                  return (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-muted/50 rounded-md p-3">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Monthly Payment</p>
                          <p className="text-lg font-semibold" data-testid="text-cap-monthly-payment">{plan.monthly_payment_recommended != null ? plan.monthly_payment_recommended.toLocaleString() : "N/A"}</p>
                        </div>
                        <div className="bg-muted/50 rounded-md p-3">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Surplus Above Min Due</p>
                          <p className="text-lg font-semibold" data-testid="text-cap-surplus">{plan.surplus_above_mad != null ? plan.surplus_above_mad.toLocaleString() : "N/A"}</p>
                        </div>
                        <div className="bg-muted/50 rounded-md p-3">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Total Arrears</p>
                          <p className="text-lg font-semibold" data-testid="text-cap-total-arrears">{plan.total_arrears != null ? plan.total_arrears.toLocaleString() : "N/A"}</p>
                        </div>
                        <div className="bg-muted/50 rounded-md p-3">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Months to Clear</p>
                          <p className="text-lg font-semibold" data-testid="text-cap-months">{plan.months_to_clear ?? "N/A"}</p>
                        </div>
                      </div>
                      {plan.projected_timeline && plan.projected_timeline.length > 0 && (
                        <div>
                          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Projected Timeline</p>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Month</TableHead>
                                <TableHead className="text-right">Payment</TableHead>
                                <TableHead className="text-right">Remaining Arrears</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {plan.projected_timeline.map((row, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-medium" data-testid={`text-cap-timeline-month-${i}`}>Month {row.month}</TableCell>
                                  <TableCell className="text-right" data-testid={`text-cap-timeline-payment-${i}`}>{row.payment?.toLocaleString()}</TableCell>
                                  <TableCell className="text-right" data-testid={`text-cap-timeline-remaining-${i}`}>{row.remaining_arrears?.toLocaleString()}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="w-4 h-4" /> Proposed Email to Customer
              </CardTitle>
            </CardHeader>
            <CardContent>
              <EmailWidget
                emailText={decision.proposedEmailToCustomer || ""}
                emailFeedback={emailFeedback}
                emailComment={emailComment}
                setEmailFeedback={setEmailFeedback}
                setEmailComment={setEmailComment}
              />
            </CardContent>
          </Card>

          {isPending && !isSuperAdmin && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Your Decision</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {showRejectForm ? (
                  <div className="space-y-3">
                    <Textarea
                      value={agentReason}
                      onChange={(e) => setAgentReason(e.target.value)}
                      placeholder="Please explain why you disagree with the AI recommendation..."
                      className="min-h-[100px]"
                      data-testid="textarea-reject-reason"
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="destructive"
                        onClick={() => reviewMutation.mutate({ agentAgreed: false, agentReason })}
                        disabled={!agentReason.trim() || reviewMutation.isPending}
                        data-testid="button-confirm-reject"
                      >
                        {reviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <XCircle className="w-4 h-4 mr-2" />}
                        Submit Rejection
                      </Button>
                      <Button variant="outline" onClick={() => setShowRejectForm(false)} data-testid="button-cancel-reject">
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 flex-wrap">
                    <Button
                      onClick={() => reviewMutation.mutate({ agentAgreed: true })}
                      disabled={reviewMutation.isPending}
                      data-testid="button-approve"
                    >
                      {reviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                      Agree with AI
                    </Button>
                    <Button variant="outline" onClick={() => setShowRejectForm(true)} data-testid="button-disagree">
                      <XCircle className="w-4 h-4 mr-2" /> Disagree
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {!isPending && decision.agentReason && (
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Agent's Reason for Rejection</p>
                <p className="text-sm" data-testid="text-agent-reason">{decision.agentReason}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
