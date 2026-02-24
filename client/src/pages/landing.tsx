import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, Brain, FileCheck, BarChart3, Zap, Users, ArrowRight, ChevronRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

const features = [
  {
    icon: Brain,
    title: "AI-Powered Decisioning",
    description: "Leverage Gemini AI to analyze customer data against your SOP rules, delivering consistent and explainable recommendations in seconds.",
  },
  {
    icon: FileCheck,
    title: "Custom Rulebook Engine",
    description: "Define your early-delinquency playbook with custom rules, policies, and guidelines. Upload PDFs or enter text-based SOPs.",
  },
  {
    icon: Shield,
    title: "Secure Data Processing",
    description: "Bank-grade security for sensitive financial data. Upload CSV/JSON customer records with full encryption and compliance.",
  },
  {
    icon: BarChart3,
    title: "Smart Review Queue",
    description: "Agents review AI recommendations with full customer context. Accept, modify, or override decisions with documented reasoning.",
  },
  {
    icon: Zap,
    title: "Automated Email Drafts",
    description: "AI generates personalized customer communications based on analysis. Review and approve before sending.",
  },
  {
    icon: Users,
    title: "Team Collaboration",
    description: "Managers configure rules and upload data. Agents review decisions. Full audit trail of every action taken.",
  },
];

export default function LandingPage() {
  const { isLoading } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/80 border-b border-border/50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="text-lg font-semibold tracking-tight" data-testid="text-logo">Beacon</span>
          </div>
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-muted-foreground transition-colors" data-testid="link-features">Features</a>
            <a href="#how-it-works" className="text-sm text-muted-foreground transition-colors" data-testid="link-how-it-works">How It Works</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="/auth">
              <Button variant="outline" size="sm" data-testid="button-login" disabled={isLoading}>
                Log In
              </Button>
            </a>
            <a href="/auth">
              <Button size="sm" data-testid="button-get-started" disabled={isLoading}>
                Get Started
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </a>
          </div>
        </div>
      </nav>

      <section className="pt-32 pb-20 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent text-accent-foreground text-xs font-medium mb-6" data-testid="badge-pilot">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-foreground/60" />
              Now in Pilot
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-serif font-bold tracking-tight leading-tight mb-6" data-testid="text-hero-heading">
              Intelligent Decisions for{" "}
              <span className="text-primary">Early Delinquency</span>{" "}
              Management
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed mb-8 max-w-2xl" data-testid="text-hero-subtext">
              Upload customer data, define your collection policies, and let AI recommend the right action for every borrower. Built for lenders who need consistency, speed, and compliance.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <a href="/auth">
                <Button size="lg" data-testid="button-hero-cta">
                  Start Free Pilot
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </a>
              <a href="#how-it-works">
                <Button variant="outline" size="lg" data-testid="button-hero-learn">
                  See How It Works
                </Button>
              </a>
            </div>
            <div className="flex flex-wrap items-center gap-6 mt-8 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Shield className="w-4 h-4 text-primary" />
                Bank-grade security
              </span>
              <span className="flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-primary" />
                No credit card required
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="py-20 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-serif font-bold mb-4" data-testid="text-features-heading">
              Everything You Need to Manage Delinquency
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              From data upload to AI-powered decisions and agent review, Beacon handles your entire early-delinquency workflow.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <Card key={feature.title} className="group hover-elevate">
                <CardContent className="p-6">
                  <div className="w-10 h-10 rounded-md bg-accent flex items-center justify-center mb-4">
                    <feature.icon className="w-5 h-5 text-accent-foreground" />
                  </div>
                  <h3 className="font-semibold text-base mb-2" data-testid={`text-feature-${feature.title.replace(/\s+/g, '-').toLowerCase()}`}>
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="py-20 px-6 bg-card/50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-serif font-bold mb-4" data-testid="text-how-heading">
              How Beacon Works
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Three simple steps to transform your collections workflow.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { step: "01", title: "Configure Your Rulebook", desc: "Upload your SOP, define delinquency policies, and set your data requirements. Beacon learns your collection playbook." },
              { step: "02", title: "Upload Customer Data", desc: "Import CSV or JSON files with loan, payment, and customer data. Beacon validates and processes each record automatically." },
              { step: "03", title: "Review AI Decisions", desc: "AI analyzes each customer against your rules and recommends actions. Your team reviews, approves, or adjusts with full transparency." },
            ].map((item) => (
              <div key={item.step} className="relative">
                <div className="text-6xl font-serif font-bold text-primary/10 mb-4">{item.step}</div>
                <h3 className="font-semibold text-lg mb-2" data-testid={`text-step-${item.step}`}>{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-serif font-bold mb-4">
            Ready to Transform Your Collections?
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            Join leading lenders using AI-powered decision support to improve outcomes and reduce risk.
          </p>
          <a href="/auth">
            <Button size="lg" data-testid="button-cta-bottom">
              Start Your Free Pilot
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </a>
        </div>
      </section>

      <footer className="border-t border-border py-8 px-6">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-primary-foreground" />
            </div>
            <span className="text-sm font-medium">Beacon Demo</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Inspired by Prodigy Finance. Built for modern lenders.
          </p>
        </div>
      </footer>
    </div>
  );
}
