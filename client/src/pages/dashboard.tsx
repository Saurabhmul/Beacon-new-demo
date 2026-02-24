import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Settings,
  BookOpen,
  Upload,
  ClipboardList,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import type { ClientConfig, Decision } from "@shared/schema";

export default function DashboardPage() {
  const { user } = useAuth();

  const { data: config, isLoading: configLoading } = useQuery<ClientConfig>({
    queryKey: ["/api/client-config"],
  });

  const { data: stats, isLoading: statsLoading } = useQuery<{
    pending: number;
    approved: number;
    total: number;
    recentDecisions: Decision[];
  }>({
    queryKey: ["/api/decisions/stats"],
  });

  const isLoading = configLoading || statsLoading;

  const setupSteps = [
    {
      label: "Client Setup",
      done: !!config,
      href: "/config",
      icon: Settings,
      desc: "Configure your company details",
    },
    {
      label: "Action Rulebook",
      done: false,
      href: "/rulebook",
      icon: BookOpen,
      desc: "Define your SOP and collection rules",
    },
    {
      label: "Upload Data",
      done: false,
      href: "/upload",
      icon: Upload,
      desc: "Import customer CSV/JSON data",
    },
    {
      label: "Review Decisions",
      done: false,
      href: "/review",
      icon: ClipboardList,
      desc: "Review AI-generated recommendations",
    },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-serif font-bold tracking-tight" data-testid="text-dashboard-heading">
          Welcome back{user?.firstName ? `, ${user.firstName}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {config ? `Managing ${config.companyName}` : "Get started by setting up your account"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-20 mb-2" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm text-muted-foreground">Pending Review</span>
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-3xl font-bold" data-testid="text-stat-pending">{stats?.pending || 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm text-muted-foreground">Reviewed</span>
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-3xl font-bold" data-testid="text-stat-approved">{stats?.approved || 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm text-muted-foreground">Total Decisions</span>
                  <AlertCircle className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-3xl font-bold" data-testid="text-stat-total">{stats?.total || 0}</div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4">Getting Started</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {setupSteps.map((step, i) => (
            <Card key={step.label} className="hover-elevate">
              <CardContent className="p-5">
                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-md flex items-center justify-center flex-shrink-0 ${step.done ? "bg-accent" : "bg-muted"}`}>
                    <step.icon className={`w-5 h-5 ${step.done ? "text-accent-foreground" : "text-muted-foreground"}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm">{step.label}</span>
                      {step.done && <Badge variant="secondary" className="text-[10px]">Complete</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">{step.desc}</p>
                    <Link href={step.href}>
                      <Button variant="outline" size="sm" data-testid={`button-setup-${i}`}>
                        {step.done ? "View" : "Configure"}
                        <ArrowRight className="w-3.5 h-3.5 ml-1" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {stats && stats.recentDecisions && stats.recentDecisions.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold">Recent Decisions</h2>
            <Link href="/review">
              <Button variant="outline" size="sm" data-testid="button-view-all-history">
                View All
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </Link>
          </div>
          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {stats.recentDecisions.slice(0, 5).map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate" data-testid={`text-decision-id-${d.id}`}>{d.customerGuid}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {d.proposedSolution ? d.proposedSolution.substring(0, 60) + "..." : "Pending analysis"}
                      </div>
                    </div>
                    <Badge variant={d.status === "pending" ? "secondary" : d.status === "approved" ? "default" : "destructive"}>
                      {d.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
