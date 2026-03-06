import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Building2, Mail, Phone, User, Save, Loader2 } from "lucide-react";
import type { ClientConfig } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";

const formSchema = z.object({
  companyName: z.string().min(2, "Company name must be at least 2 characters"),
  contactEmail: z.string().email("Please enter a valid email"),
  contactName: z.string().min(2, "Contact name must be at least 2 characters"),
  contactPhone: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export default function ClientConfigPage() {
  const { toast } = useToast();
  const { user } = useAuth();

  const userFullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const userEmail = user?.email || "";

  const isSuperAdmin = user?.role === "superadmin";
  const noCompanySelected = isSuperAdmin && !user?.viewingCompanyId;

  const { data: config, isLoading } = useQuery<ClientConfig>({
    queryKey: ["/api/client-config"],
    enabled: !noCompanySelected,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      companyName: "",
      contactEmail: userEmail,
      contactName: userFullName,
      contactPhone: "",
    },
    values: config
      ? {
          companyName: config.companyName,
          contactEmail: userEmail,
          contactName: config.contactName,
          contactPhone: config.contactPhone || "",
        }
      : undefined,
  });

  const mutation = useMutation({
    mutationFn: async (data: FormValues) => {
      const method = config ? "PATCH" : "POST";
      const res = await apiRequest(method, "/api/client-config", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/client-config"] });
      toast({ title: "Configuration saved", description: "Your company details have been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save configuration.", variant: "destructive" });
    },
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
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
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
          Set up your company details and contact information.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Company Details</CardTitle>
          <CardDescription>This information identifies your organization in the system.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
              <FormField
                control={form.control}
                name="companyName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5" />
                      Company Name
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Financial Services" {...field} data-testid="input-company-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5" />
                      Contact Name
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="Jane Smith" {...field} data-testid="input-contact-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5" />
                      Contact Email
                    </FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="jane@acmefinancial.com" {...field} disabled className="bg-muted/50 cursor-not-allowed" data-testid="input-contact-email" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactPhone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5" />
                      Contact Phone (optional)
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="+1 (555) 000-0000" {...field} data-testid="input-contact-phone" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="pt-2">
                <Button type="submit" disabled={mutation.isPending} data-testid="button-save-config">
                  {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  {config ? "Update Configuration" : "Save Configuration"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
