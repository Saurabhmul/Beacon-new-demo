import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/hooks/use-auth";
import { AnalysisProvider, useAnalysis } from "@/hooks/use-analysis";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import AuthPage from "@/pages/auth-page";
import DashboardPage from "@/pages/dashboard";
import ClientSetupPage from "@/pages/client-setup";
import UploadPage from "@/pages/upload";
import ReviewQueuePage from "@/pages/review-queue";
import DecisionDetailPage from "@/pages/decision-detail";

function AnalysisHeaderIndicator() {
  const { analyzing, progress } = useAnalysis();

  if (!analyzing || !progress) return null;

  const pct = Math.round(((progress.completed + progress.failed) / progress.total) * 100);

  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-md" data-testid="header-analysis-indicator">
      <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
      <span className="text-xs font-medium text-primary">
        Analyzing {progress.completed + progress.failed}/{progress.total} ({pct}%)
      </span>
      <div className="w-20">
        <Progress value={pct} className="h-1.5" />
      </div>
    </div>
  );
}

function AuthenticatedLayout() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <AnalysisProvider>
      <SidebarProvider style={style as React.CSSProperties}>
        <div className="flex h-screen w-full">
          <AppSidebar />
          <div className="flex flex-col flex-1 min-w-0">
            <header className="flex items-center gap-2 p-2 border-b h-12">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <div className="flex-1" />
              <AnalysisHeaderIndicator />
            </header>
            <main className="flex-1 overflow-auto">
              <Switch>
                <Route path="/dashboard" component={DashboardPage} />
                <Route path="/config" component={ClientSetupPage} />
                <Route path="/upload" component={UploadPage} />
                <Route path="/review" component={ReviewQueuePage} />
                <Route path="/review/:id" component={DecisionDetailPage} />
                <Route component={DashboardPage} />
              </Switch>
            </main>
          </div>
        </div>
      </SidebarProvider>
    </AnalysisProvider>
  );
}

function AppRouter() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="space-y-4 text-center">
          <Skeleton className="h-10 w-10 rounded-md mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/auth" component={AuthPage} />
        <Route path="/" component={LandingPage} />
        <Route component={LandingPage} />
      </Switch>
    );
  }

  return <AuthenticatedLayout />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppRouter />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
