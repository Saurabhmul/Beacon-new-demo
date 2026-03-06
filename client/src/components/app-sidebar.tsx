import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LayoutDashboard,
  Settings,
  Upload,
  ClipboardList,
  LogOut,
  Zap,
  Users,
} from "lucide-react";

interface NavItem {
  title: string;
  url: string;
  icon: typeof LayoutDashboard;
  roles: string[];
}

const navItemsList: NavItem[] = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, roles: ["superadmin", "admin", "manager", "agent"] },
  { title: "Client Configuration", url: "/config", icon: Settings, roles: ["superadmin", "admin"] },
  { title: "Upload Data", url: "/upload", icon: Upload, roles: ["superadmin", "admin", "manager", "agent"] },
  { title: "Review Queue", url: "/review", icon: ClipboardList, roles: ["superadmin", "admin", "manager", "agent"] },
  { title: "Users", url: "/users", icon: Users, roles: ["superadmin", "admin", "manager"] },
];

function roleLabel(role: string) {
  switch (role) {
    case "superadmin": return "Super Admin";
    case "admin": return "Admin";
    case "manager": return "Manager";
    case "agent": return "Agent";
    default: return role;
  }
}

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout, isLoggingOut, switchCompany, isSwitchingCompany } = useAuth();

  const { data: companiesList } = useQuery<Array<{ id: string; name: string; status: string }>>({
    queryKey: ["/api/companies"],
    enabled: user?.role === "superadmin",
  });

  const userRole = user?.role || "agent";
  const navItems = navItemsList.filter(item => item.roles.includes(userRole));

  const initials = user
    ? `${user.firstName?.[0] || ""}${user.lastName?.[0] || ""}`.toUpperCase() || "U"
    : "U";

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <Link href="/dashboard" className="flex items-center gap-2.5" data-testid="link-sidebar-logo">
          <div className="w-8 h-8 rounded-md bg-sidebar-primary flex items-center justify-center">
            <Zap className="w-5 h-5 text-sidebar-primary-foreground" />
          </div>
          <div>
            <div className="font-semibold text-sm tracking-tight text-sidebar-foreground">Beacon</div>
            <div className="text-[10px] text-sidebar-foreground/50 tracking-wider uppercase">Decision Engine</div>
          </div>
        </Link>

        {user?.role === "superadmin" && companiesList && companiesList.length > 0 && (
          <div className="mt-3">
            <Select
              value={user.viewingCompanyId || ""}
              onValueChange={(val) => switchCompany(val)}
              disabled={isSwitchingCompany}
            >
              <SelectTrigger className="h-8 text-xs text-sidebar-foreground bg-sidebar-accent border-sidebar-border" data-testid="select-company-switcher">
                <SelectValue placeholder="Select a Company" />
              </SelectTrigger>
              <SelectContent>
                {companiesList.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-[10px] uppercase tracking-widest px-4">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = location === item.url || (item.url !== "/dashboard" && location.startsWith(item.url));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild data-active={isActive} className={isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}>
                      <Link href={item.url} data-testid={`link-nav-${item.title.replace(/\s+/g, '-').toLowerCase()}`}>
                        <item.icon className="w-4 h-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3 mb-3">
          <Avatar className="w-8 h-8">
            <AvatarImage src={user?.profileImageUrl || undefined} />
            <AvatarFallback className="text-xs bg-sidebar-accent text-sidebar-accent-foreground">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-sidebar-foreground truncate" data-testid="text-user-name">
              {user?.firstName ? `${user.firstName} ${user.lastName || ""}`.trim() : "User"}
            </div>
            <div className="text-[11px] text-sidebar-foreground/50 truncate" data-testid="text-user-email">
              {user?.email || ""}
            </div>
            <Badge variant="outline" className="text-[9px] mt-0.5 h-4 px-1.5" data-testid="badge-user-role">
              {roleLabel(userRole)}
            </Badge>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 text-sidebar-foreground border-sidebar-border"
          data-testid="button-logout"
          onClick={() => logout()}
          disabled={isLoggingOut}
        >
          <LogOut className="w-3.5 h-3.5" />
          {isLoggingOut ? "Signing out..." : "Sign Out"}
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
