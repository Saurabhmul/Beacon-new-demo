import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Upload, FileUp, FileText, Loader2, CheckCircle2, Download, Search, ChevronLeft, ChevronRight, MessageSquare, CreditCard, Landmark, ArrowLeft, History, AlertCircle, Trash2, Pencil } from "lucide-react";
import type { DataUpload, ClientConfig, DataConfig } from "@shared/schema";

type UploadCategory = "loan_data" | "payment_history" | "conversation_history";

interface UploadLogEntry {
  id: number;
  dataUploadId: number | null;
  userId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  recordCount: number;
  processedCount: number;
  failedCount: number;
  uploadCategory: string;
  createdAt: string;
  uploaderEmail: string;
}

const CATEGORY_META: Record<UploadCategory, { label: string; icon: typeof Landmark; description: string }> = {
  loan_data: {
    label: "Loan Data",
    icon: Landmark,
    description: "Upload loan portfolio data with customer details, DPD buckets, and outstanding amounts.",
  },
  payment_history: {
    label: "Payment History",
    icon: CreditCard,
    description: "Upload payment transaction history for customers.",
  },
  conversation_history: {
    label: "Conversation History",
    icon: MessageSquare,
    description: "Upload customer interaction and conversation logs.",
  },
};

const PAGE_SIZE = 50;

const FIELD_ORDER: Record<UploadCategory, string[]> = {
  loan_data: ["customer / account / loan id", "dpd_bucket", "amount_due", "minimum_due", "due_date"],
  payment_history: ["customer / account / loan id", "payment_reference", "date_of_payment", "amount_paid", "payment_status"],
  conversation_history: ["customer / account / loan id", "date_and_timestamp", "message"],
};

function UploadHistoryView({ category, onBack }: {
  category: UploadCategory;
  onBack: () => void;
}) {
  const meta = CATEGORY_META[category];

  const { data: logs = [], isLoading } = useQuery<UploadLogEntry[]>({
    queryKey: ["/api/upload-logs", category],
    queryFn: async () => {
      const res = await fetch(`/api/upload-logs?category=${category}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 px-2" data-testid={`button-back-${category}`}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to {meta.label}
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="w-4 h-4" />
            Upload History — {meta.label}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : logs.length === 0 ? (
            <div className="text-center py-8">
              <History className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No upload history yet.</p>
            </div>
          ) : (
            <div className="border rounded-md overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs whitespace-nowrap">Date & Time</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">File Name</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Uploaded By</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-center">Records</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-center">Processed</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-center">Failed</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-center">Download</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id} data-testid={`row-log-${log.id}`}>
                      <TableCell className="text-xs py-2 whitespace-nowrap">{formatDate(log.createdAt)}</TableCell>
                      <TableCell className="text-xs py-2 whitespace-nowrap max-w-[200px] truncate">
                        <div className="flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          {log.fileName}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2 whitespace-nowrap">{log.uploaderEmail}</TableCell>
                      <TableCell className="text-xs py-2 text-center">{log.recordCount}</TableCell>
                      <TableCell className="text-xs py-2 text-center">
                        <Badge variant="outline" className="text-[10px] text-green-600 border-green-200 bg-green-50">
                          <CheckCircle2 className="w-3 h-3 mr-0.5" />
                          {log.processedCount}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs py-2 text-center">
                        {log.failedCount > 0 ? (
                          <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 bg-red-50">
                            <AlertCircle className="w-3 h-3 mr-0.5" />
                            {log.failedCount}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => window.open(`/api/upload-logs/${log.id}/download`, "_blank")}
                          data-testid={`button-download-log-${log.id}`}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UploadSection({ category, dataConfig }: {
  category: UploadCategory;
  dataConfig?: DataConfig | null;
}) {
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<"main" | "history">("main");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingRow, setEditingRow] = useState<{ index: number; data: Record<string, string> } | null>(null);

  const meta = CATEGORY_META[category];
  const Icon = meta.icon;

  const { data: uploads = [], isLoading } = useQuery<DataUpload[]>({
    queryKey: ["/api/uploads", category],
    queryFn: async () => {
      const res = await fetch(`/api/uploads?category=${category}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("No file selected");
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("category", category);
      const res = await fetch("/api/uploads", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/uploads", category] });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/upload-logs", category] });
      toast({ title: "File uploaded", description: `${meta.label} has been uploaded and validated.` });
      setSelectedFile(null);
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (indices: number[]) => {
      const res = await fetch(`/api/uploads/${category}/records`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ indices }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Delete failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/uploads", category] });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      toast({ title: "Records deleted", description: `${data.deletedCount} record(s) deleted successfully.` });
      setSelectedRows(new Set());
      setShowDeleteConfirm(false);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ index, data }: { index: number; data: Record<string, string> }) => {
      const res = await fetch(`/api/uploads/${category}/records/${index}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/uploads", category] });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      toast({ title: "Record updated", description: "The record has been updated successfully." });
      setEditingRow(null);
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith(".csv") || file.name.endsWith(".json"))) {
      setSelectedFile(file);
    } else {
      toast({ title: "Invalid file", description: "Please upload a CSV or JSON file.", variant: "destructive" });
    }
  }, [toast]);

  const downloadSampleCsv = () => {
    window.open(`/api/uploads/sample/${category}`, "_blank");
  };

  const latestUpload = uploads.length > 0 ? uploads[0] : null;

  useEffect(() => {
    setPage(1);
    setSearchQuery("");
    setSelectedRows(new Set());
  }, [latestUpload?.id]);

  const indexedRecords = useMemo(() => {
    if (!latestUpload?.uploadedData) return [];
    return (latestUpload.uploadedData as Record<string, unknown>[]).map((row, idx) => ({ ...row, __idx: idx }));
  }, [latestUpload]);

  const records = useMemo(() => {
    const recs = indexedRecords as Record<string, unknown>[];
    if (category === "payment_history") {
      return [...recs].sort((a, b) => {
        const da = String(a["date_of_payment"] || "");
        const db = String(b["date_of_payment"] || "");
        return db.localeCompare(da);
      });
    }
    if (category === "conversation_history") {
      return [...recs].sort((a, b) => {
        const da = String(a["date_and_timestamp"] || "");
        const db = String(b["date_and_timestamp"] || "");
        return db.localeCompare(da);
      });
    }
    return recs;
  }, [indexedRecords, category]);

  const columns = useMemo(() => {
    if (records.length === 0) return [];
    const allKeys = Object.keys(records[0]).filter(k => k !== "__idx");
    const mandatoryFields = FIELD_ORDER[category] || [];
    let optionalFields: string[] = [];
    if (category === "loan_data" && dataConfig?.optionalFields) {
      optionalFields = (dataConfig.optionalFields as string[]).filter(f => f !== "conversation_history");
    } else if (category === "payment_history" && dataConfig?.paymentAdditionalFields) {
      optionalFields = dataConfig.paymentAdditionalFields as string[];
    }
    const knownOrder = [...mandatoryFields, ...optionalFields];
    const ordered = knownOrder.filter(f => allKeys.includes(f));
    const remaining = allKeys.filter(f => !knownOrder.includes(f));
    return [...ordered, ...remaining];
  }, [records, category, dataConfig]);

  const idColumn = useMemo(() => {
    return columns.find(c =>
      c.toLowerCase().includes("customer") ||
      c.toLowerCase().includes("account") ||
      c.toLowerCase().includes("loan") ||
      c === "customer / account / loan id"
    ) || columns[0] || "";
  }, [columns]);

  const filteredRecords = useMemo(() => {
    let result = records;
    if (searchQuery.trim() && idColumn) {
      const q = searchQuery.toLowerCase();
      result = result.filter(r => {
        const val = String(r[idColumn] || "").toLowerCase();
        return val.includes(q);
      });
    }
    return result;
  }, [records, searchQuery, idColumn]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const paginatedRecords = filteredRecords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (viewMode === "history") {
    return <UploadHistoryView category={category} onBack={() => setViewMode("main")} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">{meta.label}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setViewMode("history")} data-testid={`button-track-uploads-${category}`}>
            <History className="w-3.5 h-3.5 mr-1.5" />
            Track Uploads
          </Button>
          <Button variant="outline" size="sm" onClick={downloadSampleCsv} data-testid={`button-download-sample-${category}`}>
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Download Sample CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
            className="border-2 border-dashed border-border rounded-md p-6 text-center transition-colors hover:border-primary/50"
          >
            {selectedFile ? (
              <div className="space-y-3">
                <FileUp className="w-8 h-8 text-primary mx-auto" />
                <p className="text-sm font-medium">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                <div className="flex items-center justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelectedFile(null)} data-testid={`button-remove-${category}`}>
                    Remove
                  </Button>
                  <Button size="sm" onClick={() => uploadMutation.mutate()} disabled={uploadMutation.isPending} data-testid={`button-upload-${category}`}>
                    {uploadMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                    Upload
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="w-8 h-8 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">{meta.description}</p>
                <label>
                  <input
                    type="file"
                    accept=".csv,.json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) setSelectedFile(file);
                    }}
                    data-testid={`input-file-${category}`}
                  />
                  <Button variant="outline" size="sm" asChild>
                    <span>Browse Files</span>
                  </Button>
                </label>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : records.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Current Data</CardTitle>
              <div className="flex items-center gap-2">
                {selectedRows.size > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs"
                    onClick={() => setShowDeleteConfirm(true)}
                    data-testid={`button-delete-selected-${category}`}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    Delete {selectedRows.size} selected
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 text-xs"
                  onClick={() => {
                    const csvHeader = columns.join(",");
                    const csvRows = records.map(row =>
                      columns.map(col => {
                        const val = String(row[col] ?? "");
                        return val.includes(",") || val.includes('"') || val.includes("\n")
                          ? `"${val.replace(/"/g, '""')}"`
                          : val;
                      }).join(",")
                    );
                    const csv = [csvHeader, ...csvRows].join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${category}_data_export.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  data-testid={`button-download-data-${category}`}
                >
                  <Download className="w-3.5 h-3.5 mr-1" />
                  Download Data
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder={`Search by ${idColumn.replace(/_/g, " ")}...`}
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                  className="pl-8 h-8 text-xs"
                  data-testid={`input-search-${category}`}
                />
              </div>
              <span className="text-xs text-muted-foreground ml-auto">
                {filteredRecords.length} of {records.length} records
              </span>
            </div>

            <div className="border rounded-md overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 px-2">
                      <Checkbox
                        checked={filteredRecords.length > 0 && filteredRecords.every((row) => selectedRows.has(row.__idx as number))}
                        ref={(el) => {
                          if (el) {
                            const someSelected = filteredRecords.some((row) => selectedRows.has(row.__idx as number));
                            const allSelected = filteredRecords.length > 0 && filteredRecords.every((row) => selectedRows.has(row.__idx as number));
                            (el as unknown as HTMLButtonElement).dataset.state = allSelected ? "checked" : someSelected ? "indeterminate" : "unchecked";
                          }
                        }}
                        onCheckedChange={(checked) => {
                          const next = new Set(selectedRows);
                          filteredRecords.forEach((row) => {
                            const idx = row.__idx as number;
                            if (checked) next.add(idx);
                            else next.delete(idx);
                          });
                          setSelectedRows(next);
                        }}
                        data-testid={`checkbox-select-all-${category}`}
                      />
                    </TableHead>
                    {columns.map((col) => (
                      <TableHead key={col} className="text-xs whitespace-nowrap">{col.replace(/_/g, " ")}</TableHead>
                    ))}
                    <TableHead className="w-10 text-xs">Edit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedRecords.map((row, i) => {
                    const rowIdx = row.__idx as number;
                    return (
                      <TableRow key={rowIdx} data-testid={`row-data-${category}-${i}`} className={selectedRows.has(rowIdx) ? "bg-muted/50" : ""}>
                        <TableCell className="px-2">
                          <Checkbox
                            checked={selectedRows.has(rowIdx)}
                            onCheckedChange={(checked) => {
                              const next = new Set(selectedRows);
                              if (checked) next.add(rowIdx);
                              else next.delete(rowIdx);
                              setSelectedRows(next);
                            }}
                            data-testid={`checkbox-row-${category}-${i}`}
                          />
                        </TableCell>
                        {columns.map((col) => (
                          <TableCell key={col} className="text-xs py-2 whitespace-nowrap max-w-[200px] truncate">
                            {String(row[col] ?? "")}
                          </TableCell>
                        ))}
                        <TableCell className="px-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => {
                              const rowData: Record<string, string> = {};
                              columns.forEach(col => { rowData[col] = String(row[col] ?? ""); });
                              setEditingRow({ index: rowIdx, data: rowData });
                            }}
                            data-testid={`button-edit-row-${category}-${i}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {paginatedRecords.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={columns.length + 2} className="text-center text-sm text-muted-foreground py-6">
                        No matching records found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                    data-testid={`button-prev-${category}`}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => p + 1)}
                    data-testid={`button-next-${category}`}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedRows.size} record{selectedRows.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The selected records will be permanently removed from your {meta.label.toLowerCase()} data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-${category}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(Array.from(selectedRows))}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-confirm-delete-${category}`}
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!editingRow} onOpenChange={(open) => { if (!open) setEditingRow(null); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Record</DialogTitle>
          </DialogHeader>
          {editingRow && (
            <div className="space-y-3 py-2">
              {columns.map((col) => (
                <div key={col} className="space-y-1">
                  <Label className="text-xs font-medium">{col.replace(/_/g, " ")}</Label>
                  <Input
                    value={editingRow.data[col] || ""}
                    onChange={(e) => {
                      setEditingRow({
                        ...editingRow,
                        data: { ...editingRow.data, [col]: e.target.value },
                      });
                    }}
                    className="h-8 text-sm"
                    data-testid={`input-edit-${col.replace(/\s+/g, "-")}`}
                  />
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingRow(null)} data-testid={`button-cancel-edit-${category}`}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (editingRow) {
                  editMutation.mutate({ index: editingRow.index, data: editingRow.data });
                }
              }}
              disabled={editMutation.isPending}
              data-testid={`button-save-edit-${category}`}
            >
              {editMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function UploadPage() {
  const { data: config } = useQuery<ClientConfig>({ queryKey: ["/api/client-config"] });
  const { data: dataConfig } = useQuery<DataConfig>({ queryKey: ["/api/data-config"] });
  const { data: conversationUploads = [] } = useQuery<DataUpload[]>({
    queryKey: ["/api/uploads", "conversation_history"],
    queryFn: async () => {
      const res = await fetch(`/api/uploads?category=conversation_history`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const showConversationHistory = useMemo(() => {
    const enabledInConfig = dataConfig?.optionalFields
      ? (dataConfig.optionalFields as string[]).includes("conversation_history")
      : false;
    const hasExistingData = conversationUploads.length > 0;
    return enabledInConfig || hasExistingData;
  }, [dataConfig, conversationUploads]);

  if (!config) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Card>
          <CardContent className="p-8 text-center">
            <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium mb-1">Setup Required</h3>
            <p className="text-sm text-muted-foreground">Please complete client configuration and set up a rulebook first.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const categories: UploadCategory[] = showConversationHistory
    ? ["loan_data", "payment_history", "conversation_history"]
    : ["loan_data", "payment_history"];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-upload-heading">
          Upload Data
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload structured data files for AI analysis. Each section requires specific fields — download the sample CSV for reference.
        </p>
      </div>

      <Tabs defaultValue="loan_data">
        <TabsList data-testid="tabs-upload-category">
          {categories.map((cat) => {
            const Icon = CATEGORY_META[cat].icon;
            return (
              <TabsTrigger key={cat} value={cat} data-testid={`tab-${cat}`}>
                <Icon className="w-4 h-4 mr-1.5" />
                {CATEGORY_META[cat].label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {categories.map((cat) => (
          <TabsContent key={cat} value={cat} className="mt-4">
            <UploadSection
              category={cat}
              dataConfig={dataConfig}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
