import { useState } from 'react';
import {
  useListAdminUsers,
  getListAdminUsersQueryKey,
  useCreateAdminUser,
  useUpdateAdminUser,
  useResetAdminUserPassword,
  useListCompanies,
  getListCompaniesQueryKey,
  type AdminUserSummary,
  type AdminUserCreateRole,
  type Company,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { UserPlus, MoreHorizontal, KeyRound, Copy, Pencil, UserX, UserCheck } from 'lucide-react';

const ROLES: { value: AdminUserCreateRole; label: string }[] = [
  { value: 'ROLE_PLATFORM_ADMIN', label: 'Super admin' },
  { value: 'ROLE_CLIENT_ADMIN', label: 'Client admin' },
  { value: 'ROLE_HR_ADMIN', label: 'HR administrator' },
  { value: 'ROLE_SUPPORT', label: 'Support' },
  { value: 'ROLE_AUDITOR', label: 'Auditor' },
];

/** The roles a client admin may hand out (FR-018). */
const COMPANY_ROLES: string[] = ['ROLE_CLIENT_ADMIN', 'ROLE_HR_ADMIN'];

/** HR administrators and client admins are tied to exactly one company. */
const needsCompany = (role: string) => COMPANY_ROLES.includes(role);

function roleLabel(role: string) {
  return ROLES.find((r) => r.value === role)?.label ?? role.replace('ROLE_', '').replace(/_/g, ' ');
}

/** Titles for the refusals the user endpoints return; the server's message is the description. */
const ERROR_TITLES: Record<string, string> = {
  ROLE_NOT_GRANTABLE: 'Role not allowed',
  SCOPE_REQUIRED: 'Scope required',
  SCOPE_NOT_ALLOWED: 'Scope not allowed',
  LAST_CLIENT_ADMIN: 'Last client admin',
  LAST_SUPER_ADMIN: 'Last super admin',
  LAST_ADMIN_MANAGER: 'Last user manager',
  EMAIL_IN_USE: 'Email already in use',
};

type ScopeForm = { role: string; companyScope: string };

/**
 * The scope picker that goes with the chosen role: one company for an HR
 * administrator or client admin, nothing for the rest.
 */
function ScopeFields({
  value,
  onChange,
  companies,
  testIdPrefix,
}: {
  value: ScopeForm;
  onChange: (next: Partial<ScopeForm>) => void;
  companies: Company[];
  testIdPrefix: string;
}) {
  if (needsCompany(value.role)) {
    return (
      <div>
        <Label>Company</Label>
        <Select value={value.companyScope} onValueChange={(v) => onChange({ companyScope: v })}>
          <SelectTrigger className="mt-1.5" data-testid={`select-${testIdPrefix}-scope`}>
            <SelectValue placeholder="Choose a company" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.companyNumber} value={c.companyNumber}>
                {c.companyName} ({c.companyNumber})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return <p className="text-sm text-muted-foreground">This role covers every company.</p>;
}

export default function AdminUsers() {
  const { data: users, isLoading } = useListAdminUsers();
  const { hasPermission, adminUser } = useAuth();
  const canManage = hasPermission('ADMIN_USER_MANAGE');
  const isSuperAdmin = adminUser?.role === 'ROLE_PLATFORM_ADMIN';
  // The server enforces all of this too (ROLE_NOT_GRANTABLE, 404 outside the
  // scope); offering only what will be accepted keeps people from picking
  // something that will be refused. A super admin may grant anything; a client
  // admin only client admins and HR administrators.
  const assignableRoles = isSuperAdmin ? ROLES : ROLES.filter((r) => COMPANY_ROLES.includes(r.value));
  /** Companies this admin reaches; null means every company. */
  const scopeCompanies = isSuperAdmin ? null : (adminUser?.companies ?? []);
  const inScope = (companyNumber: string | null) =>
    scopeCompanies === null || (companyNumber != null && scopeCompanies.includes(companyNumber));
  const canActOn = (user: AdminUserSummary) =>
    canManage && (isSuperAdmin || (COMPANY_ROLES.includes(user.role) && inScope(user.companyScope)));
  const { data: allCompanies } = useListCompanies({
    query: { enabled: canManage, queryKey: getListCompaniesQueryKey() },
  });
  // The list is already scoped by the server; filtering again keeps the picker
  // right even for a stale cached list.
  const companies = allCompanies?.filter((c) => inScope(c.companyNumber));
  /** A client admin has a single company, so its picker starts on it. */
  const defaultCompany = scopeCompanies?.length === 1 ? scopeCompanies[0]! : '';
  const emptyForm = { email: '', displayName: '', role: 'ROLE_HR_ADMIN', companyScope: defaultCompany };

  const companyName = (companyNumber: string) =>
    allCompanies?.find((c) => c.companyNumber === companyNumber)?.companyName;
  const scopeText = (user: AdminUserSummary) => {
    if (user.companyScope) {
      const name = companyName(user.companyScope);
      return name ? `${name} (${user.companyScope})` : user.companyScope;
    }
    return 'All companies';
  };
  /** The scope a role needs is filled in; one it must not have is dropped on submit. */
  const scopeComplete = (f: ScopeForm) =>
    !needsCompany(f.role) || f.companyScope !== '';
  const scopeBody = (f: ScopeForm) => ({
    companyScope: needsCompany(f.role) ? f.companyScope : null,
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateAdminUser();
  const updateMutation = useUpdateAdminUser();
  const resetMutation = useResetAdminUserPassword();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editUser, setEditUser] = useState<AdminUserSummary | null>(null);
  const [editForm, setEditForm] = useState({ displayName: '', role: '', companyScope: '' });
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
  const apiError = (error: any, fallback: string) => {
    const code: string | undefined = error?.data?.error?.code;
    toast({
      title: (code && ERROR_TITLES[code]) || 'Something went wrong',
      description: error?.data?.error?.message || fallback,
      variant: 'destructive',
    });
  };

  const handleCreate = () => {
    createMutation.mutate(
      {
        data: {
          email: form.email.trim(),
          displayName: form.displayName.trim(),
          role: form.role as AdminUserCreateRole,
          ...scopeBody(form),
        },
      },
      {
        onSuccess: (result) => {
          refresh();
          setCreateOpen(false);
          setForm(emptyForm);
          setTempPassword({ email: result.user.email, password: result.temporaryPassword });
        },
        onError: (e: any) => apiError(e, 'Unable to create the admin user'),
      },
    );
  };

  const handleEditSave = () => {
    if (!editUser) return;
    updateMutation.mutate(
      {
        id: editUser.id,
        data: {
          displayName: editForm.displayName.trim(),
          role: editForm.role as AdminUserCreateRole,
          ...scopeBody(editForm),
        },
      },
      {
        onSuccess: () => {
          refresh();
          setEditUser(null);
          toast({ title: 'User updated' });
        },
        onError: (e: any) => apiError(e, 'Unable to update the admin user'),
      },
    );
  };

  const handleToggleActive = (user: AdminUserSummary) => {
    updateMutation.mutate(
      { id: user.id, data: { active: !user.active } },
      {
        onSuccess: () => {
          refresh();
          toast({ title: user.active ? 'User deactivated' : 'User reactivated', description: user.email });
        },
        onError: (e: any) => apiError(e, 'Unable to change the account status'),
      },
    );
  };

  const handleResetPassword = (user: AdminUserSummary) => {
    resetMutation.mutate(
      { id: user.id },
      {
        onSuccess: (result) => setTempPassword({ email: user.email, password: result.temporaryPassword }),
        onError: (e: any) => apiError(e, 'Unable to reset the password'),
      },
    );
  };

  const copyPassword = () => {
    if (tempPassword) {
      navigator.clipboard.writeText(tempPassword.password);
      toast({ title: 'Copied to clipboard' });
    }
  };

  return (
    <div>
      <PageHeader
        title="Admin users"
        description="Portal user accounts and roles"
        action={
          canManage ? (
            <Button size="sm" onClick={() => {
                setForm(emptyForm);
                setCreateOpen(true);
              }} data-testid="button-invite-user">
              <UserPlus className="mr-2 h-4 w-4" />
              Invite user
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                {canManage && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(canManage ? 7 : 6)].map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : users && users.length > 0 ? (
                users.map((user) => (
                  <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                    <TableCell className="mono-id font-medium">{user.email}</TableCell>
                    <TableCell>{user.displayName}</TableCell>
                    <TableCell className="text-sm">{user.roleLabel || roleLabel(user.role)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{scopeText(user)}</TableCell>
                    <TableCell>
                      <Badge variant={user.active ? 'default' : 'secondary'}>
                        {user.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="mono-id whitespace-nowrap text-sm">
                      {format(new Date(user.createdAt), 'MMM d, yyyy')}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        {!canActOn(user) ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Outside what you can manage"
                            data-testid={`locked-user-${user.id}`}
                          >
                            —
                          </span>
                        ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" data-testid={`button-user-actions-${user.id}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => {
                                setEditUser(user);
                                setEditForm({
                                  displayName: user.displayName,
                                  role: user.role,
                                  companyScope: user.companyScope ?? '',
                                });
                              }}
                              data-testid={`menu-edit-${user.id}`}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit role & scope
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleResetPassword(user)} data-testid={`menu-reset-${user.id}`}>
                              <KeyRound className="mr-2 h-4 w-4" />
                              Reset password
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleToggleActive(user)} data-testid={`menu-toggle-${user.id}`}>
                              {user.active ? (
                                <>
                                  <UserX className="mr-2 h-4 w-4" />
                                  Deactivate
                                </>
                              ) : (
                                <>
                                  <UserCheck className="mr-2 h-4 w-4" />
                                  Reactivate
                                </>
                              )}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={canManage ? 7 : 6} className="h-24 text-center text-muted-foreground">
                    No users found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Invite dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite admin user</DialogTitle>
            <DialogDescription>
              A temporary password is generated and shown once. Share it securely with the invitee.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="mt-1.5"
                placeholder="name@company.com"
                data-testid="input-invite-email"
              />
            </div>
            <div>
              <Label htmlFor="invite-name">Display name</Label>
              <Input
                id="invite-name"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className="mt-1.5"
                placeholder="Jane Doe"
                data-testid="input-invite-name"
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger className="mt-1.5" data-testid="select-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ScopeFields
              value={form}
              onChange={(next) => setForm({ ...form, ...next })}
              companies={companies ?? []}
              testIdPrefix="invite"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                createMutation.isPending ||
                !form.email.includes('@') ||
                form.displayName.trim().length < 2 ||
                !scopeComplete(form)
              }
              data-testid="button-confirm-invite"
            >
              {createMutation.isPending ? 'Creating...' : 'Create account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editUser != null} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit admin user</DialogTitle>
            <DialogDescription>{editUser?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Display name</Label>
              <Input
                id="edit-name"
                value={editForm.displayName}
                onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                className="mt-1.5"
                data-testid="input-edit-name"
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={editForm.role} onValueChange={(v) => setEditForm({ ...editForm, role: v })}>
                <SelectTrigger className="mt-1.5" data-testid="select-edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ScopeFields
              value={editForm}
              onChange={(next) => setEditForm({ ...editForm, ...next })}
              companies={companies ?? []}
              testIdPrefix="edit"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={
                updateMutation.isPending || editForm.displayName.trim().length < 2 || !scopeComplete(editForm)
              }
              data-testid="button-confirm-edit"
            >
              {updateMutation.isPending ? 'Saving...' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Temporary password dialog */}
      <Dialog open={tempPassword != null} onOpenChange={(open) => !open && setTempPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>
              For {tempPassword?.email}. This is shown only once — share it securely and ask them to change it after
              signing in.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="font-mono tnum flex-1 rounded border border-border bg-muted px-3 py-2 text-sm" data-testid="text-temp-password">
              {tempPassword?.password}
            </code>
            <Button variant="outline" size="icon" onClick={copyPassword} data-testid="button-copy-password">
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setTempPassword(null)} data-testid="button-close-password">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
