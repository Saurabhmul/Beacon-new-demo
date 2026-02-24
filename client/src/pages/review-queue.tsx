import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { ClipboardList, ArrowRight, Brain, AlertTriangle, User } from "lucide-react";
import type { Decision } from "@shared/schema";

export default function ReviewQueuePage() {
  const { data: decisions, isLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions", "pending"],
  });

  const pendingDecisions = decisions?.filter((d) => d.status === "pending") || [];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif font-bold tracking-tight" data-testid="text-review-heading">
            Review Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review AI-generated decisions and take action on each customer.
          </p>
        </div>
        <Badge variant="secondary" className="text-sm py-1 px-3">
          {pendingDecisions.length} pending
        </Badge>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : pendingDecisions.length > 0 ? (
        <div className="space-y-4">
          {pendingDecisions.map((d) => (
            <Card key={d.id} className="hover-elevate">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium text-sm" data-testid={`text-customer-${d.id}`}>
                          {d.customerGuid}
                        </span>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        Pending Review
                      </Badge>
                      {d.problemConfidenceScore && (
                        <Badge
                          variant={d.problemConfidenceScore >= 7 ? "destructive" : d.problemConfidenceScore >= 4 ? "secondary" : "default"}
                          className="text-[10px]"
                        >
                          Confidence: {d.problemConfidenceScore}/10
                        </Badge>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {d.problemDescription && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Problem</p>
                          <p className="text-xs leading-relaxed line-clamp-2">{d.problemDescription}</p>
                        </div>
                      )}
                      {d.proposedSolution && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Proposed Solution</p>
                          <p className="text-xs leading-relaxed line-clamp-2">{d.proposedSolution}</p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
                      {d.combinedCmd !== null && d.combinedCmd !== undefined && (
                        <span>CMD: {d.combinedCmd.toFixed(2)}</span>
                      )}
                      {d.abilityToPay !== null && d.abilityToPay !== undefined && (
                        <span>Ability to Pay: {d.abilityToPay.toFixed(2)}</span>
                      )}
                      {d.noOfLatestPaymentsFailed !== null && d.noOfLatestPaymentsFailed !== undefined && (
                        <span>Failed Payments: {d.noOfLatestPaymentsFailed}</span>
                      )}
                    </div>
                  </div>

                  <Link href={`/review/${d.id}`}>
                    <Button size="sm" data-testid={`button-review-${d.id}`}>
                      Review
                      <ArrowRight className="w-3.5 h-3.5 ml-1" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <ClipboardList className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium mb-1">No Pending Decisions</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Upload customer data and run AI analysis to generate decisions for review.
            </p>
            <Link href="/upload">
              <Button variant="outline" size="sm" data-testid="button-go-upload">
                Upload Data
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
