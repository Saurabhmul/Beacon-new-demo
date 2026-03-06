import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookOpen, Upload, FileText, Save, Loader2, Trash2, Plus, File, Building2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { Rulebook, ClientConfig } from "@shared/schema";

export default function RulebookPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";
  const isReadOnly = user?.role === "superadmin" || user?.role === "manager";
  const noCompanySelected = isSuperAdmin && !user?.viewingCompanyId;
  const [title, setTitle] = useState("Default Rulebook");
  const [sopText, setSopText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeTab, setActiveTab] = useState("text");

  const { data: config } = useQuery<ClientConfig>({
    queryKey: ["/api/client-config"],
  });

  const { data: rulebooks, isLoading } = useQuery<Rulebook[]>({
    queryKey: ["/api/rulebooks"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (activeTab === "upload" && selectedFile) {
        const formData = new FormData();
        formData.append("title", title);
        formData.append("file", selectedFile);
        const res = await fetch("/api/rulebooks/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        if (!res.ok) throw new Error("Upload failed");
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/rulebooks", { title, sopText });
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rulebooks"] });
      toast({ title: "Rulebook saved", description: "Your SOP has been stored successfully." });
      setTitle("Default Rulebook");
      setSopText("");
      setSelectedFile(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save rulebook.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/rulebooks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rulebooks"] });
      toast({ title: "Deleted", description: "Rulebook removed." });
    },
  });

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.type === "application/pdf" || file.type.startsWith("image/"))) {
      setSelectedFile(file);
    } else {
      toast({ title: "Invalid file", description: "Please upload a PDF or image file.", variant: "destructive" });
    }
  }, [toast]);

  if (!config) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Card>
          <CardContent className="p-8 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium mb-1">Setup Required</h3>
            <p className="text-sm text-muted-foreground">Please configure your client details first before setting up rulebooks.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-rulebook-heading">
          Action Rulebook
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Define your early-delinquency SOP. These rules guide AI decision-making for each customer.
        </p>
      </div>

      {!isReadOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add New Rulebook / SOP</CardTitle>
            <CardDescription>Enter rules as text or upload a PDF/image document. AI will extract and use these rules.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Early Delinquency Playbook v2"
                data-testid="input-rulebook-title"
              />
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="text" data-testid="tab-text">
                  <FileText className="w-3.5 h-3.5 mr-1.5" />
                  Free Text
                </TabsTrigger>
                <TabsTrigger value="upload" data-testid="tab-upload">
                  <Upload className="w-3.5 h-3.5 mr-1.5" />
                  Upload Document
                </TabsTrigger>
              </TabsList>

              <TabsContent value="text" className="mt-4">
                <Textarea
                  value={sopText}
                  onChange={(e) => setSopText(e.target.value)}
                  placeholder="Enter your SOP rules here. For example:&#10;&#10;If customer CMD < 0.3 and mentions employment loss -> offer forbearance&#10;If DPD > 60 and no payment in 3 months -> escalate to legal&#10;If customer has made 2+ partial payments -> offer restructured plan"
                  className="min-h-[200px] text-sm"
                  data-testid="textarea-sop"
                />
              </TabsContent>

              <TabsContent value="upload" className="mt-4">
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleFileDrop}
                  className="border-2 border-dashed border-border rounded-md p-8 text-center transition-colors"
                >
                  {selectedFile ? (
                    <div className="space-y-2">
                      <File className="w-8 h-8 text-primary mx-auto" />
                      <p className="text-sm font-medium">{selectedFile.name}</p>
                      <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                      <Button variant="outline" size="sm" onClick={() => setSelectedFile(null)} data-testid="button-remove-file">
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="w-8 h-8 text-muted-foreground mx-auto" />
                      <p className="text-sm text-muted-foreground">Drag & drop a PDF or image here</p>
                      <label>
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) setSelectedFile(file);
                          }}
                          data-testid="input-file-upload"
                        />
                        <Button variant="outline" size="sm" asChild>
                          <span>Browse Files</span>
                        </Button>
                      </label>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            <div className="pt-2">
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || (!sopText && !selectedFile)}
                data-testid="button-save-rulebook"
              >
                {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Rulebook
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-3">Existing Rulebooks</h2>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : rulebooks && rulebooks.length > 0 ? (
          <div className="space-y-3">
            {rulebooks.map((rb) => (
              <Card key={rb.id} className="hover-elevate">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm" data-testid={`text-rulebook-title-${rb.id}`}>{rb.title}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {rb.sopFileUrl ? "Document" : "Text"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {rb.sopText ? rb.sopText.substring(0, 150) + "..." : rb.sopFileName || "Uploaded document"}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Created {new Date(rb.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {!isReadOnly && (
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteMutation.mutate(rb.id)}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-rulebook-${rb.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <BookOpen className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No rulebooks configured yet. Add your first SOP above.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
