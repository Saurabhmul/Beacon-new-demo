import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { History, ArrowRight, CheckCircle2, XCircle, Eye } from "lucide-react";
import type { Decision } from "@shared/schema";

export default function DecisionHistoryPage() {
  const { data: decisions, isLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions", "all"],
  });

  const reviewedDecisions = decisions?.filter((d) => d.status !== "pending") || [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-history-heading">
          Decision History
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          View all past decisions and their review outcomes.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : reviewedDecisions.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>CMD</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Reviewed</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewedDecisions.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="font-medium text-sm" data-testid={`text-history-customer-${d.id}`}>
                        {d.customerGuid}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={d.agentAgreed ? "default" : "destructive"}
                        className="text-[10px]"
                      >
                        {d.agentAgreed ? (
                          <><CheckCircle2 className="w-3 h-3 mr-1" /> Approved</>
                        ) : (
                          <><XCircle className="w-3 h-3 mr-1" /> Rejected</>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {d.combinedCmd?.toFixed(2) ?? "N/A"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {d.solutionConfidenceScore ?? "N/A"}/10
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {d.reviewedAt ? new Date(d.reviewedAt).toLocaleDateString() : "N/A"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/review/${d.id}`}>
                        <Button variant="outline" size="sm" data-testid={`button-view-${d.id}`}>
                          <Eye className="w-3.5 h-3.5 mr-1" />
                          View
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <History className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium mb-1">No Decision History</h3>
            <p className="text-sm text-muted-foreground">
              Reviewed decisions will appear here once agents have processed the review queue.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
