import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListVerifications,
  useResetVerificationLock,
  getListVerificationsQueryKey,
} from '@workspace/api-client-react';
import type { ListVerificationsParams } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { ChevronLeft, ChevronRight, Unlock } from 'lucide-react';
import { format } from 'date-fns';

export default function AdminVerifications() {
  const [filters, setFilters] = useState<ListVerificationsParams>({
    page: 1,
    pageSize: 20,
  });
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: verifications, isLoading } = useListVerifications(filters);
  const unlockMutation = useResetVerificationLock();

  const canUnlock = hasPermission('SESSION_MANAGE');
  const [unlockId, setUnlockId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const handlePageChange = (page: number) => {
    setFilters((prev) => ({ ...prev, page }));
  };

  const handleUnlock = () => {
    if (!unlockId || reason.trim().length < 3) return;
    unlockMutation.mutate(
      { id: unlockId, data: { reason: reason.trim() } },
      {
        onSuccess: (result) => {
          toast({ title: 'Session unlocked', description: result.message });
          queryClient.invalidateQueries({ queryKey: getListVerificationsQueryKey() });
          setUnlockId(null);
          setReason('');
        },
        onError: (error: any) => {
          toast({
            title: 'Could not unlock',
            description: error?.data?.error?.message || 'Please try again',
            variant: 'destructive',
          });
        },
      }
    );
  };

  return (
    <div>
      <PageHeader
        title="Verifications"
        description="Card verification attempts and status"
      />

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  {canUnlock && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(canUnlock ? 9 : 8)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : verifications && verifications.items.length > 0 ? (
                  verifications.items.map((verification) => (
                    <TableRow key={verification.id} data-testid={`row-verification-${verification.id}`}>
                      <TableCell className="mono-id text-sm font-medium">
                        {verification.id.slice(0, 8)}
                      </TableCell>
                      <TableCell className="capitalize">
                        {verification.lookupChannel.toLowerCase()}
                      </TableCell>
                      <TableCell className="mono-id text-sm">
                        {verification.maskedDestination}
                      </TableCell>
                      <TableCell className="text-sm">
                        {verification.companyCode || '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={verification.status} />
                      </TableCell>
                      <TableCell className="text-center">{verification.attempts}</TableCell>
                      <TableCell className="mono-id whitespace-nowrap text-sm">
                        {format(new Date(verification.createdAt), 'MMM d, h:mm a')}
                      </TableCell>
                      <TableCell className="mono-id whitespace-nowrap text-sm">
                        {format(new Date(verification.expiresAt), 'MMM d, h:mm a')}
                      </TableCell>
                      {canUnlock && (
                        <TableCell className="text-right">
                          {verification.status === 'LOCKED' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setUnlockId(verification.id);
                                setReason('');
                              }}
                              data-testid={`button-unlock-${verification.id}`}
                            >
                              <Unlock className="mr-2 h-3.5 w-3.5" />
                              Unlock
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={canUnlock ? 9 : 8} className="h-24 text-center text-muted-foreground">
                      No verifications found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {verifications && verifications.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {verifications.page} of {verifications.totalPages} ({verifications.totalItems} total)
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(verifications.page - 1)}
              disabled={verifications.page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(verifications.page + 1)}
              disabled={verifications.page === verifications.totalPages}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog open={unlockId !== null} onOpenChange={(o) => !o && setUnlockId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlock this verification</DialogTitle>
            <DialogDescription>
              Gives the member three fresh attempts on the code they already received. No new code
              is sent — they can request one themselves from the verification screen.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason — recorded in the audit trail. At least 3 characters."
              rows={3}
              data-testid="textarea-unlock-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlockId(null)} disabled={unlockMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={handleUnlock}
              disabled={reason.trim().length < 3 || unlockMutation.isPending}
              data-testid="button-confirm-unlock"
            >
              {unlockMutation.isPending ? 'Unlocking...' : 'Unlock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
