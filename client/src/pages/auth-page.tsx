import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Zap, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

type AuthTab = "login" | "register";

export default function AuthPage() {
  const [tab, setTab] = useState<AuthTab>("login");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const inviteToken = params.get("invite");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [invitePassword, setInvitePassword] = useState("");
  const [inviteConfirmPassword, setInviteConfirmPassword] = useState("");

  const { data: inviteData, isLoading: inviteLoading, error: inviteError } = useQuery({
    queryKey: ["/api/auth/invite", inviteToken],
    queryFn: async () => {
      if (!inviteToken) return null;
      const res = await fetch(`/api/auth/invite/${inviteToken}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Invalid invitation");
      }
      return res.json();
    },
    enabled: !!inviteToken,
    retry: false,
  });

  useEffect(() => {
    if (inviteToken) {
      setTab("register");
    }
  }, [inviteToken]);

  const loginMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/login", {
        email: loginEmail,
        password: loginPassword,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      setLocation("/dashboard");
    },
    onError: (error: Error) => {
      toast({
        title: "Login failed",
        description: error.message.includes("401") ? "Invalid email or password" : error.message,
        variant: "destructive",
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!inviteToken) throw new Error("No invitation token");
      if (invitePassword.length < 8) throw new Error("Password must be at least 8 characters");
      if (invitePassword !== inviteConfirmPassword) throw new Error("Passwords do not match");

      const res = await apiRequest("POST", "/api/auth/register", {
        inviteToken,
        password: invitePassword,
        confirmPassword: inviteConfirmPassword,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      toast({ title: "Welcome!", description: "Your account has been activated." });
      setLocation("/dashboard");
    },
    onError: (error: Error) => {
      toast({
        title: "Registration failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate();
  };

  const handleInviteRegister = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate();
  };

  if (inviteToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mb-4">
              <Zap className="w-7 h-7 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-auth-title">Beacon Demo</h1>
            <p className="text-sm text-muted-foreground mt-1">Complete Your Registration</p>
          </div>

          <Card className="border-border/60">
            <CardContent className="p-6">
              {inviteLoading ? (
                <div className="flex flex-col items-center py-8 gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Verifying invitation...</p>
                </div>
              ) : inviteError ? (
                <div className="flex flex-col items-center py-8 gap-3">
                  <AlertCircle className="w-8 h-8 text-destructive" />
                  <p className="text-sm text-destructive font-medium" data-testid="text-invite-error">
                    {(inviteError as Error).message}
                  </p>
                  <Button variant="outline" onClick={() => setLocation("/auth")} data-testid="button-back-to-login">
                    Back to Login
                  </Button>
                </div>
              ) : inviteData ? (
                <form onSubmit={handleInviteRegister} className="space-y-4">
                  <div className="flex items-center gap-2 p-3 bg-primary/5 rounded-lg mb-2">
                    <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                    <p className="text-sm text-primary">You've been invited to join <strong>{inviteData.companyName}</strong></p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">First Name</Label>
                      <p className="text-sm font-medium" data-testid="text-invite-firstname">{inviteData.firstName}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Last Name</Label>
                      <p className="text-sm font-medium" data-testid="text-invite-lastname">{inviteData.lastName}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Email</Label>
                    <p className="text-sm font-medium" data-testid="text-invite-email">{inviteData.email}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Role:</Label>
                    <Badge variant="secondary" data-testid="badge-invite-role">{inviteData.role}</Badge>
                  </div>

                  <div className="border-t pt-4 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="invite-password" className="font-medium">Create Password</Label>
                      <Input
                        id="invite-password"
                        type="password"
                        placeholder="Min 8 characters"
                        value={invitePassword}
                        onChange={(e) => setInvitePassword(e.target.value)}
                        required
                        minLength={8}
                        data-testid="input-invite-password"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="invite-confirm-password" className="font-medium">Confirm Password</Label>
                      <Input
                        id="invite-confirm-password"
                        type="password"
                        placeholder="Re-enter password"
                        value={inviteConfirmPassword}
                        onChange={(e) => setInviteConfirmPassword(e.target.value)}
                        required
                        minLength={8}
                        data-testid="input-invite-confirm-password"
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    size="lg"
                    disabled={registerMutation.isPending}
                    data-testid="button-activate-account"
                  >
                    {registerMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Activating...
                      </>
                    ) : (
                      "Activate Account"
                    )}
                  </Button>
                </form>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mb-4">
            <Zap className="w-7 h-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-sans font-bold tracking-tight" data-testid="text-auth-title">Beacon Demo</h1>
          <p className="text-sm text-muted-foreground mt-1">AI-Powered Decision Engine</p>
        </div>

        <Card className="border-border/60">
          <CardContent className="p-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <p className="text-sm text-muted-foreground text-center mb-4">Welcome back! Enter your credentials</p>

              <div className="space-y-2">
                <Label htmlFor="login-email" className="font-medium">Email Address</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@example.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  required
                  data-testid="input-login-email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password" className="font-medium">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  placeholder="Enter your password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                  data-testid="input-login-password"
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={loginMutation.isPending}
                data-testid="button-sign-in"
              >
                {loginMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
