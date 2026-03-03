import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
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
} from "lucide-react";
import type { Decision } from "@shared/schema";

function parseEvidence(evidence: string | null | undefined): string[] {
  if (!evidence) return [];
  const lines = evidence.split(/[\n;•·]/);
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

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

function extractCustomerMetrics(decision: Decision) {
  const data = decision.customerData || {};

  const findValue = (keys: string[]) => {
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith("_")) continue;
        if (k.toLowerCase().includes(lowerKey) && v != null && v !== "") {
          return String(v);
        }
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

export default function DecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [agentReason, setAgentReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [atpFeedback, setAtpFeedback] = useState<"correct" | "incorrect" | "undetermined" | null>(null);
  const [atpComment, setAtpComment] = useState("");
  const [solutionFeedback, setSolutionFeedback] = useState<"agree" | "disagree" | null>(null);
  const [solutionComment, setSolutionComment] = useState("");
  const [emailFeedback, setEmailFeedback] = useState<"agree" | "disagree" | null>(null);
  const [emailComment, setEmailComment] = useState("");

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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-64" />
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
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

  const isPending = decision.status === "pending";
  const metrics = extractCustomerMetrics(decision);
  const raw = getRaw(decision);
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
                  <CreditCard className="w-4 h-4" />
                  Payment History
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
                  <MessageSquare className="w-4 h-4" />
                  Conversation Summary
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
                <ShieldAlert className="w-4 h-4" />
                Vulnerability
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
                  <TrendingUp className="w-4 h-4" />
                  Affordability
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant={levelBadgeVariant(affordability)} className="capitalize" data-testid="badge-affordability">
                  {affordability}
                </Badge>
                {reasonForAffordability && (
                  <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-affordability-reason">{reasonForAffordability}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Heart className="w-4 h-4" />
                  Willingness
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant={levelBadgeVariant(willingness)} className="capitalize" data-testid="badge-willingness">
                  {willingness}
                </Badge>
                {reasonForWillingness && (
                  <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-willingness-reason">{reasonForWillingness}</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="w-4 h-4" />
                Ability to Pay
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-3xl font-bold" data-testid="text-atp-value">
                  {decision.abilityToPay != null ? decision.abilityToPay.toFixed(2) : "N/A"}
                </div>
                {decision.reasonForAbilityToPay && (
                  <p className="text-sm text-muted-foreground flex-1" data-testid="text-atp-reason">
                    {decision.reasonForAbilityToPay}
                  </p>
                )}
              </div>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2">Is this assessment accurate?</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 ${atpFeedback === "correct" ? "border-primary bg-primary/10" : ""}`}
                    onClick={() => setAtpFeedback(atpFeedback === "correct" ? null : "correct")}
                    data-testid="button-atp-correct"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                    Correct
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 ${atpFeedback === "incorrect" ? "border-destructive bg-destructive/10" : ""}`}
                    onClick={() => setAtpFeedback(atpFeedback === "incorrect" ? null : "incorrect")}
                    data-testid="button-atp-incorrect"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                    Incorrect
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 ${atpFeedback === "undetermined" ? "border-muted-foreground bg-muted" : ""}`}
                    onClick={() => setAtpFeedback(atpFeedback === "undetermined" ? null : "undetermined")}
                    data-testid="button-atp-undetermined"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                    Cannot Determine
                  </Button>
                </div>
                {atpFeedback && (
                  <Textarea
                    value={atpComment}
                    onChange={(e) => setAtpComment(e.target.value)}
                    placeholder="Add optional comments about this assessment..."
                    className="mt-3 min-h-[80px]"
                    data-testid="textarea-atp-comment"
                  />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="w-4 h-4" />
                Problem Customer is Facing
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
                      <Badge
                        variant={
                          decision.problemConfidenceScore >= 7 ? "destructive" :
                          decision.problemConfidenceScore >= 4 ? "secondary" : "default"
                        }
                        data-testid="badge-problem-confidence"
                      >
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
                <Shield className="w-4 h-4" />
                Proposed Solution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {decision.internalAction && (
                <div className="flex flex-wrap gap-2">
                  <p className="text-sm leading-relaxed break-words" data-testid="text-internal-action">
                    <span className="font-medium">Internal Action: </span>{decision.internalAction}
                  </p>
                </div>
              )}
              {decision.proposedSolution && (
                <div>
                  <p className="text-sm leading-relaxed" data-testid="text-proposed-solution">{decision.proposedSolution}</p>
                  {decision.solutionConfidenceScore != null && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-muted-foreground">Confidence:</span>
                      <Badge
                        variant={
                          decision.solutionConfidenceScore >= 7 ? "default" :
                          decision.solutionConfidenceScore >= 4 ? "secondary" : "destructive"
                        }
                        data-testid="badge-solution-confidence"
                      >
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
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 ${solutionFeedback === "agree" ? "border-primary bg-primary/10" : ""}`}
                    onClick={() => setSolutionFeedback(solutionFeedback === "agree" ? null : "agree")}
                    data-testid="button-solution-agree"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                    Agree
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 ${solutionFeedback === "disagree" ? "border-destructive bg-destructive/10" : ""}`}
                    onClick={() => setSolutionFeedback(solutionFeedback === "disagree" ? null : "disagree")}
                    data-testid="button-solution-disagree"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                    Disagree
                  </Button>
                </div>
                {solutionFeedback === "disagree" && (
                  <Textarea
                    value={solutionComment}
                    onChange={(e) => setSolutionComment(e.target.value)}
                    placeholder="Please explain why you disagree with the proposed solution..."
                    className="mt-3 min-h-[80px]"
                    data-testid="textarea-solution-comment"
                  />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="w-4 h-4" />
                Proposed Email to Customer
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {decision.proposedEmailToCustomer === "NO_ACTION" || !decision.proposedEmailToCustomer ? (
                <div className="text-center py-4">
                  <Mail className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">AI recommended no email action for this customer.</p>
                </div>
              ) : (
                <>
                  <div className="bg-muted/50 rounded-md p-4">
                    <pre className="text-sm whitespace-pre-wrap font-sans" data-testid="text-proposed-email">
                      {decision.proposedEmailToCustomer}
                    </pre>
                  </div>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Do you agree with this proposed email?</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        className={`gap-1.5 ${emailFeedback === "agree" ? "border-primary bg-primary/10" : ""}`}
                        onClick={() => setEmailFeedback(emailFeedback === "agree" ? null : "agree")}
                        data-testid="button-email-agree"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                        Agree
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className={`gap-1.5 ${emailFeedback === "disagree" ? "border-destructive bg-destructive/10" : ""}`}
                        onClick={() => setEmailFeedback(emailFeedback === "disagree" ? null : "disagree")}
                        data-testid="button-email-disagree"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" />
                        Disagree
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
                </>
              )}
            </CardContent>
          </Card>

          {isPending && (
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
                      <XCircle className="w-4 h-4 mr-2" />
                      Disagree
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
