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
} from "lucide-react";
import type { Decision } from "@shared/schema";

function parseEvidence(evidence: string | null | undefined): string[] {
  if (!evidence) return [];
  const lines = evidence.split(/[\n;•·\-]/);
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
  const loanData = (data as any).loanData || data;

  const findValue = (keys: string[]) => {
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      for (const [k, v] of Object.entries(loanData)) {
        if (k.toLowerCase().includes(lowerKey) && v != null && v !== "") {
          return String(v);
        }
      }
    }
    return null;
  };

  return {
    totalDue: findValue(["amount_due", "total_due", "totaldue", "total_amount", "outstanding", "balance"]),
    dpdBucket: findValue(["dpd", "bucket", "days_past_due", "dpd_bucket"]),
    lastPayment: findValue(["last_payment", "lastpayment", "recent_payment"]),
    loanAmount: findValue(["loan_amount", "principal", "sanctioned"]),
    minimumDue: findValue(["minimum_due", "min_due", "min_payment"]),
    dueDate: findValue(["due_date", "duedate", "payment_due"]),
    emi: findValue(["emi", "installment", "monthly_payment"]),
    product: findValue(["product", "loan_type", "category"]),
  };
}

export default function DecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [agentReason, setAgentReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [atpFeedback, setAtpFeedback] = useState<"correct" | "incorrect" | "undetermined" | null>(null);
  const [atpComment, setAtpComment] = useState("");

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
      <div className="p-6 max-w-6xl mx-auto space-y-6">
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
      <div className="p-6 max-w-6xl mx-auto text-center">
        <p className="text-muted-foreground" data-testid="text-not-found">Decision not found.</p>
      </div>
    );
  }

  const isPending = decision.status === "pending";
  const metrics = extractCustomerMetrics(decision);
  const problemBullets = parseEvidence(decision.problemEvidence);
  const solutionBullets = parseEvidence(decision.solutionEvidence);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
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
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Total Due</p>
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
              {metrics.lastPayment && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Last Payment</p>
                  <p className="text-sm" data-testid="text-last-payment">{metrics.lastPayment}</p>
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
              {metrics.loanAmount && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Loan Amount</p>
                  <p className="text-sm" data-testid="text-loan-amount">{metrics.loanAmount}</p>
                </div>
              )}
              {metrics.emi && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">EMI</p>
                  <p className="text-sm" data-testid="text-emi">{metrics.emi}</p>
                </div>
              )}
              {metrics.product && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Product</p>
                  <p className="text-sm" data-testid="text-product">{metrics.product}</p>
                </div>
              )}
              {decision.combinedCmd != null && (
                <>
                  <Separator />
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Combined CMD</p>
                    <p className="text-sm font-semibold" data-testid="text-cmd">{decision.combinedCmd.toFixed(2)}</p>
                  </div>
                </>
              )}
              {decision.noOfLatestPaymentsFailed != null && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Failed Payments</p>
                  <p className="text-sm" data-testid="text-failed-payments">{decision.noOfLatestPaymentsFailed}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="w-4 h-4" />
                Beacon Analysis
              </CardTitle>
              <div className="flex items-center gap-1.5 text-muted-foreground">
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
                  <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Key Issues Identified</p>
                  <ul className="space-y-1.5" data-testid="list-key-issues">
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
                    className={`gap-1.5 toggle-elevate ${atpFeedback === "correct" ? "toggle-elevated" : ""}`}
                    onClick={() => setAtpFeedback(atpFeedback === "correct" ? null : "correct")}
                    data-testid="button-atp-correct"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                    Correct
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 toggle-elevate ${atpFeedback === "incorrect" ? "toggle-elevated" : ""}`}
                    onClick={() => setAtpFeedback(atpFeedback === "incorrect" ? null : "incorrect")}
                    data-testid="button-atp-incorrect"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                    Incorrect
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`gap-1.5 toggle-elevate ${atpFeedback === "undetermined" ? "toggle-elevated" : ""}`}
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
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Recommended Action
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {decision.internalAction && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge data-testid="badge-action-type">{decision.internalAction}</Badge>
                </div>
              )}
              {decision.proposedSolution && (
                <div>
                  <p className="text-sm font-medium mb-1" data-testid="text-proposed-solution">{decision.proposedSolution}</p>
                  {decision.solutionConfidenceScore != null && (
                    <div className="flex items-center gap-2 mt-1">
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
