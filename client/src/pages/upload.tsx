import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, FileUp, FileText, Loader2, Brain, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import type { DataUpload, ClientConfig, Rulebook } from "@shared/schema";

export default function UploadPage() {
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processProgress, setProcessProgress] = useState(0);

  const { data: config } = useQuery<ClientConfig>({ queryKey: ["/api/client-config"] });
  const { data: rulebooks } = useQuery<Rulebook[]>({ queryKey: ["/api/rulebooks"] });
  const { data: uploads, isLoading } = useQuery<DataUpload[]>({ queryKey: ["/api/uploads"] });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("No file selected");
      const formData = new FormData();
      formData.append("file", selectedFile);
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
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      toast({ title: "File uploaded", description: "Data has been uploaded and validated." });
      setSelectedFile(null);
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const processMutation = useMutation({
    mutationFn: async (uploadId: number) => {
      setProcessing(true);
      setProcessProgress(0);

      const res = await fetch(`/api/uploads/${uploadId}/process`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Processing failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === "progress") {
                  setProcessProgress(((event.index + 1) / event.total) * 100);
                } else if (event.type === "complete") {
                  setProcessProgress(100);
                }
              } catch {}
            }
          }
        }
      }

      return true;
    },
    onSuccess: () => {
      setProcessing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions/stats"] });
      toast({ title: "Processing complete", description: "AI decisions have been generated for all customers." });
    },
    onError: (err: Error) => {
      setProcessing(false);
      toast({ title: "Processing failed", description: err.message, variant: "destructive" });
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

  if (!config) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-serif font-bold tracking-tight" data-testid="text-upload-heading">
          Upload Data
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload CSV or JSON files with customer loan and payment data.
        </p>
      </div>

      {rulebooks && rulebooks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active Rulebook</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">{rulebooks[0].title}</span>
              <Badge variant="secondary" className="text-[10px]">Active</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload Customer Data</CardTitle>
          <CardDescription>Drag and drop or browse for CSV/JSON files containing customer data.</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
            className="border-2 border-dashed border-border rounded-md p-8 text-center transition-colors"
          >
            {selectedFile ? (
              <div className="space-y-3">
                <FileUp className="w-10 h-10 text-primary mx-auto" />
                <p className="text-sm font-medium">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                <div className="flex items-center justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelectedFile(null)} data-testid="button-remove-upload">
                    Remove
                  </Button>
                  <Button size="sm" onClick={() => uploadMutation.mutate()} disabled={uploadMutation.isPending} data-testid="button-upload-file">
                    {uploadMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                    Upload
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Upload className="w-10 h-10 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">Drag & drop a CSV or JSON file here</p>
                <label>
                  <input
                    type="file"
                    accept=".csv,.json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) setSelectedFile(file);
                    }}
                    data-testid="input-data-file"
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

      {processing && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <Brain className="w-5 h-5 text-primary animate-pulse" />
              <span className="text-sm font-medium">Processing with AI...</span>
            </div>
            <Progress value={processProgress} className="h-2" />
            <p className="text-xs text-muted-foreground mt-2">
              Analyzing each customer against your rulebook. This may take a moment.
            </p>
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-3">Uploaded Files</h2>
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : uploads && uploads.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Records</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uploads.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium" data-testid={`text-upload-name-${u.id}`}>{u.fileName}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">{u.fileType}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{u.recordCount}</TableCell>
                      <TableCell>
                        <Badge
                          variant={u.status === "processed" ? "default" : u.status === "processing" ? "secondary" : "outline"}
                          className="text-[10px]"
                        >
                          {u.status === "processed" && <CheckCircle2 className="w-3 h-3 mr-1" />}
                          {u.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {u.status === "uploaded" && (
                          <Button
                            size="sm"
                            onClick={() => processMutation.mutate(u.id)}
                            disabled={processing}
                            data-testid={`button-process-${u.id}`}
                          >
                            <Brain className="w-3.5 h-3.5 mr-1.5" />
                            Analyze
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No files uploaded yet.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
