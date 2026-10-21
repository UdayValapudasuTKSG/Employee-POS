import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  useListLookupAlerts,
  useResolveLookupAlert,
  getListLookupAlertsQueryKey,
  getGetAdminDashboardQueryKey,
} from '@workspace/api-client-react';
import type {
  LookupAlert,
  LookupAlertMatch,
  ListLookupAlertsStatus,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/screen-ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { AlertCircle, Mail, Phone } from 'lucide-react';

/** One matched member, linked to its record. */
function MatchLine({ match }: { match: LookupAlertMatch }) {
  return (
    <Link
      href={`/admin/companies/${encodeURIComponent(match.companyNumber)}/members/${match.memberId}`}
      className="text-primary hover:underline"
      data-testid={`link-alert-member-${match.companyNumber}-${match.memberId}`}
    >
      {match.companyName}
      <span className="mono-id ml-1.5 text-xs text-muted-foreground">
        {match.companyNumber} · #{match.memberId}
      </span>
    </Link>
  );
}

function ResolveDialog({ alert, onClose }: { alert: LookupAlert; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const resolveMutation = useResolveLookupAlert();
  const [note, setNote] = useState('');

  const canResolve = note.trim().length >= 3 && !resolveMutation.isPending;

  const resolve = () => {
    resolveMutation.mutate(
      { id: alert.id, data: { note: note.trim() } },
      {
        onSuccess: () => {
          toast({ title: 'Alert resolved', description: 'Your note has been recorded.' });
          queryClient.invalidateQueries({ queryKey: getListLookupAlertsQueryKey() });
          // The dashboard's open-alert count is now one lower.
          queryClient.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() });
          onClose();
        },
        onError: (error: any) => {
          toast({
            title: 'Could not resolve',
            description: error?.data?.error?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resolve lookup alert</DialogTitle>
          <DialogDescription>
            {alert.maskedContact} matched members in {alert.matches.length} companies. Record
            what you found and what, if anything, was changed.
          </DialogDescription>
        </DialogHeader>

        <div>
          <div className="mb-1 text-xs font-semibold">Your note (required, min 3 characters)</div>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Same person employed by both companies; contact confirmed."
            data-testid="textarea-resolve-note"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={resolve} disabled={!canResolve} data-testid="button-confirm-resolve">
            {resolveMutation.isPending ? 'Resolving…' : 'Resolve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Contacts that matched members in more than one company at the card lookup.
 *
 * The lookup itself refuses to pick a company in that case, so each alert is an
 * employee who could not get their card. Only a super admin may read or resolve
 * them, which the server also enforces.
 */
export default function AdminLookupAlerts() {
  const { adminUser } = useAuth();
  const isSuperAdmin = adminUser?.role === 'ROLE_PLATFORM_ADMIN';
  const [status, setStatus] = useState<ListLookupAlertsStatus>('OPEN');
  const [resolving, setResolving] = useState<LookupAlert | null>(null);

  const { data, isLoading, error } = useListLookupAlerts({ status });

  return (
    <div>
      <PageHeader
        title="Lookup alerts"
        description="Contacts that matched members in more than one company at the card lookup"
      />

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Select value={status} onValueChange={(v) => setStatus(v as ListLookupAlertsStatus)}>
            <SelectTrigger className="w-48" data-testid="select-alert-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OPEN">Open</SelectItem>
              <SelectItem value="RESOLVED">Resolved</SelectItem>
              <SelectItem value="ALL">All</SelectItem>
            </SelectContent>
          </Select>
          {data && (
            <span className="text-sm text-muted-foreground" data-testid="text-alert-total">
              {data.length} alert{data.length === 1 ? '' : 's'}
            </span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : error ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Unable to load lookup alerts.</AlertDescription>
              </Alert>
            </div>
          ) : !data || data.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {status === 'OPEN' ? 'No open alerts.' : 'No alerts.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Matched</TableHead>
                  <TableHead>Status</TableHead>
                  {isSuperAdmin && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((a) => {
                  const ChannelIcon = a.lookupChannel === 'PHONE' ? Phone : Mail;
                  return (
                    <TableRow key={a.id} data-testid={`row-lookup-alert-${a.id}`}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {format(new Date(a.createdAt), 'd MMM yyyy, h:mm a')}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-1.5">
                          <ChannelIcon
                            className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                            aria-label={a.lookupChannel === 'PHONE' ? 'Phone' : 'Email'}
                          />
                          <span className="mono-id">{a.maskedContact}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <ul className="space-y-0.5">
                          {a.matches.map((m, i) => (
                            <li key={`${m.companyNumber}-${m.memberId}-${i}`}>
                              <MatchLine match={m} />
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-0 flex-col items-start gap-1">
                          <StatusPill tone={a.status === 'OPEN' ? 'warning' : 'success'}>
                            {a.status === 'OPEN' ? 'Open' : 'Resolved'}
                          </StatusPill>
                          {a.status === 'RESOLVED' && (
                            <div className="text-[12.5px] leading-snug text-[var(--fg-3)]">
                              {a.resolvedBy && <>by {a.resolvedBy}</>}
                              {a.resolvedAt && (
                                <div className="tnum">
                                  {format(new Date(a.resolvedAt), 'd MMM yyyy, h:mm a')}
                                </div>
                              )}
                              {a.resolutionNote && <div>“{a.resolutionNote}”</div>}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      {isSuperAdmin && (
                        <TableCell className="text-right">
                          {a.status === 'OPEN' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setResolving(a)}
                              data-testid={`button-resolve-${a.id}`}
                            >
                              Resolve
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {resolving && <ResolveDialog alert={resolving} onClose={() => setResolving(null)} />}
    </div>
  );
}
