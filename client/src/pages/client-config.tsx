import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Settings } from "lucide-react";
import type { ClientConfig } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";

export default function ClientConfigPage() {
  const { user } = useAuth();

  const isSuperAdmin = user?.role === "superadmin";
  const noCompanySelected = isSuperAdmin && !user?.viewingCompanyId;

  const { data: config, isLoading } = useQuery<ClientConfig>({
    queryKey: ["/api/client-config"],
    enabled: !noCompanySelected,
  });

  if (noCompanySelected) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Select a Company</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Please select a company from the dropdown in the sidebar to view client configuration.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <Card><CardContent className="p-6 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-config-heading">
          Client Configuration
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {config ? `Configuration for ${config.companyName}` : "Configure settings for this company."}
        </p>
      </div>

      <Card>
        <CardContent className="p-12 text-center">
          <Settings className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium mb-1" data-testid="text-no-config-sections">No Configuration Sections</h3>
          <p className="text-sm text-muted-foreground">Additional configuration options will appear here.</p>
        </CardContent>
      </Card>
    </div>
  );
}
