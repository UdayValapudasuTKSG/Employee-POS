import { useState } from 'react';
import { Link } from 'wouter';
import {
  useListCompanies,
  useListImportExceptions,
  useResolveImportException,
  getListImportExceptionsQueryKey,
  getGetAdminDashboardQueryKey,
  ImportExceptionItemSource,
  ImportExceptionItemStatus,
} from '@workspace/api-client-react';
import type { ImportExceptionItem } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle2, FileUp } from 'lucide-react';

// HR's fix list: the rows bulk import (or the legacy migration) could not load
// and held back for one company. Nothing is edited here — a held record is
// fixed by correcting the row in the spreadsheet and importing it again, which
// resolves it (and restores any family held with it). A record fixed some
// other way, or no longer needed, is marked resolved by hand with a note. The
// server returns open and resolved together; the tabs only filter what is
// already loaded.

const IMPORT_HREF = '/admin/import';

const ENTITY_LABELS: Record<string, string> = {
  MEMBER: 'Member',
  DEPENDENT: 'Dependant',
  BENEFICIARY: 'Beneficiary',
};

const SOURCE_LABELS: Record<string, string> = {
  [ImportExceptionItemSource.BULK_IMPORT]: 'Bulk import',
  [ImportExceptionItemSource.LEGACY_MIGRATION]: 'Legacy migration',
};

type StatusTab = typeof ImportExceptionItemStatus[keyof typeof ImportExceptionItemStatus];

/** A member's page, addressed by company and the per-company member ID. */
function memberPath(companyNumber: string, memberId: number): string {
  return `/admin/companies/${encodeURIComponent(companyNumber)}/members/${memberId}`;
}

function formatDate(value: string | null, pattern = 'd MMM yyyy'): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : format(date, pattern);
}

/** Where the held row came from: the kind of load, then the file and cell. */
function SourceCell({ item }: { item: ImportExceptionItem }) {
  const file = item.originalFileName ?? item.sourceFile;
  const where = [
    item.sheetName ? `Sheet "${item.sheetName}"` : null,
    item.excelRow !== null ? `row ${item.excelRow}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="min-w-0 text-sm">
      <div>{SOURCE_LABELS[item.source] ?? item.source}</div>
      {file && (
        <div className="mono-id max-w-[220px] truncate text-xs text-muted-foreground" title={file}>
          {file}
        </div>
      )}
      {where && <div className="text-xs text-muted-foreground">{where}</div>}
    </div>
  );
}

/** Marks a held record resolved without an import. The note is required and kept. */
function ResolveDialog({
  companyNumber,
  item,
  onClose,
}: {
  companyNumber: string;
  item: ImportExceptionItem | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mutation = useResolveImportException();
  const [note, setNote] = useState('');
  const close = () => {
    setNote('');
    onClose();
  };
  const submit = () => {
    if (!item) return;
    mutation.mutate(
      { companyNumber, exceptionId: item.exceptionId, data: { note: note.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListImportExceptionsQueryKey(companyNumber) });
          queryClient.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() });
          toast({ title: 'Marked resolved', description: item.personName ?? `Record #${item.exceptionId}` });
          close();
        },
        onError: (e: any) =>
          toast({
            title: 'Could not mark it resolved',
            description: e?.data?.error?.message || 'Try again.',
            variant: 'destructive',
          }),
      },
    );
  };
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark resolved</DialogTitle>
          <DialogDescription>
            {item?.personName || `Record #${item?.exceptionId}`} leaves the fix list. Nothing is loaded — use
            this when the record was fixed another way (entered in the portal, say) or is no longer needed. To
            load a held record, and any family held with it, import the corrected row instead.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="resolve-note">Why (required)</Label>
          <Textarea
            id="resolve-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Added by hand on the member's page"
            className="mt-1.5"
            data-testid="input-resolve-note"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={note.trim().length < 3 || mutation.isPending}
            data-testid="button-confirm-resolve"
          >
            Mark resolved
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminImportExceptions() {
  const { hasPermission, adminUser } = useAuth();
  // Same rule as the server: importing, in a scope that can take writes.
  const canResolve = hasPermission('MEMBER_IMPORT') && !adminUser?.readOnly;
  const [resolving, setResolving] = useState<ImportExceptionItem | null>(null);
  const { data: companies, isLoading: companiesLoading } = useListCompanies();
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<StatusTab>(ImportExceptionItemStatus.OPEN);

  // An admin scoped to one company never has to pick it.
  const companyNumber =
    picked ?? (companies && companies.length === 1 ? companies[0]!.companyNumber : null);

  const { data, isLoading, error } = useListImportExceptions(companyNumber ?? '', {
    query: {
      enabled: companyNumber !== null,
      queryKey: getListImportExceptionsQueryKey(companyNumber ?? ''),
    },
  });

  const rows = data?.exceptions.filter((x) => x.status === tab) ?? [];
  const showResolved = tab === ImportExceptionItemStatus.RESOLVED;
  const showActions = !showResolved && canResolve;
  const columnCount = showResolved || showActions ? 8 : 7;

  return (
    <div>
      <PageHeader
        title="Import exceptions"
        description="Rows bulk import or the migration could not load, held for HR to fix"
        action={
          <Link href={IMPORT_HREF}>
            <Button size="sm" data-testid="button-go-to-import">
              <FileUp className="mr-2 h-4 w-4" />
              Bulk import
            </Button>
          </Link>
        }
      />

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-center">
          <Select value={companyNumber ?? ''} onValueChange={(value) => setPicked(value)}>
            <SelectTrigger className="w-full md:w-72" data-testid="select-company">
              <SelectValue placeholder={companiesLoading ? 'Loading companies…' : 'Choose a company'} />
            </SelectTrigger>
            <SelectContent>
              {companies?.map((company) => (
                <SelectItem key={company.companyNumber} value={company.companyNumber}>
                  {company.companyName}
                  <span className="mono-id ml-2 text-xs text-muted-foreground">
                    {company.companyNumber}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tabs value={tab} onValueChange={(value) => setTab(value as StatusTab)}>
            <TabsList>
              <TabsTrigger value={ImportExceptionItemStatus.OPEN} data-testid="tab-open">
                Open{data ? ` (${data.openCount})` : ''}
              </TabsTrigger>
              <TabsTrigger value={ImportExceptionItemStatus.RESOLVED} data-testid="tab-resolved">
                Resolved{data ? ` (${data.resolvedCount})` : ''}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="text-sm text-muted-foreground md:ml-auto">
            Fix the rows in your spreadsheet and upload them again.{' '}
            <Link href={IMPORT_HREF} className="font-medium text-foreground underline">
              Go to bulk import
            </Link>
          </div>
        </CardContent>
      </Card>

      {companyNumber === null ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {companiesLoading
              ? 'Loading companies…'
              : companies && companies.length === 0
                ? 'No companies are in your scope.'
                : 'Choose a company to see its held records.'}
          </CardContent>
        </Card>
      ) : error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {(error as { data?: { error?: { message?: string } } | null })?.data?.error?.message ||
              'Unable to load the import exceptions for this company.'}
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Identifier</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Reasons</TableHead>
                  <TableHead>Required action</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Held</TableHead>
                  {showResolved && <TableHead>Resolved</TableHead>}
                  {showActions && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(4)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(columnCount)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length > 0 ? (
                  rows.map((item) => (
                    <TableRow key={item.exceptionId} data-testid={`row-exception-${item.exceptionId}`}>
                      <TableCell className="align-top">
                        <div className="font-medium">{item.personName || '—'}</div>
                        <div className="mono-id text-xs text-muted-foreground">#{item.exceptionId}</div>
                      </TableCell>
                      <TableCell className="mono-id align-top text-sm">
                        {item.memberIdentifier || '—'}
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        {item.entityType ? ENTITY_LABELS[item.entityType] ?? item.entityType : '—'}
                      </TableCell>
                      <TableCell className="align-top">
                        {item.reasonCodes.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {item.reasonCodes.map((code) => (
                              <Badge
                                key={code}
                                variant="outline"
                                className="px-1.5 py-0 font-mono text-[10px] font-semibold"
                              >
                                {code}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {item.reason && (
                          <div className="mt-1 max-w-[280px] text-xs text-muted-foreground">
                            {item.reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[260px] align-top text-sm">
                        {item.requiredAction || '—'}
                      </TableCell>
                      <TableCell className="align-top">
                        <SourceCell item={item} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-top text-sm">
                        {formatDate(item.createdAt)}
                      </TableCell>
                      {showResolved && (
                        <TableCell className="align-top text-sm">
                          <div className="whitespace-nowrap">
                            {formatDate(item.resolvedAt, 'd MMM yyyy, h:mm a')}
                          </div>
                          {item.resolvedBy && (
                            <div className="text-xs text-muted-foreground">
                              {item.resolutionMethod === 'MANUAL' ? 'Marked by hand' : 'By import'} · {item.resolvedBy}
                            </div>
                          )}
                          {item.resolutionNote && (
                            <div className="mt-1 max-w-[240px] text-xs italic text-muted-foreground">
                              "{item.resolutionNote}"
                            </div>
                          )}
                          {item.resolvedMemberId !== null && (
                            <Link
                              href={memberPath(data!.companyNumber, item.resolvedMemberId)}
                              className="text-xs font-medium underline"
                              data-testid={`link-resolved-member-${item.exceptionId}`}
                            >
                              View member
                            </Link>
                          )}
                        </TableCell>
                      )}
                      {showActions && (
                        <TableCell className="align-top text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setResolving(item)}
                            data-testid={`button-resolve-${item.exceptionId}`}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            Mark resolved
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                      {showResolved ? 'No resolved records yet.' : 'Nothing held — every imported row loaded.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {companyNumber && (
        <ResolveDialog companyNumber={companyNumber} item={resolving} onClose={() => setResolving(null)} />
      )}
    </div>
  );
}
