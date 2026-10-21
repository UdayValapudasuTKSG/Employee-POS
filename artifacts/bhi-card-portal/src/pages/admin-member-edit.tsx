import { useState, useEffect } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import {
  useGetMember,
  getGetMemberQueryKey,
  getListMembersQueryKey,
  useUpdateMember,
} from '@workspace/api-client-react';
import type { MemberDetail, MemberUpdate } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ChoiceSelect } from '@/components/choice-select';
import { ClassSelect } from '@/components/class-select';
import { Field, FormSection } from '@/components/member-form';
import { initials } from '@/components/admin-nav';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { isFutureDate, TODAY } from '@/lib/dates';
import { ID_TYPE_OPTIONS, SEX_OPTIONS } from '@/lib/member-vocab';
import { AlertCircle, ArrowLeft, Briefcase, CheckCircle2, IdCard, Info, Mail, Save, StickyNote } from 'lucide-react';

// The editable BHI fields, all held as strings so each maps onto one input.
const FIELDS = [
  'idType',
  'idNumber',
  'firstName',
  'lastName',
  'middleInitials',
  'dateOfBirth',
  'sex',
  'classCode',
  'addressLine1',
  'addressLine2',
  'email',
  'phone',
  'employmentDate',
  'planDate',
  'rateOfPay',
  'occupation',
  'notes',
] as const;
type FieldKey = (typeof FIELDS)[number];
type FormValues = Record<FieldKey, string>;

/** How each field is named in the "Changes" list. */
const LABELS: Record<FieldKey, string> = {
  idType: 'ID type',
  idNumber: 'ID number',
  firstName: 'First name',
  lastName: 'Last name',
  middleInitials: 'Middle initials',
  dateOfBirth: 'Date of birth',
  sex: 'Sex',
  classCode: 'Class',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  email: 'Email',
  phone: 'Phone',
  employmentDate: 'Employment date',
  planDate: 'Plan date',
  rateOfPay: 'Rate of pay',
  occupation: 'Occupation',
  notes: 'Notes',
};

/** A date column as the date input wants it: the first ten characters. */
const asDateInput = (value: string | null) => (value ? value.slice(0, 10) : '');

function toForm(member: MemberDetail): FormValues {
  return {
    idType: member.idType,
    idNumber: member.idNumber,
    firstName: member.firstName,
    lastName: member.lastName,
    middleInitials: member.middleInitials ?? '',
    dateOfBirth: asDateInput(member.dateOfBirth),
    sex: member.sex ?? '',
    classCode: member.classCode,
    addressLine1: member.addressLine1 ?? '',
    addressLine2: member.addressLine2 ?? '',
    email: member.email ?? '',
    phone: member.phone ?? '',
    employmentDate: asDateInput(member.employmentDate),
    planDate: asDateInput(member.planDate),
    rateOfPay: member.rateOfPay ?? '',
    occupation: member.occupation ?? '',
    notes: member.notes ?? '',
  };
}

const REQUIRED: readonly FieldKey[] = ['idType', 'idNumber', 'firstName', 'lastName', 'classCode'];

export default function AdminMemberEdit() {
  const params = useParams<{ companyNumber: string; memberId: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const companyNumber = params.companyNumber ?? '';
  const memberId = Number(params.memberId);
  const validParams = companyNumber !== '' && Number.isInteger(memberId) && memberId > 0;
  const detailPath = `/admin/companies/${encodeURIComponent(companyNumber)}/members/${params.memberId}`;

  const { data: member, isLoading, error } = useGetMember(companyNumber, memberId, {
    query: { enabled: validParams, queryKey: getGetMemberQueryKey(companyNumber, memberId) },
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

  const updateMutation = useUpdateMember();

  const set = (key: FieldKey, value: string) =>
    setFormData((prev) => (prev ? { ...prev, [key]: value } : prev));

  // Only the fields that were changed are sent. Contact details may arrive
  // masked for roles without CONTACT_UNMASK, and echoing a masked value back
  // would overwrite the real one; it also keeps the audit entry to what moved.
  const changed: FieldKey[] =
    formData && initial ? FIELDS.filter((k) => formData[k].trim() !== initial[k].trim()) : [];

  const requiredMissing = formData ? REQUIRED.some((k) => formData[k].trim() === '') : true;
  const dobInFuture = formData ? isFutureDate(formData.dateOfBirth) : false;
  // Cover ends at 65, which needs the date of birth: once on file it can be
  // corrected but not removed (the server refuses that too).
  const dobCleared = !!formData && !!initial && initial.dateOfBirth.trim() !== '' && formData.dateOfBirth.trim() === '';
  const canSubmit =
    !!formData && changed.length > 0 && !requiredMissing && !dobInFuture && !dobCleared && reason.trim().length >= 3;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData) return;

    if (reason.trim().length < 3) {
      toast({ title: 'Reason required', description: 'Please provide a reason for this change (minimum 3 characters)', variant: 'destructive' });
      return;
    }
    if (changed.length === 0) {
      toast({ title: 'Nothing to save', description: 'No field has been changed.' });
      return;
    }

    // Blank optional fields go as null; the server treats that as "clear it".
    const fields: Partial<Record<FieldKey, string | null>> = {};
    for (const key of changed) {
      const value = formData[key].trim();
      if (REQUIRED.includes(key)) {
        // ID type and class come from dropdowns, already in their stored form.
        fields[key] = value;
      } else {
        fields[key] = value === '' ? null : value;
      }
    }
    // Required fields are never null here (canSubmit blocks a blank one).
    const data = { ...fields, reason: reason.trim() } as MemberUpdate;

    updateMutation.mutate(
      { companyNumber, memberId, data },
      {
        onSuccess: (updated) => {
          toast({ title: 'Member updated', description: `${updated.firstName} ${updated.lastName} has been updated.` });
          queryClient.invalidateQueries({ queryKey: getGetMemberQueryKey(companyNumber, memberId) });
          // Name, class and contact all show on the list.
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
          setLocation(detailPath);
        },
        onError: (error: any) => {
          toast({
            title: 'Update failed',
            description: error?.data?.error?.message || 'Unable to update member',
            variant: 'destructive',
          });
        },
      }
    );
  };

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
    opts: { type?: string; maxLength?: number; required?: boolean; placeholder?: string; className?: string } = {},
  ) => (
    <Field id={key} label={label} required={opts.required} className={opts.className}>
      <Input
        id={key}
        type={opts.type ?? 'text'}
        value={formData[key]}
        onChange={(e) => set(key, e.target.value)}
        maxLength={opts.maxLength}
        required={opts.required}
        placeholder={opts.placeholder}
        data-testid={`input-${key}`}
      />
    </Field>
  );

  const fullName =
    [formData.firstName.trim(), formData.middleInitials.trim(), formData.lastName.trim()].filter(Boolean).join(' ') ||
    `${member.firstName} ${member.lastName}`;

  return (
    <div>
      <PageHeader
        eyebrow="Membership"
        title="Edit member"
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
          <FormSection step={1} icon={IdCard} title="Person" sub="Identity details, as they print on the card.">
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field id="idType" label="ID type" required>
                {/* A type stored before the Access list stays shown until changed. */}
                <ChoiceSelect
                  id="idType"
                  value={formData.idType}
                  onChange={(v) => set('idType', v)}
                  options={ID_TYPE_OPTIONS}
                  placeholder="Select an ID type"
                  testId="select-idType"
                />
              </Field>
              {text('idNumber', 'ID number', { maxLength: 40, required: true })}
              <Field
                id="dateOfBirth"
                label="Date of birth"
                error={
                  dobInFuture
                    ? 'Date of birth cannot be in the future.'
                    : dobCleared
                      ? 'A date of birth can be corrected but not removed.'
                      : undefined
                }
                errorTestId={dobInFuture ? 'error-date-of-birth' : 'error-date-of-birth-cleared'}
                hint={
                  formData.dateOfBirth.trim() === ''
                    ? 'Not on file. Add it: cover ends at 65, and without it this member is never retired.'
                    : undefined
                }
              >
                <Input
                  id="dateOfBirth"
                  type="date"
                  value={formData.dateOfBirth}
                  onChange={(e) => set('dateOfBirth', e.target.value)}
                  max={TODAY}
                  aria-invalid={dobInFuture || dobCleared || undefined}
                  data-testid="input-dateOfBirth"
                />
              </Field>
              {text('firstName', 'First name', { maxLength: 80, required: true })}
              {text('middleInitials', 'Middle initials', { maxLength: 20 })}
              {text('lastName', 'Last name', { maxLength: 80, required: true })}
              <Field id="sex" label="Sex">
                <ChoiceSelect
                  id="sex"
                  value={formData.sex}
                  onChange={(v) => set('sex', v)}
                  options={SEX_OPTIONS}
                  noneLabel="Not recorded"
                  testId="select-sex"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection step={2} icon={Briefcase} title="Employment" sub="The class decides the member's premium tier.">
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* A class change is recorded in the member's class history. */}
              <Field id="classCode" label="Class" required hint={`Currently ${member.classCode} — ${member.className}`}>
                <ClassSelect
                  id="classCode"
                  value={formData.classCode}
                  onChange={(v) => set('classCode', v)}
                  testId="select-classCode"
                />
              </Field>
              {text('occupation', 'Occupation', { maxLength: 100 })}
              <Field id="rateOfPay" label="Rate of pay">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] font-bold text-[var(--fg-4)]">
                    GYD
                  </span>
                  <Input
                    id="rateOfPay"
                    inputMode="decimal"
                    placeholder="e.g., 125000.00"
                    value={formData.rateOfPay}
                    onChange={(e) => set('rateOfPay', e.target.value)}
                    className="tnum pl-14"
                    data-testid="input-rateOfPay"
                  />
                </div>
              </Field>
              {text('employmentDate', 'Employment date', { type: 'date' })}
              {text('planDate', 'Plan date', { type: 'date' })}
            </div>
          </FormSection>

          <FormSection step={3} icon={Mail} title="Contact" sub="Where card verification codes are sent.">
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
              {text('addressLine1', 'Address line 1', { maxLength: 150, className: 'sm:col-span-2' })}
              {text('addressLine2', 'Address line 2', { maxLength: 150, className: 'sm:col-span-2' })}
              {text('email', 'Email', { type: 'email', maxLength: 100, placeholder: 'name@example.com' })}
              {text('phone', 'Phone', { maxLength: 50 })}
              <div className="sm:col-span-2">
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription className="text-[14.5px]">
                    A member with neither an email nor a phone number can never look up their own card —
                    verification codes have nowhere to go.
                  </AlertDescription>
                </Alert>
              </div>
            </div>
          </FormSection>

          <FormSection step={4} icon={StickyNote} title="Notes" sub="Optional. Shown on the member's page.">
            <Textarea
              id="notes"
              aria-label="Notes"
              value={formData.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              placeholder="Anything the next administrator should know"
              data-testid="textarea-notes"
            />
          </FormSection>
        </div>

        {/* Summary rail: who is being edited, what has changed, and the one
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
                    {formData.idType} {formData.idNumber.trim()}
                  </div>
                </div>
              </div>
            </div>
            <dl className="divide-y divide-[var(--surface-hairline)] text-[14.5px]">
              {(
                [
                  ['Company', `${member.companyName} (${member.companyNumber})`],
                  ['Class', formData.classCode || null],
                  ['Date of birth', formData.dateOfBirth || null],
                ] as const
              ).map(([term, value]) => (
                <div key={term} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <dt className="text-[var(--fg-3)]">{term}</dt>
                  <dd className={`truncate text-right font-semibold ${value ? 'text-[var(--fg-1)]' : 'text-[var(--fg-4)]'}`}>
                    {value ?? '—'}
                  </dd>
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
              <p className="mt-3 text-[14.5px] text-[var(--fg-3)]">No changes yet. Edit a field to see it here.</p>
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
                ID type, ID number, first name, last name and class are required.
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
                placeholder="e.g., Updated contact information, moved to a new class..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                required
                data-testid="textarea-reason"
              />
              <p className="mt-1.5 text-[13.5px] text-[var(--fg-3)]">Minimum 3 characters. Recorded in the audit log.</p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={updateMutation.isPending || !canSubmit}
                data-testid="button-save"
              >
                <Save className="h-4 w-4" />
                {updateMutation.isPending ? 'Saving...' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setLocation(detailPath)}
                disabled={updateMutation.isPending}
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
