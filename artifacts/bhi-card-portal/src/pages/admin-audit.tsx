import { useState } from 'react';
import { useListAuditLogs } from '@workspace/api-client-react';
import type { ListAuditLogsParams } from '@workspace/api-client-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

export default function AdminAudit() {
  const [filters, setFilters] = useState<ListAuditLogsParams>({
    page: 1,
    pageSize: 20,
  });

  const { data: audit, isLoading } = useListAuditLogs(filters);

  const handleFilterChange = (key: keyof ListAuditLogsParams, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
  };

  const handlePageChange = (page: number) => {
    setFilters((prev) => ({ ...prev, page }));
  };

  return (
    <div>
      <PageHeader title="Audit log" description="System activity and change history" />

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              placeholder="Entity ID..."
              value={filters.entityId || ''}
              onChange={(e) => handleFilterChange('entityId', e.target.value)}
              data-testid="input-entity-id"
            />
            <Input
              placeholder="Actor..."
              value={filters.actor || ''}
              onChange={(e) => handleFilterChange('actor', e.target.value)}
              data-testid="input-actor"
            />
            <Input
              placeholder="Action..."
              value={filters.action || ''}
              onChange={(e) => handleFilterChange('action', e.target.value)}
              data-testid="input-action"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(6)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : audit && audit.items.length > 0 ? (
                  audit.items.map((entry) => (
                    <TableRow key={entry.id} data-testid={`row-audit-${entry.id}`}>
                      <TableCell className="mono-id whitespace-nowrap text-sm">
                        {format(new Date(entry.timestamp), 'MMM d, h:mm:ss a')}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{entry.actor}</div>
                        <div className="text-xs text-muted-foreground">{entry.actorRole}</div>
                      </TableCell>
                      <TableCell className="font-medium">{entry.action}</TableCell>
                      <TableCell>
                        <div className="text-sm">{entry.entityType}</div>
                        {entry.entityId && (
                          <div className="mono-id text-xs text-muted-foreground">#{entry.entityId}</div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-sm">
                        {entry.reason || '—'}
                      </TableCell>
                      <TableCell className="mono-id text-xs text-muted-foreground">
                        {entry.sourceIp || '—'}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No audit entries found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {audit && audit.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {audit.page} of {audit.totalPages} ({audit.totalItems} total)
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(audit.page - 1)}
              disabled={audit.page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(audit.page + 1)}
              disabled={audit.page === audit.totalPages}
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
