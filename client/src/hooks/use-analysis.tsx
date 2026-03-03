import { createContext, useContext, useState, useRef, useCallback, type ReactNode } from "react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AnalysisProgress {
  completed: number;
  failed: number;
  total: number;
}

interface AnalysisContextType {
  analyzing: boolean;
  progress: AnalysisProgress | null;
  startAnalysis: () => void;
}

const AnalysisContext = createContext<AnalysisContextType | null>(null);

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  const startAnalysis = useCallback(async () => {
    if (abortRef.current) return;
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
    <AnalysisContext.Provider value={{ analyzing, progress, startAnalysis }}>
      {children}
    </AnalysisContext.Provider>
  );
}

export function useAnalysis() {
  const context = useContext(AnalysisContext);
  if (!context) {
    throw new Error("useAnalysis must be used within an AnalysisProvider");
  }
  return context;
}
