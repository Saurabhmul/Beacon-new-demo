import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  User,
  Brain,
  Mail,
  AlertTriangle,
  Loader2,
  FileText,
  TrendingDown,
  Shield,
} from "lucide-react";
import type { Decision } from "@shared/schema";

export default function DecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [agentReason, setAgentReason] = useState("");
  const [emailRejectReason, setEmailRejectReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showEmailRejectForm, setShowEmailRejectForm] = useState(false);

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
      toast({ title: "Email decision recorded" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save email decision.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!decision) {
    return (
      <div className="p-6 max-w-6xl mx-auto text-center">
        <p className="text-muted-foreground">Decision not found.</p>
      </div>
    );
  }

  const isPending = decision.status === "pending";

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" onClick={() => setLocation(isPending ? "/review" : "/history")} data-testid="button-back">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-sans font-bold tracking-tight" data-testid="text-decision-heading">
              Customer: {decision.customerGuid}
            </h1>
            <Badge variant={decision.status === "pending" ? "outline" : decision.agentAgreed ? "default" : "destructive"}>
              {decision.status === "pending" ? "Pending Review" : decision.agentAgreed ? "Approved" : "Rejected"}
            </Badge>
          </div>
        </div>
      </div>

      <Tabs defaultValue="analysis">
        <TabsList>
          <TabsTrigger value="analysis" data-testid="tab-analysis">
            <Brain className="w-3.5 h-3.5 mr-1.5" />
            AI Analysis
          </TabsTrigger>
          <TabsTrigger value="customer" data-testid="tab-customer">
            <User className="w-3.5 h-3.5 mr-1.5" />
            Customer Data
          </TabsTrigger>
          <TabsTrigger value="email" data-testid="tab-email">
            <Mail className="w-3.5 h-3.5 mr-1.5" />
            Proposed Email
          </TabsTrigger>
        </TabsList>

        <TabsContent value="analysis" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Combined CMD</p>
                <p className="text-2xl font-bold" data-testid="text-cmd">{decision.combinedCmd?.toFixed(2) ?? "N/A"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Ability to Pay</p>
                <p className="text-2xl font-bold" data-testid="text-atp">{decision.abilityToPay?.toFixed(2) ?? "N/A"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Failed Payments</p>
                <p className="text-2xl font-bold" data-testid="text-failed">{decision.noOfLatestPaymentsFailed ?? "N/A"}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                Problem Analysis
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Description</p>
                <p className="text-sm leading-relaxed" data-testid="text-problem-desc">{decision.problemDescription || "N/A"}</p>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Confidence:</p>
                <Badge variant={
                  (decision.problemConfidenceScore || 0) >= 7 ? "destructive" :
                  (decision.problemConfidenceScore || 0) >= 4 ? "secondary" : "default"
                }>
                  {decision.problemConfidenceScore}/10
                </Badge>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Evidence</p>
                <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-problem-evidence">{decision.problemEvidence || "N/A"}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Proposed Solution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Solution</p>
                <p className="text-sm leading-relaxed" data-testid="text-solution">{decision.proposedSolution || "N/A"}</p>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Confidence:</p>
                <Badge variant={
                  (decision.solutionConfidenceScore || 0) >= 7 ? "default" :
                  (decision.solutionConfidenceScore || 0) >= 4 ? "secondary" : "destructive"
                }>
                  {decision.solutionConfidenceScore}/10
                </Badge>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Evidence</p>
                <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-solution-evidence">{decision.solutionEvidence || "N/A"}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Internal Action & Ability to Pay
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Internal Action</p>
                <p className="text-sm leading-relaxed" data-testid="text-internal-action">{decision.internalAction || "N/A"}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reason for Ability to Pay Assessment</p>
                <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-atp-reason">{decision.reasonForAbilityToPay || "N/A"}</p>
              </div>
            </CardContent>
          </Card>

          {isPending && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Your Decision</CardTitle>
                <CardDescription>Do you agree with the AI recommendation?</CardDescription>
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
                    <div className="flex items-center gap-2">
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
                  <div className="flex items-center gap-3">
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
        </TabsContent>

        <TabsContent value="customer" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Raw Customer Data</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs font-mono bg-muted p-4 rounded-md overflow-auto max-h-[500px]" data-testid="text-customer-data">
                {JSON.stringify(decision.customerData, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="email" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="w-4 h-4" />
                AI-Generated Email
              </CardTitle>
              <CardDescription>Review the proposed communication to the customer.</CardDescription>
            </CardHeader>
            <CardContent>
              {decision.proposedEmailToCustomer === "NO_ACTION" ? (
                <div className="text-center py-6">
                  <Mail className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">AI recommended no email action for this customer.</p>
                </div>
              ) : (
                <div className="bg-muted/50 rounded-md p-4">
                  <pre className="text-sm whitespace-pre-wrap font-sans" data-testid="text-proposed-email">
                    {decision.proposedEmailToCustomer || "No email generated."}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {isPending && decision.proposedEmailToCustomer && decision.proposedEmailToCustomer !== "NO_ACTION" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Email Decision</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {showEmailRejectForm ? (
                  <div className="space-y-3">
                    <Textarea
                      value={emailRejectReason}
                      onChange={(e) => setEmailRejectReason(e.target.value)}
                      placeholder="Why should this email not be sent?"
                      className="min-h-[100px]"
                      data-testid="textarea-email-reject-reason"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        onClick={() => emailMutation.mutate({ emailAccepted: false, emailRejectReason })}
                        disabled={!emailRejectReason.trim() || emailMutation.isPending}
                        data-testid="button-reject-email"
                      >
                        Reject Email
                      </Button>
                      <Button variant="outline" onClick={() => setShowEmailRejectForm(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={() => emailMutation.mutate({ emailAccepted: true })}
                      disabled={emailMutation.isPending}
                      data-testid="button-accept-email"
                    >
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Approve Email
                    </Button>
                    <Button variant="outline" onClick={() => setShowEmailRejectForm(true)} data-testid="button-reject-email-form">
                      <XCircle className="w-4 h-4 mr-2" />
                      Reject Email
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
