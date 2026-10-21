import { useLocation } from 'wouter';
import type { MemberDetail } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Pencil, Plus } from 'lucide-react';
import { format } from 'date-fns';

/** Renders a date that may be absent or unparseable without throwing. */
function showDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : format(d, 'MMM d, yyyy');
}

/**
 * The member's policy, read-only. Adding or editing it happens on its own page
 * (pages/admin-member-policy.tsx), laid out like the member edit form.
 */
export function PolicyPanel({
  member,
  canManage,
}: {
  member: MemberDetail;
  canManage: boolean;
}) {
  const [, setLocation] = useLocation();
  const policy = member.policy;
  const policyPath = `/admin/companies/${encodeURIComponent(member.companyNumber)}/members/${member.memberId}/policy`;

  return (
    <Card data-testid="card-policy">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Policy details</CardTitle>
        {canManage && (
          <Button variant="ghost" size="sm" onClick={() => setLocation(policyPath)} data-testid="button-edit-policy">
            {policy ? <Pencil className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
            {policy ? 'Edit' : 'Add policy'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!policy ? (
          <Alert variant="destructive" data-testid="alert-no-policy">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No policy on file. This member can pass verification but cannot be shown a card
              until a policy is added.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div>
              <div className="text-xs text-muted-foreground">Insurer</div>
              <div className="font-medium">{policy.insurerName}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Plan</div>
              <div className="font-medium">{policy.planName}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Policyholder</div>
              <div className="font-medium">{policy.policyholder}</div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Policy #</div>
                <div className="mono-id text-sm font-medium">{policy.policyNumber}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Group #</div>
                <div className="mono-id text-sm font-medium">{policy.groupNumber}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Member ID</div>
                <div className="mono-id text-sm font-medium">{policy.memberId}</div>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Certificate #</div>
              <div className="mono-id font-medium">{policy.certificateNumber}</div>
            </div>
            <div className="flex gap-4">
              <div>
                <div className="text-xs text-muted-foreground">Effective</div>
                <div className="mono-id text-sm">{showDate(policy.effectiveDate)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Expiry</div>
                <div className="mono-id text-sm">{showDate(policy.expiryDate)}</div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
