import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListCompanies,
  getListCompaniesQueryKey,
  useOnboardCompany,
  useOffboardCompany,
  useReactivateCompany,
  useUpdateCompany,
  getListAdminUsersQueryKey,
  getListMembersQueryKey,
  type Company,
  type CompanyOnboardResult,
  type CompanyUpdate,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/screen-ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { AlertCircle, AlertTriangle, Building2, Copy, Pencil } from 'lucide-react';

/** Titles for the refusals this page can meet; the server's message is the description. */
const ERROR_TITLES: Record<string, string> = {
  COMPANY_EXISTS: 'Company number already in use',
  EMAIL_IN_USE: 'Email already in use',
  COMPANY_INACTIVE: 'Company is offboarded',
  FORBIDDEN: 'Not allowed',
};

function useApiErrorToast() {
  const { toast } = useToast();
  return (error: any, fallback: string) => {
    const code: string | undefined = error?.data?.error?.code;
    toast({
      title: (code && ERROR_TITLES[code]) || 'Something went wrong',
      description: error?.data?.error?.message || fallback,
      variant: 'destructive',
    });
  };
}

const EMPTY_FORM = {
  companyNumber: '',
  companyName: '',
  address1: '',
  address2: '',
  city: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  adminEmail: '',
  adminName: '',
  reason: '',
};

/** Blank optional fields go to the server as null rather than empty strings. */
const optional = (v: string) => (v.trim() ? v.trim() : null);

/**
 * Onboarding creates the company and its one client admin in a single
 * all-or-nothing call (FR-017). The dialog then swaps to the temporary
 * password, which the server returns exactly once; closing the dialog drops it.
 */
function OnboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apiError = useApiErrorToast();
  const onboardMutation = useOnboardCompany();
  const [form, setForm] = useState(EMPTY_FORM);
  const [result, setResult] = useState<CompanyOnboardResult | null>(null);

  const set = (field: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [field]: e.target.value });

  const close = () => {
    setForm(EMPTY_FORM);
    setResult(null);
    onClose();
  };

  const valid =
    form.companyNumber.trim().length > 0 &&
    form.companyName.trim().length > 0 &&
    form.adminEmail.includes('@') &&
    form.adminName.trim().length >= 2 &&
    form.reason.trim().length >= 3;

  const submit = () => {
    onboardMutation.mutate(
      {
        data: {
          companyNumber: form.companyNumber.trim(),
          companyName: form.companyName.trim(),
          address1: optional(form.address1),
          address2: optional(form.address2),
          city: optional(form.city),
          contactName: optional(form.contactName),
          contactPhone: optional(form.contactPhone),
          contactEmail: optional(form.contactEmail),
          clientAdmin: { email: form.adminEmail.trim(), displayName: form.adminName.trim() },
          reason: form.reason.trim(),
        },
      },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          setResult(res);
        },
        onError: (e: any) => apiError(e, 'Unable to onboard the company'),
      },
    );
  };

  const copyPassword = () => {
    if (result) {
      navigator.clipboard.writeText(result.temporaryPassword);
      toast({ title: 'Copied to clipboard' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>{result.company.companyName} onboarded</DialogTitle>
              <DialogDescription>
                Temporary password for the client admin {result.clientAdmin.email}. They must change it at first
                sign-in.
              </DialogDescription>
            </DialogHeader>
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                This password is shown only once and will not be shown again. Copy it now and share it securely.
              </AlertDescription>
            </Alert>
            <div className="flex items-center gap-2">
              <code
                className="font-mono tnum flex-1 rounded border border-border bg-muted px-3 py-2 text-sm"
                data-testid="text-onboard-password"
              >
                {result.temporaryPassword}
              </code>
              <Button variant="outline" size="icon" onClick={copyPassword} data-testid="button-copy-onboard-password">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close} data-testid="button-close-onboard">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Onboard company</DialogTitle>
              <DialogDescription>
                Creates the company and its client admin login together. If any part fails, nothing is created.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label htmlFor="onboard-number">Company number</Label>
                  <Input
                    id="onboard-number"
                    value={form.companyNumber}
                    onChange={set('companyNumber')}
                    maxLength={20}
                    className="mono-id mt-1.5"
                    data-testid="input-onboard-number"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="onboard-name">Company name</Label>
                  <Input
                    id="onboard-name"
                    value={form.companyName}
                    onChange={set('companyName')}
                    maxLength={120}
                    className="mt-1.5"
                    data-testid="input-onboard-name"
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="onboard-address1">Address line 1 (optional)</Label>
                  <Input id="onboard-address1" value={form.address1} onChange={set('address1')} maxLength={120} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="onboard-address2">Address line 2 (optional)</Label>
                  <Input id="onboard-address2" value={form.address2} onChange={set('address2')} maxLength={120} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="onboard-city">City (optional)</Label>
                  <Input id="onboard-city" value={form.city} onChange={set('city')} maxLength={80} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="onboard-contact-name">Contact name (optional)</Label>
                  <Input
                    id="onboard-contact-name"
                    value={form.contactName}
                    onChange={set('contactName')}
                    maxLength={100}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="onboard-contact-phone">Contact phone (optional)</Label>
                  <Input
                    id="onboard-contact-phone"
                    value={form.contactPhone}
                    onChange={set('contactPhone')}
                    maxLength={50}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="onboard-contact-email">Contact email (optional)</Label>
                  <Input
                    id="onboard-contact-email"
                    type="email"
                    value={form.contactEmail}
                    onChange={set('contactEmail')}
                    maxLength={100}
                    className="mt-1.5"
                  />
                </div>
              </div>
              <div className="rounded-md border border-border p-4">
                <div className="mb-3 text-sm font-semibold">Client admin</div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="onboard-admin-email">Email</Label>
                    <Input
                      id="onboard-admin-email"
                      type="email"
                      value={form.adminEmail}
                      onChange={set('adminEmail')}
                      placeholder="name@company.com"
                      className="mt-1.5"
                      data-testid="input-onboard-admin-email"
                    />
                  </div>
                  <div>
                    <Label htmlFor="onboard-admin-name">Display name</Label>
                    <Input
                      id="onboard-admin-name"
                      value={form.adminName}
                      onChange={set('adminName')}
                      className="mt-1.5"
                      data-testid="input-onboard-admin-name"
                    />
                  </div>
                </div>
              </div>
              <div>
                <Label htmlFor="onboard-reason">Reason (required, min 3 characters)</Label>
                <Textarea
                  id="onboard-reason"
                  rows={2}
                  value={form.reason}
                  onChange={set('reason')}
                  className="mt-1.5"
                  data-testid="textarea-onboard-reason"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={!valid || onboardMutation.isPending}
                data-testid="button-confirm-onboard"
              >
                {onboardMutation.isPending ? 'Onboarding…' : 'Onboard company'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The company profile fields the edit dialog carries, in the BHI Company table's order and sizes. */
const PROFILE_FIELDS = [
  'companyName',
  'address1',
  'address2',
  'city',
  'contactName',
  'contactPhone',
  'contactEmail',
  'notes',
] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];
type ProfileForm = Record<ProfileField, string>;

/** Fields only a super admin may change; client admins keep the rest up to date. */
const SUPER_ADMIN_ONLY: ReadonlySet<ProfileField> = new Set(['companyName', 'notes']);

const toProfileForm = (c: Company): ProfileForm => ({
  companyName: c.companyName,
  address1: c.address1 ?? '',
  address2: c.address2 ?? '',
  city: c.city ?? '',
  contactName: c.contactName ?? '',
  contactPhone: c.contactPhone ?? '',
  contactEmail: c.contactEmail ?? '',
  notes: c.notes ?? '',
});

/**
 * Edit a company's profile. The company number is its key and never changes.
 * A super admin may change every field; a client admin only the address and
 * contact details, so name and notes are shown but locked for them.
 * Only the fields that moved are sent, which keeps the audit entry to the change.
 */
function EditCompanyDialog({
  company,
  fullEdit,
  onClose,
}: {
  company: Company;
  fullEdit: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apiError = useApiErrorToast();
  const updateMutation = useUpdateCompany();
  const [initial] = useState(() => toProfileForm(company));
  const [form, setForm] = useState(initial);
  const [reason, setReason] = useState('');

  const set = (field: ProfileField) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [field]: e.target.value });

  const editable = (field: ProfileField) => fullEdit || !SUPER_ADMIN_ONLY.has(field);
  const changed = PROFILE_FIELDS.filter((k) => editable(k) && form[k].trim() !== initial[k].trim());
  const emailInvalid = form.contactEmail.trim() !== '' && !form.contactEmail.includes('@');
  const valid =
    changed.length > 0 && form.companyName.trim().length > 0 && !emailInvalid && reason.trim().length >= 3;

  const submit = () => {
    const data: CompanyUpdate = { reason: reason.trim() };
    for (const key of changed) {
      // Company name is required; every other field goes as null when cleared.
      if (key === 'companyName') data.companyName = form.companyName.trim();
      else data[key] = optional(form[key]);
    }
    updateMutation.mutate(
      { companyNumber: company.companyNumber, data },
      {
        onSuccess: (updated) => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          // Member rows show the company's name.
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
          toast({ title: 'Company updated', description: updated.companyName });
          onClose();
        },
        onError: (e: any) => apiError(e, 'Unable to update the company'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {company.companyName}</DialogTitle>
          <DialogDescription>
            {fullEdit
              ? 'Change the company’s profile. The company number cannot be changed. The change is recorded in the audit trail.'
              : 'Keep the company’s address and contact details up to date. Only a super admin can change the company name or notes. The change is recorded in the audit trail.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="edit-company-number">Company number</Label>
              <Input
                id="edit-company-number"
                value={company.companyNumber}
                disabled
                className="mono-id mt-1.5"
                data-testid="input-edit-company-number"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="edit-company-name">Company name</Label>
              <Input
                id="edit-company-name"
                value={form.companyName}
                onChange={set('companyName')}
                maxLength={120}
                disabled={!editable('companyName')}
                className="mt-1.5"
                data-testid="input-edit-company-name"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="edit-company-address1">Address line 1 (optional)</Label>
              <Input id="edit-company-address1" value={form.address1} onChange={set('address1')} maxLength={120} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="edit-company-address2">Address line 2 (optional)</Label>
              <Input id="edit-company-address2" value={form.address2} onChange={set('address2')} maxLength={120} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="edit-company-city">City (optional)</Label>
              <Input id="edit-company-city" value={form.city} onChange={set('city')} maxLength={80} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="edit-company-contact-name">Contact name (optional)</Label>
              <Input
                id="edit-company-contact-name"
                value={form.contactName}
                onChange={set('contactName')}
                maxLength={100}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="edit-company-contact-phone">Contact phone (optional)</Label>
              <Input
                id="edit-company-contact-phone"
                value={form.contactPhone}
                onChange={set('contactPhone')}
                maxLength={50}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="edit-company-contact-email">Contact email (optional)</Label>
              <Input
                id="edit-company-contact-email"
                type="email"
                value={form.contactEmail}
                onChange={set('contactEmail')}
                maxLength={100}
                className="mt-1.5"
              />
              {emailInvalid && (
                <p className="mt-1 text-sm text-destructive" data-testid="error-edit-company-email">
                  Enter a valid email address.
                </p>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="edit-company-notes">Notes (optional)</Label>
            <Textarea
              id="edit-company-notes"
              rows={3}
              value={form.notes}
              onChange={set('notes')}
              disabled={!editable('notes')}
              className="mt-1.5"
              data-testid="textarea-edit-company-notes"
            />
          </div>
          <div>
            <Label htmlFor="edit-company-reason">Reason (required, min 3 characters)</Label>
            <Textarea
              id="edit-company-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5"
              data-testid="textarea-edit-company-reason"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || updateMutation.isPending} data-testid="button-confirm-edit-company">
            {updateMutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Offboard or reactivate, both of which need a reason for the audit trail. */
function StatusDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apiError = useApiErrorToast();
  const offboardMutation = useOffboardCompany();
  const reactivateMutation = useReactivateCompany();
  const [reason, setReason] = useState('');

  const offboarding = company.active;
  const pending = offboardMutation.isPending || reactivateMutation.isPending;

  const submit = () => {
    const mutation = offboarding ? offboardMutation : reactivateMutation;
    mutation.mutate(
      { companyNumber: company.companyNumber, data: { reason: reason.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          // Offboarding deactivates the company's users.
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({
            title: offboarding ? 'Company offboarded' : 'Company reactivated',
            description: company.companyName,
          });
          onClose();
        },
        onError: (e: any) =>
          apiError(e, offboarding ? 'Unable to offboard the company' : 'Unable to reactivate the company'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {offboarding ? 'Offboard' : 'Reactivate'} {company.companyName}
          </DialogTitle>
          <DialogDescription>
            {offboarding
              ? 'The company is marked inactive and its client admins and HR administrators are deactivated, so nobody can sign in or make changes for it. Its members, cards and history are kept, and it can be reactivated later.'
              : 'The company becomes active again, and its client admins and HR administrators are reactivated.'}
          </DialogDescription>
        </DialogHeader>
        <div>
          <div className="mb-1 text-xs font-semibold">Reason (required, min 3 characters)</div>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="textarea-company-status-reason"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={offboarding ? 'destructive' : 'default'}
            onClick={submit}
            disabled={reason.trim().length < 3 || pending}
            data-testid="button-confirm-company-status"
          >
            {pending ? 'Saving…' : offboarding ? 'Offboard company' : 'Reactivate company'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Client companies on the platform (super admin). Every other role reaches its
 * companies through Members; this page is where companies start and end.
 */
export default function AdminCompanies() {
  const { data: companies, isLoading, error } = useListCompanies();
  const { adminUser, hasPermission } = useAuth();
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<Company | null>(null);
  const [editTarget, setEditTarget] = useState<Company | null>(null);

  // The server's rule for PATCH /companies/{n}: a super admin edits every
  // field; a client admin only address and contact details of its own company
  // (the list is already scoped to it). Nobody else edits.
  const fullEdit = hasPermission('PLATFORM_MANAGE');
  const canEdit =
    fullEdit || adminUser?.role === 'ROLE_CLIENT_ADMIN';

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Client companies and their member counts"
        action={
          <Button size="sm" onClick={() => setOnboardOpen(true)} data-testid="button-onboard-company">
            <Building2 className="mr-2 h-4 w-4" />
            Onboard company
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Unable to load companies.</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Active members</TableHead>
                  <TableHead className="text-right">Inactive members</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(6)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-20" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : companies && companies.length > 0 ? (
                  companies.map((c) => (
                    <TableRow key={c.companyNumber} data-testid={`row-company-${c.companyNumber}`}>
                      <TableCell className="mono-id font-medium">{c.companyNumber}</TableCell>
                      <TableCell>{c.companyName}</TableCell>
                      <TableCell className="tnum text-right">{c.activeMembers}</TableCell>
                      <TableCell className="tnum text-right">{c.inactiveMembers}</TableCell>
                      <TableCell>
                        <StatusPill tone={c.active ? 'success' : 'neutral'}>
                          {c.active ? 'Active' : 'Offboarded'}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {/* An offboarded company's profile is frozen until it is reactivated. */}
                          {canEdit && c.active && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditTarget(c)}
                              data-testid={`button-edit-company-${c.companyNumber}`}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setStatusTarget(c)}
                            data-testid={`button-company-status-${c.companyNumber}`}
                          >
                            {c.active ? 'Offboard' : 'Reactivate'}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No companies yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <OnboardDialog open={onboardOpen} onClose={() => setOnboardOpen(false)} />
      {statusTarget && <StatusDialog company={statusTarget} onClose={() => setStatusTarget(null)} />}
      {editTarget && (
        <EditCompanyDialog company={editTarget} fullEdit={fullEdit} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}
