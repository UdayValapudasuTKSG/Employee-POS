import { useState } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import {
  useGetMember,
  getGetMemberQueryKey,
  getListMembersQueryKey,
  getGetAdminDashboardQueryKey,
  useDeactivateMember,
  useReactivateMember,
  useCreateDependent,
  useUpdateDependent,
  useDeactivateDependent,
  useReactivateDependent,
  useCreateBeneficiary,
  useUpdateBeneficiary,
  useDeactivateBeneficiary,
  useReactivateBeneficiary,
  BeneficiaryCreateRelationship,
  DependentRelationship,
  type Beneficiary,
  type BeneficiaryCreate,
  type BeneficiaryUpdate,
  type Dependent,
  type DependentCreate,
  type DependentUpdate,
  type IdType,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ActiveBadge } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChoiceSelect } from '@/components/choice-select';
import {
  BENEFICIARY_RELATIONSHIP_OPTIONS,
  DEPENDANT_RELATIONSHIP_OPTIONS,
  ID_TYPE_OPTIONS,
  idTypeLabel,
  dependantAsksSex,
  dependantSexFor,
  relationshipLabel,
} from '@/lib/member-vocab';
import { useToast } from '@/hooks/use-toast';
import { PolicyPanel } from '@/components/policy-panel';
import { canSeePolicy } from '@/lib/policy-visibility';
import { isFutureDate, TODAY } from '@/lib/dates';
import { ArrowLeft, Edit, RotateCcw, AlertCircle, AlertTriangle, Plus, Pencil, UserX } from 'lucide-react';
import { format, parseISO } from 'date-fns';

/**
 * Renders a date that may be absent or unparseable without throwing. parseISO
 * reads a bare YYYY-MM-DD as a local date; `new Date` would read it as UTC and
 * show the day before in Guyana.
 */
function showDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseISO(value);
  return Number.isNaN(d.getTime()) ? value : format(d, 'MMM d, yyyy');
}

/** One label/value pair in the information card. */
function Detail({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'mono-id font-medium' : 'font-medium'}>{value}</div>
    </div>
  );
}

/** M / F as words; anything else the importer kept is shown as stored. */
function sexText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value === 'M' ? 'Male' : value === 'F' ? 'Female' : value;
}

/** Blank optional text goes as null rather than an empty string. */
const orNull = (value: string) => value.trim() || null;

// The Select cannot hold an empty value, so "not recorded" has its own token.
const NONE = 'none';

/** The sex picker, with the same options as the member form. */
function SexSelect({ id, value, onChange, testId }: { id: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger id={id} className="mt-1.5" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Not recorded</SelectItem>
        <SelectItem value="M">Male</SelectItem>
        <SelectItem value="F">Female</SelectItem>
        {/* An imported value other than M / F stays selectable, so opening the
            dialog does not appear to change it. */}
        {value && value !== 'M' && value !== 'F' && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

// A share of the payout: 0–100, with at most two decimal places (the column is
// a plain numeric; the server checks the range).
const SHARE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const shareValid = (value: string) =>
  value.trim() === '' || (SHARE_PATTERN.test(value.trim()) && Number(value) >= 0 && Number(value) <= 100);

const emailValid = (value: string) => value.trim() === '' || value.includes('@');

// The BHI Dependent fields the add / edit dialog carries.
const DEP_FIELDS = ['fullName', 'relationship', 'dateOfBirth', 'idType', 'idNumber', 'sex', 'notes'] as const;
type DepField = (typeof DEP_FIELDS)[number];
type DepForm = Record<DepField, string>;
const EMPTY_DEP_FORM: DepForm = {
  fullName: '',
  relationship: '',
  dateOfBirth: '',
  idType: '',
  idNumber: '',
  sex: '',
  notes: '',
};
const toDepForm = (d: Dependent): DepForm => ({
  fullName: d.fullName,
  relationship: d.relationship,
  dateOfBirth: d.dateOfBirth ? d.dateOfBirth.slice(0, 10) : '',
  idType: d.idType ?? '',
  idNumber: d.idNumber ?? '',
  sex: d.sex ?? '',
  notes: d.notes ?? '',
});

// The BHI Beneficiary fields the add / edit dialog carries.
const BEN_FIELDS = [
  'fullName',
  'relationship',
  'dateOfBirth',
  'idType',
  'idNumber',
  'sex',
  'phone',
  'email',
  'sharePercent',
  'notes',
] as const;
type BenField = (typeof BEN_FIELDS)[number];
type BenForm = Record<BenField, string>;
const EMPTY_BEN_FORM: BenForm = {
  fullName: '',
  relationship: '',
  dateOfBirth: '',
  idType: '',
  idNumber: '',
  sex: '',
  phone: '',
  email: '',
  sharePercent: '',
  notes: '',
};
const toBenForm = (b: Beneficiary): BenForm => ({
  fullName: b.fullName,
  relationship: b.relationship ?? '',
  dateOfBirth: b.dateOfBirth ? b.dateOfBirth.slice(0, 10) : '',
  idType: b.idType ?? '',
  idNumber: b.idNumber ?? '',
  sex: b.sex ?? '',
  phone: b.phone ?? '',
  email: b.email ?? '',
  sharePercent: b.sharePercent != null ? String(b.sharePercent) : '',
  notes: b.notes ?? '',
});

/** Fields whose trimmed value differs from what was loaded. */
function changedFields<K extends string>(fields: readonly K[], form: Record<K, string>, initial: Record<K, string>): K[] {
  return fields.filter((k) => form[k].trim() !== initial[k].trim());
}

/** "ID NID 12345", "Female" — the extra BHI details a row shows when they are on file. */
function idAndSex(record: { idType: string | null; idNumber: string | null; sex: string | null }): string | null {
  const id = [idTypeLabel(record.idType), record.idNumber].filter(Boolean).join(' ');
  return [id ? `ID ${id}` : null, sexText(record.sex)].filter(Boolean).join(' • ') || null;
}

// What a deactivate / reactivate dialog is acting on. Members, dependants and
// beneficiaries share one dialog: each change needs a reason and nothing else,
// except that a deactivation may be back- or forward-dated.
type StatusTarget =
  | { kind: 'member'; action: 'deactivate' | 'reactivate'; name: string }
  | { kind: 'dependent'; action: 'deactivate' | 'reactivate'; name: string; id: number }
  | { kind: 'beneficiary'; action: 'deactivate' | 'reactivate'; name: string; id: number };

const KIND_LABEL: Record<StatusTarget['kind'], string> = {
  member: 'member',
  dependent: 'dependant',
  beneficiary: 'beneficiary',
};

// What each deactivation does, said in the dialog so the button can stay short.
const DEACTIVATE_EFFECT: Record<StatusTarget['kind'], string> = {
  member:
    'ends their card access straight away. The record, their policy and their dependants are kept, and they can be put back with Reactivate.',
  dependent:
    'takes them off the card and out of the member’s billing tier. The record is kept and can be reactivated.',
  beneficiary:
    'stops them being a payout beneficiary. The record is kept and can be reactivated.',
};

export default function AdminMemberDetail() {
  const params = useParams<{ companyNumber: string; memberId: string }>();
  const [, setLocation] = useLocation();
  const { adminUser, hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const companyNumber = params.companyNumber ?? '';
  const memberId = Number(params.memberId);
  const validParams = companyNumber !== '' && Number.isInteger(memberId) && memberId > 0;
  const memberKey = getGetMemberQueryKey(companyNumber, memberId);
  const basePath = `/admin/companies/${encodeURIComponent(companyNumber)}/members/${params.memberId}`;

  const { data: member, isLoading, error } = useGetMember(companyNumber, memberId, {
    query: { enabled: validParams, queryKey: memberKey },
  });

  const deactivateMemberMutation = useDeactivateMember();
  const reactivateMemberMutation = useReactivateMember();
  const createDependentMutation = useCreateDependent();
  const updateDependentMutation = useUpdateDependent();
  const deactivateDependentMutation = useDeactivateDependent();
  const reactivateDependentMutation = useReactivateDependent();
  const createBeneficiaryMutation = useCreateBeneficiary();
  const updateBeneficiaryMutation = useUpdateBeneficiary();
  const deactivateBeneficiaryMutation = useDeactivateBeneficiary();
  const reactivateBeneficiaryMutation = useReactivateBeneficiary();

  const canUpdate = hasPermission('MEMBER_UPDATE');
  const canDeactivate = hasPermission('MEMBER_DELETE');
  const canReactivate = hasPermission('MEMBER_REACTIVATE');
  const canManageDependents = hasPermission('DEPENDENT_UPDATE');
  const canManageBeneficiaries = hasPermission('BENEFICIARY_MANAGE');
  const canManagePolicy = hasPermission('POLICY_MANAGE');
  const showPolicy = canSeePolicy(adminUser?.role);

  // Status dialog state
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');

  const openStatusDialog = (target: StatusTarget) => {
    setStatusTarget(target);
    setStatusReason('');
    setEffectiveDate('');
  };

  // Dependant dialog state
  const [depDialogOpen, setDepDialogOpen] = useState(false);
  const [depEditing, setDepEditing] = useState<Dependent | null>(null);
  const [depInitial, setDepInitial] = useState<DepForm>(EMPTY_DEP_FORM);
  const [depForm, setDepForm] = useState<DepForm>(EMPTY_DEP_FORM);
  const [depReason, setDepReason] = useState('');

  const openAddDependent = () => {
    setDepEditing(null);
    setDepInitial(EMPTY_DEP_FORM);
    setDepForm(EMPTY_DEP_FORM);
    setDepReason('');
    setDepDialogOpen(true);
  };

  const openEditDependent = (d: Dependent) => {
    const values = toDepForm(d);
    setDepEditing(d);
    setDepInitial(values);
    setDepForm(values);
    setDepReason('');
    setDepDialogOpen(true);
  };

  const setDep = (key: DepField, value: string) => setDepForm((f) => ({ ...f, [key]: value }));

  // Editing sends only what moved, so the audit entry records the change and
  // nothing else.
  const depChanged = changedFields(DEP_FIELDS, depForm, depInitial);
  const depFormValid =
    depForm.fullName.trim().length > 0 &&
    depForm.relationship !== '' &&
    !isFutureDate(depForm.dateOfBirth) &&
    depReason.trim().length >= 3 &&
    (!depEditing || depChanged.length > 0);
  const depPending = createDependentMutation.isPending || updateDependentMutation.isPending;

  const handleSaveDependent = () => {
    if (!depFormValid) return;
    const opts = {
      onSuccess: () => {
        toast({
          title: depEditing ? 'Dependant updated' : 'Dependant added',
          description: depForm.fullName.trim(),
        });
        queryClient.invalidateQueries({ queryKey: memberKey });
        // The members list shows each member's dependant count.
        queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
        setDepDialogOpen(false);
      },
      onError: (error: any) => {
        toast({
          title: depEditing ? 'Update failed' : 'Add failed',
          description: error?.data?.error?.message || 'Unable to save dependant',
          variant: 'destructive',
        });
      },
    };
    if (depEditing) {
      const data: DependentUpdate = { reason: depReason.trim() };
      for (const key of depChanged) {
        if (key === 'fullName') data.fullName = depForm.fullName.trim();
        else if (key === 'relationship') data.relationship = depForm.relationship as DependentRelationship;
        else if (key === 'idType') data.idType = orNull(depForm.idType) as IdType | null;
        else data[key] = orNull(depForm[key]);
      }
      updateDependentMutation.mutate(
        { companyNumber, memberId, dependentId: depEditing.dependentId, data },
        opts,
      );
    } else {
      const data: DependentCreate = {
        fullName: depForm.fullName.trim(),
        relationship: depForm.relationship as DependentRelationship,
        dateOfBirth: orNull(depForm.dateOfBirth),
        idType: orNull(depForm.idType) as IdType | null,
        idNumber: orNull(depForm.idNumber),
        sex: orNull(depForm.sex),
        notes: orNull(depForm.notes),
        reason: depReason.trim(),
      };
      createDependentMutation.mutate({ companyNumber, memberId, data }, opts);
    }
  };

  // Beneficiary dialog state
  const [benDialogOpen, setBenDialogOpen] = useState(false);
  const [benEditing, setBenEditing] = useState<Beneficiary | null>(null);
  const [benInitial, setBenInitial] = useState<BenForm>(EMPTY_BEN_FORM);
  const [benForm, setBenForm] = useState<BenForm>(EMPTY_BEN_FORM);
  const [benReason, setBenReason] = useState('');

  const openAddBeneficiary = () => {
    setBenEditing(null);
    setBenInitial(EMPTY_BEN_FORM);
    setBenForm(EMPTY_BEN_FORM);
    setBenReason('');
    setBenDialogOpen(true);
  };

  const openEditBeneficiary = (b: Beneficiary) => {
    const values = toBenForm(b);
    setBenEditing(b);
    setBenInitial(values);
    setBenForm(values);
    setBenReason('');
    setBenDialogOpen(true);
  };

  const setBen = (key: BenField, value: string) => setBenForm((f) => ({ ...f, [key]: value }));

  // Relationship and date of birth are optional, as in the carrier's
  // Beneficiaries sheet; only the name and a reason are required.
  const benChanged = changedFields(BEN_FIELDS, benForm, benInitial);
  const benEmailValid = emailValid(benForm.email);
  const benShareValid = shareValid(benForm.sharePercent);
  const benFormValid =
    benForm.fullName.trim().length > 0 &&
    !isFutureDate(benForm.dateOfBirth) &&
    benEmailValid &&
    benShareValid &&
    benReason.trim().length >= 3 &&
    (!benEditing || benChanged.length > 0);

  /** One beneficiary field as the API takes it: blank goes as null. */
  const benValue = (key: BenField) => {
    if (key === 'sharePercent') return benForm.sharePercent.trim() === '' ? null : Number(benForm.sharePercent);
    if (key === 'relationship') return (benForm.relationship || null) as BeneficiaryCreateRelationship;
    return orNull(benForm[key]);
  };

  const handleSaveBeneficiary = () => {
    if (!benFormValid) return;
    const opts = {
      onSuccess: () => {
        toast({ title: benEditing ? 'Beneficiary updated' : 'Beneficiary added' });
        queryClient.invalidateQueries({ queryKey: memberKey });
        setBenDialogOpen(false);
      },
      onError: (error: any) => {
        toast({
          title: benEditing ? 'Update failed' : 'Add failed',
          description: error?.data?.error?.message || 'Unable to save beneficiary',
          variant: 'destructive',
        });
      },
    };
    if (benEditing) {
      const data: BeneficiaryUpdate = { reason: benReason.trim() };
      for (const key of benChanged) {
        if (key === 'fullName') data.fullName = benForm.fullName.trim();
        else Object.assign(data, { [key]: benValue(key) });
      }
      updateBeneficiaryMutation.mutate(
        { companyNumber, memberId, beneficiaryId: benEditing.beneficiaryId, data },
        opts,
      );
    } else {
      const data: BeneficiaryCreate = {
        fullName: benForm.fullName.trim(),
        relationship: benValue('relationship') as BeneficiaryCreateRelationship,
        dateOfBirth: orNull(benForm.dateOfBirth),
        idType: orNull(benForm.idType) as IdType | null,
        idNumber: orNull(benForm.idNumber),
        sex: orNull(benForm.sex),
        phone: orNull(benForm.phone),
        email: orNull(benForm.email),
        sharePercent: benValue('sharePercent') as number | null,
        notes: orNull(benForm.notes),
        reason: benReason.trim(),
      };
      createBeneficiaryMutation.mutate({ companyNumber, memberId, data }, opts);
    }
  };

  const statusPending =
    deactivateMemberMutation.isPending ||
    reactivateMemberMutation.isPending ||
    deactivateDependentMutation.isPending ||
    reactivateDependentMutation.isPending ||
    deactivateBeneficiaryMutation.isPending ||
    reactivateBeneficiaryMutation.isPending;

  const handleStatusChange = () => {
    if (!statusTarget) return;
    const reason = statusReason.trim();
    if (reason.length < 3) {
      toast({ title: 'Reason required', description: 'Please provide a reason (minimum 3 characters)', variant: 'destructive' });
      return;
    }
    const { kind, action, name } = statusTarget;
    const deactivateData = { reason, effectiveDate: effectiveDate || null };
    const reactivateData = { reason };

    const opts = {
      onSuccess: () => {
        toast({
          title: `${KIND_LABEL[kind].charAt(0).toUpperCase() + KIND_LABEL[kind].slice(1)} ${action === 'deactivate' ? 'deactivated' : 'reactivated'}`,
          description: `${name} is now ${action === 'deactivate' ? 'inactive' : 'active'}.`,
        });
        queryClient.invalidateQueries({ queryKey: memberKey });
        // A member's status and a dependant's (through the dependant count)
        // both show on the list; the bare prefix key clears every cached page
        // and filter. The dashboard counts members only.
        if (kind !== 'beneficiary') {
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
        }
        if (kind === 'member') {
          queryClient.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() });
        }
        setStatusTarget(null);
        setStatusReason('');
        setEffectiveDate('');
      },
      onError: (error: any) => {
        toast({
          title: action === 'deactivate' ? 'Deactivation failed' : 'Reactivation failed',
          description: error?.data?.error?.message || `Unable to ${action} ${KIND_LABEL[kind]}`,
          variant: 'destructive',
        });
      },
    };

    const base = { companyNumber, memberId };
    if (statusTarget.kind === 'member') {
      if (action === 'deactivate') deactivateMemberMutation.mutate({ ...base, data: deactivateData }, opts);
      else reactivateMemberMutation.mutate({ ...base, data: reactivateData }, opts);
    } else if (statusTarget.kind === 'dependent') {
      const ids = { ...base, dependentId: statusTarget.id };
      if (action === 'deactivate') deactivateDependentMutation.mutate({ ...ids, data: deactivateData }, opts);
      else reactivateDependentMutation.mutate({ ...ids, data: reactivateData }, opts);
    } else {
      const ids = { ...base, beneficiaryId: statusTarget.id };
      if (action === 'deactivate') deactivateBeneficiaryMutation.mutate({ ...ids, data: deactivateData }, opts);
      else reactivateBeneficiaryMutation.mutate({ ...ids, data: reactivateData }, opts);
    }
  };

  if (isLoading) {
    return (
      <div>
        <Link href="/admin/members" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to members
        </Link>
        <PageHeader title="Loading..." />
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (!validParams || error || !member) {
    return (
      <div>
        <Link href="/admin/members" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to members
        </Link>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Member not found or you do not have access.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const fullName = [member.firstName, member.middleInitials, member.lastName].filter(Boolean).join(' ');
  const sexLabel = member.sex === 'M' ? 'Male' : member.sex === 'F' ? 'Female' : member.sex || '—';

  return (
    <div>
      <Link href="/admin/members" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground" data-testid="link-back">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to members
      </Link>

      <PageHeader
        title={fullName}
        description={`${idTypeLabel(member.idType)} ${member.idNumber} · ${member.companyName} (${member.companyNumber})`}
        action={
          <div className="flex gap-2">
            {canUpdate && (
              <Button variant="outline" size="sm" onClick={() => setLocation(`${basePath}/edit`)} data-testid="button-edit">
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            )}
            {canDeactivate && member.active && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => openStatusDialog({ kind: 'member', action: 'deactivate', name: fullName })}
                data-testid="button-deactivate"
              >
                <UserX className="mr-2 h-4 w-4" />
                Deactivate
              </Button>
            )}
            {/* The server refuses reactivation for anyone past 65, so the button
                can be offered without the page having to re-derive the age rule. */}
            {canReactivate && !member.active && (
              <Button
                variant="default"
                size="sm"
                onClick={() => openStatusDialog({ kind: 'member', action: 'reactivate', name: fullName })}
                data-testid="button-reactivate"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reactivate
              </Button>
            )}
          </div>
        }
      />

      {/* Company-scoped users see only that the alert exists, never which other
          company the contact details matched. */}
      {member.sharedContactAlert && (
        <Alert className="mb-6" data-testid="alert-shared-contact">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            This member's contact details are shared with a record in another company; NALICO has
            been alerted.
          </AlertDescription>
        </Alert>
      )}

      <div className={showPolicy ? 'grid gap-6 lg:grid-cols-2' : 'grid gap-6'}>
        {/* Member info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Member information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <Detail label="First name" value={member.firstName} />
              <Detail label="Middle initials" value={member.middleInitials || '—'} />
              <Detail label="Last name" value={member.lastName} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Detail label="ID type" value={idTypeLabel(member.idType)} />
              <Detail label="ID number" value={member.idNumber} mono />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Detail label="Date of birth" value={showDate(member.dateOfBirth)} mono />
              <Detail label="Sex" value={sexLabel} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Company</div>
                <div className="font-medium">{member.companyName}</div>
                <div className="mono-id text-xs text-muted-foreground">{member.companyNumber}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Class</div>
                <div className="font-medium">
                  <span className="mono-id">{member.classCode}</span> — {member.className}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Status</div>
                <ActiveBadge active={member.active} className="mt-1" />
              </div>
              {/* The tier that will be billed next month, from the count of
                  active dependants. */}
              <div>
                <div className="text-xs text-muted-foreground">Current tier</div>
                <div className="font-medium" data-testid="text-current-tier">{member.currentTier.coverageLabel}</div>
                <div className="text-xs text-muted-foreground">
                  {member.activeDependentCount} active dependant{member.activeDependentCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>
            {/* The reason is the only thing that says whether this was an
                administrator's decision or the retirement-age rule. */}
            {!member.active && (
              <div data-testid="inactive-details">
                <div className="text-xs text-muted-foreground">Inactive since</div>
                <div className="text-sm">{showDate(member.inactiveDate)}</div>
                {member.inactiveReason && (
                  <div className="mt-1 text-xs text-muted-foreground">{member.inactiveReason}</div>
                )}
              </div>
            )}
            <div className="border-t border-border pt-3">
              <div className="grid grid-cols-2 gap-3">
                <Detail label="Email" value={member.email || '—'} mono />
                <Detail label="Phone" value={member.phone || '—'} mono />
              </div>
            </div>
            <Detail
              label="Address"
              value={
                member.addressLine1 || member.addressLine2 ? (
                  <>
                    {member.addressLine1 && <div>{member.addressLine1}</div>}
                    {member.addressLine2 && <div>{member.addressLine2}</div>}
                  </>
                ) : (
                  '—'
                )
              }
            />
            <div className="border-t border-border pt-3">
              <div className="grid grid-cols-2 gap-3">
                <Detail label="Occupation" value={member.occupation || '—'} />
                <Detail label="Rate of pay" value={member.rateOfPay ?? '—'} mono />
                <Detail label="Employment date" value={showDate(member.employmentDate)} mono />
                <Detail label="Plan date" value={showDate(member.planDate)} mono />
              </div>
            </div>
            {member.notes && (
              <div>
                <div className="text-xs text-muted-foreground">Notes</div>
                <div className="whitespace-pre-wrap text-sm">{member.notes}</div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Policy — rendered even when absent, since that absence is what a
            super admin needs to see. Hidden entirely from company-scoped roles. */}
        {showPolicy && <PolicyPanel member={member} canManage={canManagePolicy} />}
      </div>

      {/* Dependents — shown empty too when this admin can add one. */}
      {(member.dependents.length > 0 || canManageDependents) && (
        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Dependents</CardTitle>
            {canManageDependents && (
              <Button variant="outline" size="sm" onClick={openAddDependent} data-testid="button-add-dependent">
                <Plus className="mr-2 h-4 w-4" />
                Add dependant
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {member.dependents.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-dependents">
                No dependants on file.
              </p>
            ) : (
              <div className="space-y-3">
                {member.dependents.map((dependent) => (
                  <div
                    key={dependent.dependentId}
                    className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-0"
                    data-testid={`dependent-${dependent.dependentId}`}
                  >
                    <div>
                      <div className="font-medium">{dependent.fullName}</div>
                      <div className="text-sm text-muted-foreground capitalize">
                        {[
                          dependent.relationship.toLowerCase(),
                          dependent.dateOfBirth ? `Born ${showDate(dependent.dateOfBirth)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' • ')}
                      </div>
                      {idAndSex(dependent) && (
                        <div className="mono-id text-xs text-muted-foreground" data-testid={`dependent-id-${dependent.dependentId}`}>
                          {idAndSex(dependent)}
                        </div>
                      )}
                      {dependent.notes && (
                        <div className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{dependent.notes}</div>
                      )}
                      {!dependent.active && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Inactive since {showDate(dependent.inactiveDate)}
                          {dependent.inactiveReason ? ` — ${dependent.inactiveReason}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <ActiveBadge active={dependent.active} />
                      {canManageDependents && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit dependant"
                            onClick={() => openEditDependent(dependent)}
                            data-testid={`button-edit-dependent-${dependent.dependentId}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              openStatusDialog({
                                kind: 'dependent',
                                action: dependent.active ? 'deactivate' : 'reactivate',
                                name: dependent.fullName,
                                id: dependent.dependentId,
                              })
                            }
                            data-testid={`button-${dependent.active ? 'deactivate' : 'reactivate'}-dependent-${dependent.dependentId}`}
                          >
                            {dependent.active ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dependant add/edit dialog */}
      <Dialog open={depDialogOpen} onOpenChange={setDepDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{depEditing ? 'Edit dependant' : 'Add dependant'}</DialogTitle>
            <DialogDescription>
              {depEditing
                ? 'Dependants print on the reverse of the member’s card. To take one off, use Deactivate.'
                : 'Dependants print on the reverse of the member’s card. A new dependant counts toward the member’s premium tier from the next billing month.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="dep-full-name">Full name</Label>
              <Input
                id="dep-full-name"
                value={depForm.fullName}
                onChange={(e) => setDep('fullName', e.target.value)}
                maxLength={120}
                className="mt-1.5"
                data-testid="input-dependent-full-name"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="dep-relationship">Relationship</Label>
                {/* A value from before the Access list (e.g. Child) stays shown until changed. */}
                <ChoiceSelect
                  id="dep-relationship"
                  value={depForm.relationship}
                  onChange={(v) => setDepForm((f) => ({ ...f, relationship: v, sex: dependantSexFor(v) }))}
                  options={DEPENDANT_RELATIONSHIP_OPTIONS}
                  label={(v) => relationshipLabel(v) ?? v}
                  placeholder="Select"
                  className="mt-1.5"
                  testId="select-dependent-relationship"
                />
              </div>
              <div>
                <Label htmlFor="dep-dob">Date of birth (optional)</Label>
                <Input
                  id="dep-dob"
                  type="date"
                  value={depForm.dateOfBirth}
                  onChange={(e) => setDep('dateOfBirth', e.target.value)}
                  max={TODAY}
                  className="mt-1.5"
                  data-testid="input-dependent-dob"
                />
                {isFutureDate(depForm.dateOfBirth) && (
                  <p className="mt-1 text-sm text-destructive" data-testid="error-dependent-dob">
                    Date of birth cannot be in the future.
                  </p>
                )}
              </div>
            </div>
            <div className={`grid gap-3 ${dependantAsksSex(depForm.relationship) ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <Label htmlFor="dep-id-type">ID type (optional)</Label>
                <ChoiceSelect
                  id="dep-id-type"
                  value={depForm.idType}
                  onChange={(v) => setDep('idType', v)}
                  options={ID_TYPE_OPTIONS}
                  noneLabel="Not recorded"
                  className="mt-1.5"
                  testId="select-dependent-id-type"
                />
              </div>
              <div>
                <Label htmlFor="dep-id-number">ID number (optional)</Label>
                <Input
                  id="dep-id-number"
                  value={depForm.idNumber}
                  onChange={(e) => setDep('idNumber', e.target.value)}
                  maxLength={40}
                  className="mt-1.5"
                  data-testid="input-dependent-id-number"
                />
              </div>
              {/* Son and Daughter already say it and Spouse does not need it. */}
              {dependantAsksSex(depForm.relationship) && (
                <div>
                  <Label htmlFor="dep-sex">Sex</Label>
                  <SexSelect
                    id="dep-sex"
                    value={depForm.sex}
                    onChange={(v) => setDep('sex', v)}
                    testId="select-dependent-sex"
                  />
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="dep-notes">Notes (optional)</Label>
              <Textarea
                id="dep-notes"
                value={depForm.notes}
                onChange={(e) => setDep('notes', e.target.value)}
                className="mt-1.5"
                rows={2}
                data-testid="textarea-dependent-notes"
              />
            </div>
            <div>
              <Label htmlFor="dep-reason">Reason (required)</Label>
              <Textarea
                id="dep-reason"
                placeholder="e.g., Member submitted a birth certificate for a new child..."
                value={depReason}
                onChange={(e) => setDepReason(e.target.value)}
                className="mt-1.5"
                rows={2}
                data-testid="textarea-dependent-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveDependent} disabled={!depFormValid || depPending} data-testid="button-save-dependent">
              {depPending ? 'Saving...' : depEditing ? 'Save changes' : 'Add dependant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Beneficiaries */}
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Payout beneficiaries</CardTitle>
          {canManageBeneficiaries && (
            <Button variant="outline" size="sm" onClick={openAddBeneficiary} data-testid="button-add-beneficiary">
              <Plus className="mr-2 h-4 w-4" />
              Add beneficiary
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {member.beneficiaries.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-beneficiaries">
              No beneficiaries on file. The insurance payout has no designated recipient.
            </p>
          ) : (
            <div className="space-y-3">
              {member.beneficiaries.map((ben) => (
                <div
                  key={ben.beneficiaryId}
                  className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-0"
                  data-testid={`beneficiary-${ben.beneficiaryId}`}
                >
                  <div>
                    <div className="font-medium">{ben.fullName}</div>
                    {/* Relationship and date of birth are both optional: the
                        carrier's Beneficiaries sheet carries neither reliably,
                        so an imported row may have only a name and a share. */}
                    <div className="text-sm text-muted-foreground capitalize">
                      {[
                        ben.relationship?.toLowerCase(),
                        ben.dateOfBirth ? `Born ${showDate(ben.dateOfBirth)}` : null,
                        ben.sharePercent != null ? `${ben.sharePercent}% share` : null,
                      ]
                        .filter(Boolean)
                        .join(' • ') || 'No further details on file'}
                    </div>
                    {idAndSex(ben) && (
                      <div className="mono-id text-xs text-muted-foreground" data-testid={`beneficiary-id-${ben.beneficiaryId}`}>
                        {idAndSex(ben)}
                      </div>
                    )}
                    {(ben.phone || ben.email) && (
                      <div className="mono-id text-xs text-muted-foreground">
                        {[ben.phone, ben.email].filter(Boolean).join(' • ')}
                      </div>
                    )}
                    {ben.notes && (
                      <div className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{ben.notes}</div>
                    )}
                    {!ben.active && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Inactive since {showDate(ben.inactiveDate)}
                        {ben.inactiveReason ? ` — ${ben.inactiveReason}` : ''}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <ActiveBadge active={ben.active} />
                    {canManageBeneficiaries && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit beneficiary"
                          onClick={() => openEditBeneficiary(ben)}
                          data-testid={`button-edit-beneficiary-${ben.beneficiaryId}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            openStatusDialog({
                              kind: 'beneficiary',
                              action: ben.active ? 'deactivate' : 'reactivate',
                              name: ben.fullName,
                              id: ben.beneficiaryId,
                            })
                          }
                          data-testid={`button-${ben.active ? 'deactivate' : 'reactivate'}-beneficiary-${ben.beneficiaryId}`}
                        >
                          {ben.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Beneficiary add/edit dialog */}
      <Dialog open={benDialogOpen} onOpenChange={setBenDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{benEditing ? 'Edit beneficiary' : 'Add beneficiary'}</DialogTitle>
            <DialogDescription>
              The person designated to receive the insurance payout for this member. Only the name is
              required; add whatever else is on the designation form.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ben-full-name">Full name</Label>
              <Input
                id="ben-full-name"
                value={benForm.fullName}
                onChange={(e) => setBen('fullName', e.target.value)}
                maxLength={120}
                className="mt-1.5"
                data-testid="input-beneficiary-full-name"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ben-relationship">Relationship (optional)</Label>
                <ChoiceSelect
                  id="ben-relationship"
                  value={benForm.relationship}
                  onChange={(v) => setBen('relationship', v)}
                  options={BENEFICIARY_RELATIONSHIP_OPTIONS}
                  label={(v) => relationshipLabel(v) ?? v}
                  noneLabel="Not recorded"
                  className="mt-1.5"
                  testId="select-beneficiary-relationship"
                />
              </div>
              <div>
                <Label htmlFor="ben-dob">Date of birth (optional)</Label>
                <Input
                  id="ben-dob"
                  type="date"
                  value={benForm.dateOfBirth}
                  onChange={(e) => setBen('dateOfBirth', e.target.value)}
                  max={TODAY}
                  className="mt-1.5"
                  data-testid="input-beneficiary-dob"
                />
                {isFutureDate(benForm.dateOfBirth) && (
                  <p className="mt-1 text-sm text-destructive" data-testid="error-beneficiary-dob">
                    Date of birth cannot be in the future.
                  </p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="ben-id-type">ID type (optional)</Label>
                <ChoiceSelect
                  id="ben-id-type"
                  value={benForm.idType}
                  onChange={(v) => setBen('idType', v)}
                  options={ID_TYPE_OPTIONS}
                  noneLabel="Not recorded"
                  className="mt-1.5"
                  testId="select-beneficiary-id-type"
                />
              </div>
              <div>
                <Label htmlFor="ben-id-number">ID number (optional)</Label>
                <Input
                  id="ben-id-number"
                  value={benForm.idNumber}
                  onChange={(e) => setBen('idNumber', e.target.value)}
                  maxLength={40}
                  className="mt-1.5"
                  data-testid="input-beneficiary-id-number"
                />
              </div>
              <div>
                <Label htmlFor="ben-sex">Sex</Label>
                <SexSelect
                  id="ben-sex"
                  value={benForm.sex}
                  onChange={(v) => setBen('sex', v)}
                  testId="select-beneficiary-sex"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ben-phone">Phone (optional)</Label>
                <Input
                  id="ben-phone"
                  value={benForm.phone}
                  onChange={(e) => setBen('phone', e.target.value)}
                  maxLength={50}
                  className="mt-1.5"
                  data-testid="input-beneficiary-phone"
                />
              </div>
              <div>
                <Label htmlFor="ben-email">Email (optional)</Label>
                <Input
                  id="ben-email"
                  type="email"
                  value={benForm.email}
                  onChange={(e) => setBen('email', e.target.value)}
                  maxLength={100}
                  className="mt-1.5"
                  data-testid="input-beneficiary-email"
                />
                {!benEmailValid && (
                  <p className="mt-1 text-sm text-destructive" data-testid="error-beneficiary-email">
                    Enter a valid email address.
                  </p>
                )}
              </div>
            </div>
            <div>
              <Label htmlFor="ben-share">Share % (optional)</Label>
              <Input
                id="ben-share"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={0.01}
                placeholder="e.g., 50"
                value={benForm.sharePercent}
                onChange={(e) => setBen('sharePercent', e.target.value)}
                className="mt-1.5"
                data-testid="input-beneficiary-share"
              />
              {!benShareValid && (
                <p className="mt-1 text-sm text-destructive" data-testid="error-beneficiary-share">
                  Share must be between 0 and 100, with at most two decimal places.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="ben-notes">Notes (optional)</Label>
              <Textarea
                id="ben-notes"
                value={benForm.notes}
                onChange={(e) => setBen('notes', e.target.value)}
                className="mt-1.5"
                rows={2}
                data-testid="textarea-beneficiary-notes"
              />
            </div>
            <div>
              <Label htmlFor="ben-reason">Reason (required)</Label>
              <Textarea
                id="ben-reason"
                placeholder="e.g., Employee submitted a beneficiary designation form..."
                value={benReason}
                onChange={(e) => setBenReason(e.target.value)}
                className="mt-1.5"
                rows={2}
                data-testid="textarea-beneficiary-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBenDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveBeneficiary}
              disabled={!benFormValid || createBeneficiaryMutation.isPending || updateBeneficiaryMutation.isPending}
              data-testid="button-save-beneficiary"
            >
              {createBeneficiaryMutation.isPending || updateBeneficiaryMutation.isPending
                ? 'Saving...'
                : benEditing
                  ? 'Save changes'
                  : 'Add beneficiary'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate / reactivate dialog, for the member, a dependant or a
          beneficiary. The wording says what the change does, because nothing
          is erased and every change can be reversed. */}
      <Dialog open={statusTarget !== null} onOpenChange={(open) => { if (!open) setStatusTarget(null); }}>
        <DialogContent>
          {statusTarget && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {statusTarget.action === 'deactivate' ? 'Deactivate' : 'Reactivate'} {KIND_LABEL[statusTarget.kind]}
                </DialogTitle>
                <DialogDescription>
                  {statusTarget.action === 'deactivate'
                    ? `This marks ${statusTarget.name} inactive and ${DEACTIVATE_EFFECT[statusTarget.kind]} The change is recorded in the audit trail.`
                    : `This marks ${statusTarget.name} active again. The change is recorded in the audit trail.`}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {statusTarget.action === 'deactivate' && (
                  <div>
                    <Label htmlFor="status-effective-date">Inactive from (optional)</Label>
                    <Input
                      id="status-effective-date"
                      type="date"
                      value={effectiveDate}
                      onChange={(e) => setEffectiveDate(e.target.value)}
                      className="mt-1.5"
                      data-testid="input-status-effective-date"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">Defaults to today.</p>
                  </div>
                )}
                <div>
                  <Label htmlFor="status-reason">Reason (required)</Label>
                  <Textarea
                    id="status-reason"
                    placeholder={
                      statusTarget.action === 'deactivate'
                        ? 'e.g., Left the company, coverage ended...'
                        : 'e.g., Returned to employment, policy reinstated...'
                    }
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    className="mt-1.5"
                    rows={3}
                    data-testid="textarea-status-reason"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setStatusTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant={statusTarget.action === 'deactivate' ? 'destructive' : 'default'}
                  onClick={handleStatusChange}
                  disabled={statusPending || statusReason.trim().length < 3}
                  data-testid="button-confirm-status"
                >
                  {statusPending
                    ? statusTarget.action === 'deactivate'
                      ? 'Deactivating...'
                      : 'Reactivating...'
                    : `${statusTarget.action === 'deactivate' ? 'Deactivate' : 'Reactivate'} ${KIND_LABEL[statusTarget.kind]}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
