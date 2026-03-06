import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  UserPlus,
  MoreHorizontal,
  Pencil,
  UserX,
  UserCheck,
  Mail,
  Loader2,
  Users,
  Copy,
  CheckCircle2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface UserRecord {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  designation: string | null;
  companyId: string;
  companyName?: string;
  role: string;
  status: string;
  invitedBy: string | null;
  invitedByName?: string | null;
  inviteToken?: string | null;
  createdAt: string;
}

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-0" data-testid={`badge-status-${status}`}>Active</Badge>;
    case "invited":
      return <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 border-0" data-testid={`badge-status-${status}`}>Invited</Badge>;
    case "deactivated":
      return <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-0" data-testid={`badge-status-${status}`}>Deactivated</Badge>;
    default:
      return <Badge variant="outline" data-testid={`badge-status-${status}`}>{status}</Badge>;
  }
}

function roleLabel(role: string) {
  switch (role) {
    case "superadmin": return "Super Admin";
    case "admin": return "Admin";
    case "manager": return "Manager";
    case "agent": return "Agent";
    default: return role;
  }
}

export default function UsersPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deactivateDialogOpen, setDeactivateDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [inviteLinkDialog, setInviteLinkDialog] = useState<{ open: boolean; link: string; name: string }>({ open: false, link: "", name: "" });
  const [filterCompanyId, setFilterCompanyId] = useState<string>("all");

  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addDesignation, setAddDesignation] = useState("");
  const [addRole, setAddRole] = useState("");
  const [addCompanyName, setAddCompanyName] = useState("");

  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editDesignation, setEditDesignation] = useState("");
  const [editRole, setEditRole] = useState("");

  const isSuperAdmin = user?.role === "superadmin";
  const isAdmin = user?.role === "admin";
  const isManager = user?.role === "manager";

  const { data: companiesList } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/companies"],
    enabled: isSuperAdmin,
  });

  const { data: usersList, isLoading: usersLoading } = useQuery<UserRecord[]>({
    queryKey: ["/api/users", filterCompanyId],
    queryFn: async () => {
      const params = isSuperAdmin && filterCompanyId !== "all" ? `?companyId=${filterCompanyId}` : "";
      const res = await fetch(`/api/users${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
  });

  const createUserMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users", {
        firstName: addFirstName,
        lastName: addLastName,
        email: addEmail,
        designation: addDesignation,
        role: addRole,
        companyName: addCompanyName || undefined,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setAddDialogOpen(false);
      resetAddForm();
      const inviteLink = data.inviteLink;
      if (inviteLink) {
        const fullLink = `${window.location.origin}${inviteLink}`;
        setInviteLinkDialog({ open: true, link: fullLink, name: `${data.firstName} ${data.lastName}` });
      }
      toast({ title: "User created", description: `Invitation sent to ${data.email}` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create user", description: error.message, variant: "destructive" });
    },
  });

  const editUserMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUser) throw new Error("No user selected");
      const res = await apiRequest("PATCH", `/api/users/${selectedUser.id}`, {
        firstName: editFirstName,
        lastName: editLastName,
        designation: editDesignation,
        role: editRole,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setEditDialogOpen(false);
      toast({ title: "User updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update user", description: error.message, variant: "destructive" });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUser) throw new Error("No user selected");
      const endpoint = selectedUser.status === "deactivated"
        ? `/api/users/${selectedUser.id}/reactivate`
        : `/api/users/${selectedUser.id}/deactivate`;
      const res = await apiRequest("POST", endpoint);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setDeactivateDialogOpen(false);
      toast({ title: selectedUser?.status === "deactivated" ? "User reactivated" : "User deactivated" });
    },
    onError: (error: Error) => {
      toast({ title: "Action failed", description: error.message, variant: "destructive" });
    },
  });

  const resendInviteMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("POST", `/api/users/${userId}/resend-invite`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Invitation resent", description: data.message });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to resend invite", description: error.message, variant: "destructive" });
    },
  });

  function resetAddForm() {
    setAddFirstName("");
    setAddLastName("");
    setAddEmail("");
    setAddDesignation("");
    setAddRole("");
    setAddCompanyName("");
  }

  function openEdit(u: UserRecord) {
    setSelectedUser(u);
    setEditFirstName(u.firstName || "");
    setEditLastName(u.lastName || "");
    setEditDesignation(u.designation || "");
    setEditRole(u.role);
    setEditDialogOpen(true);
  }

  function openDeactivate(u: UserRecord) {
    setSelectedUser(u);
    setDeactivateDialogOpen(true);
  }

  function getRoleOptions(): { value: string; label: string }[] {
    if (isSuperAdmin) return [{ value: "superadmin", label: "Super Admin" }, { value: "admin", label: "Admin" }];
    if (isAdmin) return [{ value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "agent", label: "Agent" }];
    if (isManager) return [{ value: "agent", label: "Agent" }];
    return [];
  }

  function getEditRoleOptions(): { value: string; label: string }[] {
    if (isSuperAdmin) return [{ value: "superadmin", label: "Super Admin" }, { value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "agent", label: "Agent" }];
    if (isAdmin) return [{ value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "agent", label: "Agent" }];
    return [];
  }

  function canEdit(u: UserRecord) {
    if (u.id === user?.id) return false;
    if (isSuperAdmin) return true;
    if (isAdmin && u.companyId === user?.companyId && u.role !== "superadmin" && u.role !== "admin") return true;
    return false;
  }

  function canDeactivate(u: UserRecord) {
    if (u.id === user?.id) return false;
    if (isSuperAdmin) return true;
    if (isAdmin && u.companyId === user?.companyId && u.role !== "superadmin" && u.role !== "admin") return true;
    return false;
  }

  const showCompanyColumn = isSuperAdmin;
  const showCompanyNameField = isSuperAdmin && addRole === "admin";
  const lockCompanyName = isSuperAdmin && addRole === "superadmin";

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-users-title">
            <Users className="w-6 h-6" />
            User Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Manage team members and their access</p>
        </div>
        <div className="flex items-center gap-3">
          {isSuperAdmin && companiesList && (
            <Select value={filterCompanyId} onValueChange={setFilterCompanyId}>
              <SelectTrigger className="w-48" data-testid="select-filter-company">
                <SelectValue placeholder="All Companies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Companies</SelectItem>
                {companiesList.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button onClick={() => setAddDialogOpen(true)} data-testid="button-add-user">
            <UserPlus className="w-4 h-4 mr-2" />
            Add User
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {usersLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !usersList?.length ? (
            <div className="p-12 text-center text-muted-foreground">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  {showCompanyColumn && <TableHead>Company</TableHead>}
                  <TableHead>Role</TableHead>
                  <TableHead>Designation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Added By</TableHead>
                  <TableHead>Date Added</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersList.map((u) => (
                  <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                    <TableCell className="font-medium" data-testid={`text-user-name-${u.id}`}>
                      {u.firstName} {u.lastName}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm" data-testid={`text-user-email-${u.id}`}>{u.email}</TableCell>
                    {showCompanyColumn && <TableCell className="text-sm">{u.companyName || "-"}</TableCell>}
                    <TableCell>
                      <Badge variant="secondary" className="text-xs" data-testid={`badge-role-${u.id}`}>
                        {roleLabel(u.role)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.designation || "-"}</TableCell>
                    <TableCell>{statusBadge(u.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.invitedByName || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "-"}
                    </TableCell>
                    <TableCell>
                      {(canEdit(u) || canDeactivate(u) || u.status === "invited") && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-actions-${u.id}`}>
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canEdit(u) && (
                              <DropdownMenuItem onClick={() => openEdit(u)} data-testid={`action-edit-${u.id}`}>
                                <Pencil className="w-4 h-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                            )}
                            {canDeactivate(u) && u.status !== "deactivated" && (
                              <DropdownMenuItem onClick={() => openDeactivate(u)} className="text-destructive" data-testid={`action-deactivate-${u.id}`}>
                                <UserX className="w-4 h-4 mr-2" />
                                Deactivate
                              </DropdownMenuItem>
                            )}
                            {canDeactivate(u) && u.status === "deactivated" && (
                              <DropdownMenuItem onClick={() => openDeactivate(u)} data-testid={`action-reactivate-${u.id}`}>
                                <UserCheck className="w-4 h-4 mr-2" />
                                Reactivate
                              </DropdownMenuItem>
                            )}
                            {u.status === "invited" && (
                              <DropdownMenuItem
                                onClick={() => resendInviteMutation.mutate(u.id)}
                                disabled={resendInviteMutation.isPending}
                                data-testid={`action-resend-${u.id}`}
                              >
                                <Mail className="w-4 h-4 mr-2" />
                                Resend Invite
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add New User</DialogTitle>
            <DialogDescription>Send an invitation to a new team member</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createUserMutation.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>First Name</Label>
                <Input
                  value={addFirstName}
                  onChange={(e) => setAddFirstName(e.target.value)}
                  required
                  minLength={2}
                  data-testid="input-add-firstname"
                />
              </div>
              <div className="space-y-2">
                <Label>Last Name</Label>
                <Input
                  value={addLastName}
                  onChange={(e) => setAddLastName(e.target.value)}
                  required
                  minLength={2}
                  data-testid="input-add-lastname"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                required
                data-testid="input-add-email"
              />
            </div>

            <div className="space-y-2">
              <Label>Designation</Label>
              <Input
                value={addDesignation}
                onChange={(e) => setAddDesignation(e.target.value)}
                placeholder="e.g. Collections Analyst"
                required
                data-testid="input-add-designation"
              />
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={addRole} onValueChange={setAddRole} required>
                <SelectTrigger data-testid="select-add-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {getRoleOptions().map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {showCompanyNameField && (
              <div className="space-y-2">
                <Label>Company Name</Label>
                <Input
                  value={addCompanyName}
                  onChange={(e) => setAddCompanyName(e.target.value)}
                  placeholder="Enter or select company name"
                  required
                  data-testid="input-add-company"
                />
              </div>
            )}

            {lockCompanyName && (
              <div className="space-y-2">
                <Label>Company</Label>
                <Input value="Prodigy Finance" disabled data-testid="input-add-company-locked" />
                <p className="text-xs text-muted-foreground">Super Admin accounts are always under Prodigy Finance</p>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createUserMutation.isPending || !addRole} data-testid="button-submit-add-user">
                {createUserMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Send Invitation"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={inviteLinkDialog.open} onOpenChange={(open) => setInviteLinkDialog(prev => ({ ...prev, open }))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              Invitation Created
            </DialogTitle>
            <DialogDescription>
              Share this link with {inviteLinkDialog.name} to complete their registration.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
            <Input
              value={inviteLinkDialog.link}
              readOnly
              className="text-xs font-mono"
              data-testid="input-invite-link"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => copyToClipboard(inviteLinkDialog.link)}
              data-testid="button-copy-invite-link"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">This link expires in 7 days. No email is sent automatically — please share the link manually.</p>
          <DialogFooter>
            <Button onClick={() => setInviteLinkDialog({ open: false, link: "", name: "" })}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Update user details for {selectedUser?.email}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              editUserMutation.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>First Name</Label>
                <Input
                  value={editFirstName}
                  onChange={(e) => setEditFirstName(e.target.value)}
                  required
                  data-testid="input-edit-firstname"
                />
              </div>
              <div className="space-y-2">
                <Label>Last Name</Label>
                <Input
                  value={editLastName}
                  onChange={(e) => setEditLastName(e.target.value)}
                  required
                  data-testid="input-edit-lastname"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Email</Label>
              <Input value={selectedUser?.email || ""} disabled />
            </div>

            <div className="space-y-2">
              <Label>Designation</Label>
              <Input
                value={editDesignation}
                onChange={(e) => setEditDesignation(e.target.value)}
                data-testid="input-edit-designation"
              />
            </div>

            {getEditRoleOptions().length > 0 && (
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={editRole} onValueChange={setEditRole}>
                  <SelectTrigger data-testid="select-edit-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getEditRoleOptions().map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={editUserMutation.isPending} data-testid="button-submit-edit-user">
                {editUserMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deactivateDialogOpen} onOpenChange={setDeactivateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedUser?.status === "deactivated" ? "Reactivate User" : "Deactivate User"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedUser?.status === "deactivated"
                ? `Are you sure you want to reactivate ${selectedUser?.firstName} ${selectedUser?.lastName}? They will be able to log in again.`
                : `Are you sure you want to deactivate ${selectedUser?.firstName} ${selectedUser?.lastName}? They will no longer be able to log in.`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deactivateMutation.mutate()}
              className={selectedUser?.status !== "deactivated" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              data-testid="button-confirm-deactivate"
            >
              {deactivateMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              {selectedUser?.status === "deactivated" ? "Reactivate" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
