import { useState, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
  Upload,
  Play,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { Decision } from "@shared/schema";

type TabType = "pending" | "completed";

const PAGE_SIZE = 25;

export default function ReviewQueuePage() {
  const [activeTab, setActiveTab] = useState<TabType>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; failed: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

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
      d.proposedSolution?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.max(1, Math.ceil(filteredDecisions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * PAGE_SIZE;
  const pageDecisions = filteredDecisions.slice(startIdx, startIdx + PAGE_SIZE);

  const startAnalysis = useCallback(async () => {
    setAnalyzing(true);
    setProgress(null);
    abortRef.current = new AbortController();

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Analysis failed");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "start") {
              setProgress({ completed: 0, failed: 0, total: event.total });
            } else if (event.type === "progress" || event.type === "error") {
              setProgress({ completed: event.completed, failed: event.failed, total: event.total });
              queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
            } else if (event.type === "complete") {
              setProgress({ completed: event.completed, failed: event.failed, total: event.total });
              queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
              queryClient.invalidateQueries({ queryKey: ["/api/decisions/stats"] });
              toast({
                title: "Analysis complete",
                description: `${event.completed} customers analyzed${event.failed > 0 ? `, ${event.failed} failed` : ""}.`,
              });
            }
          } catch {}
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        toast({
          title: "Analysis failed",
          description: err.message || "Something went wrong.",
          variant: "destructive",
        });
      }
    } finally {
      setAnalyzing(false);
      abortRef.current = null;
    }
  }, [toast]);

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
        <Button
          onClick={startAnalysis}
          disabled={analyzing}
          data-testid="button-start-analyzing"
        >
          {analyzing ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing...</>
          ) : (
            <><Play className="w-4 h-4 mr-2" /> Start Analyzing</>
          )}
        </Button>
      </div>

      {analyzing && progress && (
        <Card>
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
          onClick={() => { setActiveTab("pending"); setPage(1); }}
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
          onClick={() => { setActiveTab("completed"); setPage(1); }}
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
                placeholder="Search by Customer ID or Proposed Action..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
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
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer ID</TableHead>
                    <TableHead>Last AI Run Date</TableHead>
                    <TableHead>Proposed Action</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageDecisions.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <span className="font-medium text-sm font-mono" data-testid={`text-customer-id-${d.id}`}>
                          {d.customerGuid}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground" data-testid={`text-run-date-${d.id}`}>
                        {new Date(d.createdAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm line-clamp-1" data-testid={`text-proposed-action-${d.id}`}>
                          {d.proposedSolution
                            ? d.proposedSolution.length > 80
                              ? d.proposedSolution.substring(0, 80) + "..."
                              : d.proposedSolution
                            : "Pending"}
                        </span>
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
                  ))}
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
                {searchQuery
                  ? "No cases found matching your search."
                  : activeTab === "pending"
                  ? "No pending decisions. Click 'Start Analyzing' to generate recommendations."
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
