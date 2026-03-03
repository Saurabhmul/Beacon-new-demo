import { createContext, useContext, useState, useRef, useCallback, type ReactNode } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const { toast } = useToast();

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    retryCountRef.current = 0;
  }, []);

  const connectSSE = useCallback(() => {
    const es = new EventSource("/api/analyze/events");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      retryCountRef.current = 0;
      try {
        const event = JSON.parse(e.data);
        if (event.type === "start") {
          setProgress({ completed: 0, failed: 0, total: event.total });
        } else if (event.type === "progress" || event.type === "error") {
          if (event.total) {
            setProgress({ completed: event.completed, failed: event.failed, total: event.total });
          }
          queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
        } else if (event.type === "complete") {
          setProgress({ completed: event.completed, failed: event.failed, total: event.total });
          queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
          queryClient.invalidateQueries({ queryKey: ["/api/decisions/stats"] });
          queryClient.invalidateQueries({ queryKey: ["/api/decisions/all"] });
          toast({
            title: "Analysis complete",
            description: `${event.completed} customers analyzed${event.failed > 0 ? `, ${event.failed} failed` : ""}.`,
          });
          cleanup();
          setAnalyzing(false);
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      retryCountRef.current++;

      if (retryCountRef.current <= 5) {
        setTimeout(() => {
          connectSSE();
        }, 1000 * retryCountRef.current);
      } else {
        cleanup();
        setAnalyzing(false);
        toast({
          title: "Connection lost",
          description: "Lost connection to analysis stream. The analysis may still be running — refresh to check.",
          variant: "destructive",
        });
      }
    };
  }, [toast, cleanup]);

  const startAnalysis = useCallback(async () => {
    if (eventSourceRef.current) return;
    setAnalyzing(true);
    setProgress(null);

    try {
      const response = await apiRequest("POST", "/api/analyze");
      const data = await response.json();

      if (!data.started) {
        throw new Error("Failed to start analysis");
      }

      connectSSE();
    } catch (err: unknown) {
      cleanup();
      setAnalyzing(false);
      if (err instanceof Error) {
        toast({
          title: "Analysis failed",
          description: err.message || "Something went wrong.",
          variant: "destructive",
        });
      }
    }
  }, [toast, cleanup, connectSSE]);

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
