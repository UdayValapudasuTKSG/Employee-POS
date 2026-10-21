import { useState, useEffect } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import {
  useGetMember,
  getGetMemberQueryKey,
  getListMembersQueryKey,
  useSaveMemberPolicy,
} from '@workspace/api-client-react';
import type { MemberDetail } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Field, FormSection } from '@/components/member-form';
import { initials } from '@/components/admin-nav';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { idTypeLabel } from '@/lib/member-vocab';
import { AlertCircle, ArrowLeft, CalendarRange, CheckCircle2, Hash, Save, ShieldCheck } from 'lucide-react';

// The policy fields, all held as strings so each maps onto one input.
const FIELDS = [
  'insurerName',
  'planName',
  'policyholder',
  'policyNumber',
  'groupNumber',
  'memberNumber',
  'certificateNumber',
  'effectiveDate',
  'expiryDate',
] as const;
type FieldKey = (typeof FIELDS)[number];
type FormValues = Record<FieldKey, string>;

/** How each field is named in the "Changes" list. */
const LABELS: Record<FieldKey, string> = {
  insurerName: 'Insurer',
  planName: 'Plan',
  policyholder: 'Policyholder',
  policyNumber: 'Policy number',
  groupNumber: 'Group number',
  memberNumber: 'Member number',
  certificateNumber: 'Certificate number',
  effectiveDate: 'Effective date',
  expiryDate: 'Expiry date',
};

const REQUIRED: readonly FieldKey[] = FIELDS.filter((k) => k !== 'expiryDate');

const EMPTY: FormValues = Object.fromEntries(FIELDS.map((k) => [k, ''])) as FormValues;

/** A date column as the date input wants it: the first ten characters. */
const asDateInput = (value: string | null | undefined) => (value ? value.slice(0, 10) : '');

function toForm(member: MemberDetail): FormValues {
  const policy = member.policy;
  if (!policy) return { ...EMPTY };
  return {
    insurerName: policy.insurerName,
    planName: policy.planName,
    policyholder: policy.policyholder,
    policyNumber: policy.policyNumber,
    groupNumber: policy.groupNumber,
    // The read model calls this memberId; the write model calls it
    // memberNumber. Same column (policy_memberships.member_number).
    memberNumber: policy.memberId,
    certificateNumber: policy.certificateNumber,
    effectiveDate: asDateInput(policy.effectiveDate),
    expiryDate: asDateInput(policy.expiryDate),
  };
}

export default function AdminMemberPolicy() {
  const params = useParams<{ companyNumber: string; memberId: string }>();
  const [, setLocation] = useLocation();
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const companyNumber = params.companyNumber ?? '';
  const memberId = Number(params.memberId);
  const validParams = companyNumber !== '' && Number.isInteger(memberId) && memberId > 0;
  const detailPath = `/admin/companies/${encodeURIComponent(companyNumber)}/members/${params.memberId}`;
  const canManagePolicy = hasPermission('POLICY_MANAGE');

  const { data: member, isLoading, error } = useGetMember(companyNumber, memberId, {
    query: { enabled: validParams && canManagePolicy, queryKey: getGetMemberQueryKey(companyNumber, memberId) },
  });

  const [initial, setInitial] = useState<FormValues | null>(null);
  const [formData, setFormData] = useState<FormValues | null>(null);
  const [reason, setReason] = useState('');

  // Seeded once: a background refetch (window focus, say) must not wipe what
  // the admin has typed.
  useEffect(() => {
    if (member && !initial) {
      const values = toForm(member);
      setInitial(values);
      setFormData(values);
    }
  }, [member, initial]);

  const saveMutation = useSaveMemberPolicy();

  const set = (key: FieldKey, value: string) =>
    setFormData((prev) => (prev ? { ...prev, [key]: value } : prev));

  const isNew = !member?.policy;
  const changed: FieldKey[] =
    formData && initial ? FIELDS.filter((k) => formData[k].trim() !== initial[k].trim()) : [];
  const requiredMissing = formData ? REQUIRED.some((k) => formData[k].trim() === '') : true;
  const expiryBeforeEffective =
    !!formData && formData.expiryDate !== '' && formData.effectiveDate !== '' && formData.expiryDate < formData.effectiveDate;
  const canSubmit =
    !!formData && changed.length > 0 && !requiredMissing && !expiryBeforeEffective && reason.trim().length >= 3;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData || !canSubmit) return;

    // The endpoint replaces the policy wholesale, so every field is sent.
    saveMutation.mutate(
      {
        companyNumber,
        memberId,
        data: {
          insurerName: formData.insurerName.trim(),
          planName: formData.planName.trim(),
          policyholder: formData.policyholder.trim(),
          policyNumber: formData.policyNumber.trim(),
          groupNumber: formData.groupNumber.trim(),
          memberNumber: formData.memberNumber.trim(),
          certificateNumber: formData.certificateNumber.trim(),
          effectiveDate: formData.effectiveDate.trim(),
          expiryDate: formData.expiryDate.trim() || null,
          reason: reason.trim(),
        },
      },
      {
        onSuccess: () => {
          toast({ title: isNew ? 'Policy created' : 'Policy updated' });
          queryClient.invalidateQueries({ queryKey: getGetMemberQueryKey(companyNumber, memberId) });
          // The members list shows whether a policy is on file.
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
          setLocation(detailPath);
        },
        onError: (error: any) => {
          toast({
            title: 'Could not save the policy',
            description: error?.data?.error?.message || 'Please try again',
            variant: 'destructive',
          });
        },
      },
    );
  };

  if (!canManagePolicy) {
    return (
      <div>
        <Link href={detailPath} className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to member
        </Link>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Only a super admin can add or edit a policy.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading || (member && !formData)) {
    return (
      <div>
        <Link href={detailPath} className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Link>
        <PageHeader title="Loading..." />
        <div className="animate-pulse space-y-4">
          <div className="h-12 w-full rounded bg-muted"></div>
          <div className="h-12 w-full rounded bg-muted"></div>
        </div>
      </div>
    );
  }

  if (!validParams || error || !member || !formData) {
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

  const text = (
    key: FieldKey,
    label: string,
    opts: { type?: string; required?: boolean; placeholder?: string; className?: string; error?: string } = {},
  ) => (
    <Field id={key} label={label} required={opts.required} className={opts.className} error={opts.error}>
      <Input
        id={key}
        type={opts.type ?? 'text'}
        value={formData[key]}
        onChange={(e) => set(key, e.target.value)}
        required={opts.required}
        placeholder={opts.placeholder}
        aria-invalid={opts.error ? true : undefined}
        data-testid={`input-policy-${key}`}
      />
    </Field>
  );

  const fullName = [member.firstName, member.middleInitials, member.lastName].filter(Boolean).join(' ');

  return (
    <div>
      <PageHeader
        eyebrow="Membership"
        title={isNew ? 'Add policy' : 'Edit policy'}
        description={`${member.firstName} ${member.lastName} — ${member.companyName} (${member.companyNumber})`}
        action={
          <Button variant="outline" onClick={() => setLocation(detailPath)} data-testid="link-back">
            <ArrowLeft className="h-4 w-4" />
            Back to member
          </Button>
        }
      />

      <form onSubmit={handleSubmit} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <FormSection step={1} icon={ShieldCheck} title="Insurer and plan" sub="Who provides the cover, as it prints on the card.">
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
              {text('insurerName', 'Insurer', { required: true })}
              {text('planName', 'Plan', { required: true })}
              {text('policyholder', 'Policyholder', { required: true, className: 'sm:col-span-2' })}
            </div>
          </FormSection>

          <FormSection step={2} icon={Hash} title="Policy numbers" sub="The identifiers a provider quotes to confirm cover.">
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
              {text('policyNumber', 'Policy number', { required: true })}
              {text('groupNumber', 'Group number', { required: true })}
              {text('memberNumber', 'Member number', { required: true })}
              {text('certificateNumber', 'Certificate number', { required: true })}
            </div>
          </FormSection>

          <FormSection step={3} icon={CalendarRange} title="Cover dates" sub="Leave the expiry date blank for open-ended cover.">
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
              {text('effectiveDate', 'Effective date', { type: 'date', required: true })}
              {text('expiryDate', 'Expiry date', {
                type: 'date',
                error: expiryBeforeEffective ? 'Expiry date cannot be before the effective date.' : undefined,
              })}
            </div>
          </FormSection>
        </div>

        {/* Summary rail: whose policy this is, what has changed, and the one
            action. Sticky so Save is always in reach. */}
        <aside className="min-w-0 space-y-4 xl:sticky xl:top-0">
          <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card shadow-[var(--shadow-sm)]">
            <div className="admin-hero rounded-none px-5 py-5 shadow-none">
              <div className="relative z-[1] flex items-center gap-3.5">
                <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-white/15 text-[17px] font-bold text-white ring-1 ring-inset ring-white/30">
                  {initials(fullName)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[18px] font-bold text-white">{fullName}</div>
                  <div className="mono-id truncate text-[14px] text-[#dbe2fe]">
                    {idTypeLabel(member.idType)} {member.idNumber}
                  </div>
                </div>
              </div>
            </div>
            <dl className="divide-y divide-[var(--surface-hairline)] text-[14.5px]">
              {(
                [
                  ['Company', `${member.companyName} (${member.companyNumber})`],
                  ['Class', `${member.classCode} — ${member.className}`],
                  ['Policy', isNew ? 'None on file' : member.policy!.policyNumber],
                ] as const
              ).map(([term, value]) => (
                <div key={term} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <dt className="text-[var(--fg-3)]">{term}</dt>
                  <dd className="truncate text-right font-semibold text-[var(--fg-1)]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-[var(--surface-border)] bg-card p-5 shadow-[var(--shadow-sm)]">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[16px] font-bold text-[var(--fg-1)]">Changes</div>
              <div className="tnum text-[14px] font-semibold text-[var(--fg-3)]" data-testid="text-change-count">
                {changed.length} field{changed.length === 1 ? '' : 's'}
              </div>
            </div>
            {changed.length === 0 ? (
              <p className="mt-3 text-[14.5px] text-[var(--fg-3)]">
                {isNew ? 'Fill in the policy fields to see them here.' : 'No changes yet. Edit a field to see it here.'}
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {changed.map((k) => (
                  <li key={k} className="flex items-center gap-2.5 text-[14.5px] text-[var(--fg-2)]">
                    <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px] flex-shrink-0 text-[var(--brand-600)]" />
                    {LABELS[k]}
                  </li>
                ))}
              </ul>
            )}
            {requiredMissing && (
              <p className="mt-3 text-[14px] font-semibold text-destructive">
                Every field except the expiry date is required.
              </p>
            )}

            <div className="mt-5 border-t border-[var(--surface-hairline)] pt-4">
              <Label htmlFor="reason" className="mb-2 flex items-center gap-1">
                Reason
                <span aria-hidden="true" className="text-[var(--status-error)]">
                  *
                </span>
              </Label>
              <Textarea
                id="reason"
                placeholder={isNew ? 'e.g., Policy issued' : 'e.g., Policy renewed, corrected certificate number...'}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                required
                data-testid="textarea-policy-reason"
              />
              <p className="mt-1.5 text-[13.5px] text-[var(--fg-3)]">Minimum 3 characters. Recorded in the audit log.</p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={saveMutation.isPending || !canSubmit}
                data-testid="button-save-policy"
              >
                <Save className="h-4 w-4" />
                {saveMutation.isPending ? 'Saving...' : isNew ? 'Add policy' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setLocation(detailPath)}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        </aside>
      </form>
    </div>
  );
}
