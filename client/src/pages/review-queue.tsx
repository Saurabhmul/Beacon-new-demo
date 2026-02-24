import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  ClipboardList,
  ArrowRight,
  Search,
  User,
  Eye,
  CheckCircle2,
  XCircle,
  Upload,
} from "lucide-react";
import type { Decision } from "@shared/schema";

type TabType = "pending" | "completed";

export default function ReviewQueuePage() {
  const [activeTab, setActiveTab] = useState<TabType>("pending");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: pendingData, isLoading: pendingLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions", "pending"],
  });

  const { data: allData, isLoading: allLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions", "all"],
  });

  const pendingDecisions = pendingData?.filter((d) => d.status === "pending") || [];
  const completedDecisions = allData?.filter((d) => d.status !== "pending") || [];

  const isLoading = activeTab === "pending" ? pendingLoading : allLoading;
  const currentDecisions = activeTab === "pending" ? pendingDecisions : completedDecisions;

  const filteredDecisions = currentDecisions.filter((d) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      d.customerGuid.toLowerCase().includes(q) ||
      d.problemDescription?.toLowerCase().includes(q) ||
      d.proposedSolution?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-review-heading">
          Review Queue
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Validate Beacon's recommendations before execution.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setActiveTab("pending")}
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
          onClick={() => setActiveTab("completed")}
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
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search GUID, Customer..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-decisions"
              />
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-3 pb-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredDecisions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>GUID</TableHead>
                  <TableHead>Requested Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>AI Recommendation</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDecisions.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="font-medium text-sm font-mono" data-testid={`text-guid-${d.id}`}>
                        {d.customerGuid.length > 12 ? d.customerGuid.substring(0, 12) + "..." : d.customerGuid}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(d.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <User className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-sm" data-testid={`text-customer-${d.id}`}>
                          {d.customerGuid}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {activeTab === "completed" ? (
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
                      ) : (
                        <span className="text-sm line-clamp-1">
                          {d.proposedSolution ? d.proposedSolution.substring(0, 50) + "..." : "Pending"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.solutionConfidenceScore !== null && d.solutionConfidenceScore !== undefined ? (
                        <Badge
                          variant={d.solutionConfidenceScore >= 7 ? "default" : d.solutionConfidenceScore >= 4 ? "secondary" : "destructive"}
                          className="text-[10px]"
                        >
                          {d.solutionConfidenceScore}/10
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/review/${d.id}`}>
                        <Button
                          variant={activeTab === "pending" ? "default" : "outline"}
                          size="sm"
                          data-testid={`button-action-${d.id}`}
                        >
                          {activeTab === "pending" ? (
                            <>Review <ArrowRight className="w-3.5 h-3.5 ml-1" /></>
                          ) : (
                            <><Eye className="w-3.5 h-3.5 mr-1" /> View</>
                          )}
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="py-12 text-center">
              <ClipboardList className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? "No cases found matching your filters."
                  : activeTab === "pending"
                  ? "No pending decisions. Upload data to generate recommendations."
                  : "No completed reviews yet."}
              </p>
              {!searchQuery && activeTab === "pending" && (
                <Link href="/upload">
                  <Button variant="outline" size="sm" className="mt-4" data-testid="button-go-upload">
                    <Upload className="w-3.5 h-3.5 mr-1" />
                    Upload Data
                  </Button>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
