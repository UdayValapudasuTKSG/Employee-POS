import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  useListMembers,
  useListCompanies,
  useListClasses,
  getListClassesQueryKey,
  ListMembersActive,
  ListMembersMissingDateOfBirth,
} from '@workspace/api-client-react';
import type { ListMembersParams } from '@workspace/api-client-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActiveBadge } from '@/components/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Search, ChevronLeft, ChevronRight, Plus, Pencil, ShieldCheck, ShieldAlert, ShieldOff, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MemberSummaryPolicyStatus } from '@workspace/api-client-react';

/** Whether a policy is on file, as a small icon beside the name with a tooltip. */
const POLICY_INDICATOR: Record<MemberSummaryPolicyStatus, { icon: typeof ShieldCheck; text: string; className: string }> = {
  ON_FILE: { icon: ShieldCheck, text: 'Policy exists', className: 'text-success' },
  EXPIRED: { icon: ShieldAlert, text: 'Policy expired', className: 'text-warning' },
  NONE: { icon: ShieldOff, text: "Doesn't exist with policy", className: 'text-muted-foreground' },
};

function PolicyIndicator({ status, testId }: { status: MemberSummaryPolicyStatus; testId: string }) {
  const { icon: Icon, text, className } = POLICY_INDICATOR[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex cursor-default ${className}`} aria-label={text} data-testid={testId}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/auth-context';
import { canSeePolicy } from '@/lib/policy-visibility';
import { idTypeLabel } from '@/lib/member-vocab';

/** A member's page, addressed by company and the per-company member ID. */
function memberPath(companyNumber: string, memberId: number): string {
  return `/admin/companies/${encodeURIComponent(companyNumber)}/members/${memberId}`;
}

export default function AdminMembers() {
  const { adminUser, hasPermission } = useAuth();
  const showPolicy = canSeePolicy(adminUser?.role);
  const [, setLocation] = useLocation();
  // The dashboard links here with ?missingDateOfBirth=true.
  const startMissingDob = new URLSearchParams(window.location.search).get('missingDateOfBirth') === 'true';
  const [filters, setFilters] = useState<ListMembersParams>({
    ...(startMissingDob ? { missingDateOfBirth: ListMembersMissingDateOfBirth.true } : {}),
    page: 1,
    pageSize: 20,
    q: '',
    company: undefined,
    active: undefined,
    classCode: undefined,
  });

  const { data: members, isLoading } = useListMembers(filters);
  const { data: companies } = useListCompanies();
  const classParams = { includeRetired: true };
  const { data: classList } = useListClasses(classParams, { query: { queryKey: getListClassesQueryKey(classParams) } });
  const classes = classList?.classes ?? [];

  // Deactivation lives on the member's own page, where the reason dialog and
  // the dependants it affects are in view. The list only offers Edit.
  const canUpdate = hasPermission('MEMBER_UPDATE');
  const columnCount = canUpdate ? 8 : 7;

  const handleSearch = (q: string) => {
    setFilters((prev) => ({ ...prev, q, page: 1 }));
  };

  const handleFilterChange = (key: keyof ListMembersParams, value: string | undefined) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
  };

  const handlePageChange = (page: number) => {
    setFilters((prev) => ({ ...prev, page }));
  };

  return (
    <div>
      <PageHeader
        title="Members"
        description="Search and manage member records"
        action={
          hasPermission('MEMBER_CREATE') ? (
            <Link href="/admin/members/new">
              <Button size="sm" data-testid="button-new-member">
                <Plus className="mr-2 h-4 w-4" />
                New member
              </Button>
            </Link>
          ) : undefined
        }
      />

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 md:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, ID number, or contact..."
                value={filters.q}
                onChange={(e) => handleSearch(e.target.value)}
                className="pl-10"
                data-testid="input-search"
              />
            </div>
            <Select
              value={filters.company || 'all'}
              onValueChange={(value) => handleFilterChange('company', value === 'all' ? undefined : value)}
            >
              <SelectTrigger className="w-full md:w-48" data-testid="select-company">
                <SelectValue placeholder="All companies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All companies</SelectItem>
                {companies?.map((company) => (
                  <SelectItem key={company.companyNumber} value={company.companyNumber}>
                    {company.companyName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.active || 'all'}
              onValueChange={(value) => handleFilterChange('active', value === 'all' ? undefined : value)}
            >
              <SelectTrigger className="w-full md:w-40" data-testid="select-status">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                {/* The BHI Active flag is the only status; omitting the filter
                    returns both, which is what the server does by default. */}
                <SelectItem value="all">All</SelectItem>
                <SelectItem value={ListMembersActive.true}>Active</SelectItem>
                <SelectItem value={ListMembersActive.false}>Inactive</SelectItem>
              </SelectContent>
            </Select>
            {/* Every class, retired ones too: members can still carry them. */}
            <Select
              value={filters.classCode || 'all'}
              onValueChange={(value) => handleFilterChange('classCode', value === 'all' ? undefined : value)}
            >
              <SelectTrigger className="w-full md:w-40" aria-label="Class" data-testid="select-class-code">
                <SelectValue placeholder="All classes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All classes</SelectItem>
                {classes.map((c) => (
                  <SelectItem key={c.classCode} value={c.classCode}>
                    {c.className && c.className !== c.classCode ? `${c.classCode} — ${c.className}` : c.classCode}
                    {!c.active && ' (retired)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* There is no date-of-birth filter control; this filter only arrives
              from the dashboard's "No date of birth" link, so it is shown here
              with a way out rather than left applied invisibly. */}
          {filters.missingDateOfBirth && (
            <div className="mt-4 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-50)] py-1 pl-3 pr-1 text-[13.5px] font-semibold text-[var(--brand-700)]">
                No date of birth
                <button
                  type="button"
                  onClick={() => handleFilterChange('missingDateOfBirth', undefined)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--brand-100)]"
                  aria-label="Clear the no-date-of-birth filter"
                  data-testid="button-clear-missing-dob"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Dependents</TableHead>
                {canUpdate && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(columnCount)].map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : members && members.items.length > 0 ? (
                members.items.map((member) => {
                  // Member IDs are per company, so the pair is the row's key.
                  const key = `${member.companyNumber}-${member.memberId}`;
                  const href = memberPath(member.companyNumber, member.memberId);
                  return (
                    <TableRow key={key} data-testid={`row-member-${key}`}>
                      <TableCell className="mono-id font-medium">
                        <Link href={href} className="hover:underline" data-testid={`link-member-${key}`}>
                          <span className="text-muted-foreground">{idTypeLabel(member.idType)}</span> {member.idNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          {member.firstName} {member.lastName}
                          {showPolicy && <PolicyIndicator status={member.policyStatus} testId={`policy-${key}`} />}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div>{member.companyName}</div>
                        <div className="mono-id text-xs">{member.companyNumber}</div>
                      </TableCell>
                      <TableCell className="mono-id">{member.classCode}</TableCell>
                      <TableCell className="mono-id">
                        <div className="max-w-[260px] truncate text-[14px] font-medium text-[var(--fg-1)]" title={member.email || undefined}>
                          {member.email || '—'}
                        </div>
                        {member.phone && (
                          <div className="mt-0.5 text-[13px] text-[var(--fg-3)]">{member.phone}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <ActiveBadge active={member.active} />
                      </TableCell>
                      <TableCell className="text-center text-muted-foreground">
                        {member.activeDependentCount}
                      </TableCell>
                      {canUpdate && (
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit member"
                              onClick={() => setLocation(`${href}/edit`)}
                              data-testid={`button-edit-member-${key}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                    No members found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {members && members.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {members.page} of {members.totalPages} ({members.totalItems} total)
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(members.page - 1)}
              disabled={members.page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(members.page + 1)}
              disabled={members.page === members.totalPages}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
