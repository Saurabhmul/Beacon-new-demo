import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAnalysis } from "@/hooks/use-analysis";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "lucide-react";
import type { Decision } from "@shared/schema";

type TabType = "pending" | "completed";

const PAGE_SIZE = 25;

export default function ReviewQueuePage() {
  const [activeTab, setActiveTab] = useState<TabType>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  const { analyzing, progress, startAnalysis } = useAnalysis();

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
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
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
    onSettled: () => {
      setDeleting(false);
    },
  });

  const handleBulkDelete = () => {
    const count = selectedIds.size;
    if (count === 0) return;
    if (!window.confirm(`Are you sure you want to delete ${count} selected decision${count > 1 ? "s" : ""}? This cannot be undone.`)) return;
    deleteMutation.mutate(Array.from(selectedIds));
  };

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
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by Customer ID or Proposed Action..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); clearSelection(); }}
                className="pl-9"
                data-testid="input-search-decisions"
              />
            </div>
            {selectedIds.size > 0 && (
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
                  <><Trash2 className="w-4 h-4 mr-1" /> Delete Selected ({selectedIds.size})</>
                )}
              </Button>
            )}
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
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all on this page"
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                    <TableHead>Customer ID</TableHead>
                    <TableHead>Last AI Run Date</TableHead>
                    <TableHead>Proposed Action</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageDecisions.map((d) => (
                    <TableRow key={d.id} className={selectedIds.has(d.id) ? "bg-muted/50" : ""}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(d.id)}
                          onCheckedChange={() => toggleSelect(d.id)}
                          aria-label={`Select ${d.customerGuid}`}
                          data-testid={`checkbox-select-${d.id}`}
                        />
                      </TableCell>
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
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
