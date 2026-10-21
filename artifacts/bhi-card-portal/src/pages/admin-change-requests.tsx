import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  useListChangeRequests,
  useGetChangeRequest,
  useGetChangeRequestDocument,
  useApproveChangeRequest,
  useRejectChangeRequest,
  getListChangeRequestsQueryKey,
  getGetChangeRequestDocumentQueryKey,
} from '@workspace/api-client-react';
import type { ChangeRequestSummary } from '@workspace/api-client-react';
import { PageHeader } from '@/components/page-header';
import { StatusPill, type PillTone } from '@/components/screen-ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  AlertCircle,
} from 'lucide-react';

const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  // A dependant's name is one field, so their correction arrives as fullName.
  fullName: 'Full name',
  dateOfBirth: 'Date of birth',
  relationship: 'Relationship',
};

/** Status as a worded pill; the tone is a hint, the word carries the meaning. */
const STATUS_PILL: Record<string, { label: string; tone: PillTone }> = {
  PENDING: { label: 'Awaiting review', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'error' },
};

/** ROLE_CLIENT_ADMIN -> "Client admin". */
const ROLE_LABELS: Record<string, string> = {
  ROLE_PLATFORM_ADMIN: 'Super admin',
  ROLE_HR_ADMIN: 'HR admin',
  ROLE_CLIENT_ADMIN: 'Client admin',
  ROLE_SUPPORT: 'Support',
  ROLE_AUDITOR: 'Auditor',
};

/** Members are addressed by company and ID; the ID alone is not unique. */
function memberHref(r: { companyNumber: string; memberId: number }) {
  return `/admin/companies/${encodeURIComponent(r.companyNumber)}/members/${r.memberId}`;
}

/**
 * Status plus who decided it. The API only sends `reviewer` to super admins,
 * so every other role sees just the pill.
 */
function StatusWithReviewer({ r }: { r: ChangeRequestSummary }) {
  const pill = STATUS_PILL[r.status] ?? { label: r.status, tone: 'neutral' as const };
  const reviewer = r.reviewer;
  const verb = r.status === 'REJECTED' ? 'Rejected' : 'Approved';
  const role = reviewer?.role ? ROLE_LABELS[reviewer.role] ?? reviewer.role : null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      {reviewer && (
        <div className="min-w-0 text-[12.5px] leading-snug text-[var(--fg-3)]" data-testid={`text-reviewer-${r.id}`}>
          <span className="sr-only">{verb} by </span>
          <span aria-hidden="true">by </span>
          <span className="font-semibold text-[var(--fg-1)]" title={reviewer.email}>
            {reviewer.name}
          </span>
          {role && <span> · {role}</span>}
          {r.reviewedAt && (
            <div className="tnum">{format(new Date(r.reviewedAt), 'd MMM yyyy, h:mm a')}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders the attached proof. See the security note below on why PDFs differ. */
function DocumentViewer({ requestId }: { requestId: string }) {
  const { data, isLoading, error } = useGetChangeRequestDocument(requestId, {
    // A 6.8 MB base64 string must not linger in the query cache.
    query: {
      gcTime: 0,
      staleTime: 0,
      queryKey: getGetChangeRequestDocumentQueryKey(requestId),
    },
  });
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const bytes = Uint8Array.from(atob(data.contentBase64), (c) => c.charCodeAt(0));
    // The Blob type comes from the server's SNIFFED mime, never the filename.
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [data]);

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (error || !data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>The supporting document could not be loaded.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="truncate">
          {data.fileName} · {(data.byteSize / 1024).toFixed(0)} KB
        </span>
        {url && (
          <a
            href={url}
            download={data.fileName}
            className="inline-flex items-center gap-1 text-primary hover:underline"
            data-testid="link-download-document"
          >
            <Download className="h-3 w-3" />
            Download
          </a>
        )}
      </div>

      {/*
        Images render inline. PDFs open in a tab of their own.

        Not embedded, and the constraint is a hard one rather than a preference:
        a blob: URL inherits this page's origin and the admin session token is in
        localStorage, so an <iframe> of a PDF shares an origin with the token.
        Every sandbox value that closes that hole — including bare `sandbox` and
        `sandbox="allow-scripts"` — also stops Chrome rendering the PDF at all,
        so there is no attribute that buys both. Showing it inline would need a
        JavaScript PDF renderer drawing to a <canvas>, which is a dependency this
        build does not carry.

        A new tab is a top-level document rather than part of this page, opened
        with noopener so it holds no handle back to the review screen. The
        reviewer keeps this dialog open behind it and reads the document at full
        size, which is what the download step was standing in the way of.
      */}
      {url && data.mimeType.startsWith('image/') ? (
        <img
          src={url}
          alt={`Supporting document: ${data.fileName}`}
          className="max-h-96 w-full rounded border border-border object-contain"
          data-testid="img-document-preview"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded border border-dashed border-border p-4">
          <FileText className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-sm text-muted-foreground">
            Open the document to check it against the requested change before you decide.
          </div>
          {url && (
            <Button
              type="button"
              size="sm"
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
              data-testid="button-open-document"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Open document
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewDialog({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: detail, isLoading } = useGetChangeRequest(requestId);
  const approveMutation = useApproveChangeRequest();
  const rejectMutation = useRejectChangeRequest();
  const [note, setNote] = useState('');

  const busy = approveMutation.isPending || rejectMutation.isPending;
  const canDecide = note.trim().length >= 3 && !busy && detail?.status === 'PENDING';

  const decide = (kind: 'approve' | 'reject') => {
    const mutation = kind === 'approve' ? approveMutation : rejectMutation;
    mutation.mutate(
      { id: requestId, data: { note: note.trim() } },
      {
        onSuccess: () => {
          toast({
            title: kind === 'approve' ? 'Approved and applied' : 'Request rejected',
            description:
              kind === 'approve'
                ? 'The record has been updated and the change audited.'
                : 'The employee will see your note.',
          });
          queryClient.invalidateQueries({ queryKey: getListChangeRequestsQueryKey() });
          onClose();
        },
        onError: (error: any) => {
          toast({
            title: kind === 'approve' ? 'Could not approve' : 'Could not reject',
            description: error?.data?.error?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review change request</DialogTitle>
          <DialogDescription>
            Check the requested values against the supporting document. Approving applies the
            change immediately and records your note as the audit reason.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !detail ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Member: </span>
                <Link
                  href={memberHref(detail)}
                  className="text-primary hover:underline"
                  data-testid="link-review-member"
                >
                  {detail.memberName}
                </Link>{' '}
                <span className="mono-id text-xs">(#{detail.memberId})</span>
              </div>
              <div>
                <span className="text-muted-foreground">Company: </span>
                {detail.companyName}{' '}
                <span className="mono-id text-xs">({detail.companyNumber})</span>
              </div>
              <div>
                <span className="text-muted-foreground">Subject: </span>
                {detail.subjectName}{' '}
                <Badge variant="secondary">
                  {detail.subjectType === 'MEMBER' ? 'the member' : 'dependant'}
                </Badge>
              </div>
              <div>
                <span className="text-muted-foreground">Raised: </span>
                {format(new Date(detail.createdAt), 'd MMM yyyy, HH:mm')}
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold">Requested changes</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>On record</TableHead>
                    <TableHead>Requested</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.changes.map((c) => (
                    <TableRow key={c.field} data-testid={`change-${c.field}`}>
                      <TableCell className="font-medium">
                        {FIELD_LABELS[c.field] ?? c.field}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{c.current ?? '—'}</TableCell>
                      <TableCell className="font-medium">{c.requested}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {detail.employeeNote && (
              <div>
                <div className="mb-1 text-xs font-semibold">Employee's note</div>
                <p className="rounded border border-border bg-muted/40 p-2 text-sm">
                  {detail.employeeNote}
                </p>
              </div>
            )}

            <div>
              <div className="mb-1 text-xs font-semibold">
                Supporting document
                {detail.document && (
                  <span className="ml-2 font-normal text-muted-foreground">
                    {detail.document.documentType.replace(/_/g, ' ').toLowerCase()}
                  </span>
                )}
              </div>
              {detail.document && !detail.document.purged ? (
                <DocumentViewer requestId={requestId} />
              ) : (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>No document is available for this request.</AlertDescription>
                </Alert>
              )}
            </div>

            {detail.status !== 'PENDING' ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Already {detail.status.toLowerCase()} by {detail.reviewedBy}
                  {detail.reviewNote ? ` — “${detail.reviewNote}”` : ''}.
                </AlertDescription>
              </Alert>
            ) : (
              <div>
                <div className="mb-1 text-xs font-semibold">
                  Your note (required, min 3 characters)
                </div>
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What did you verify, and against which document?"
                  data-testid="textarea-review-note"
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="destructive"
            onClick={() => decide('reject')}
            disabled={!canDecide}
            data-testid="button-reject-change-request"
          >
            Reject
          </Button>
          <Button
            onClick={() => decide('approve')}
            disabled={!canDecide}
            data-testid="button-approve-change-request"
          >
            {approveMutation.isPending ? 'Applying…' : 'Approve and apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminChangeRequests() {
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const { data, isLoading } = useListChangeRequests({ status, page, pageSize: 20 } as never);

  const summary = (r: ChangeRequestSummary) =>
    r.changes.map((c) => FIELD_LABELS[c.field] ?? c.field).join(', ');

  return (
    <div>
      <PageHeader
        title="Change requests"
        description="Employee-raised corrections to their own or a dependant's details"
      />

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-48" data-testid="select-request-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PENDING">Awaiting review</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
              <SelectItem value="ALL">All</SelectItem>
            </SelectContent>
          </Select>
          {data && (
            <span className="text-sm text-muted-foreground" data-testid="text-request-total">
              {data.totalItems} request{data.totalItems === 1 ? '' : 's'}
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
          ) : !data || data.items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Nothing to review.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Fields</TableHead>
                  <TableHead>Proof</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id} data-testid={`row-change-request-${r.id}`}>
                    <TableCell className="text-sm">
                      {format(new Date(r.createdAt), 'd MMM yyyy')}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        href={memberHref(r)}
                        className="hover:underline"
                        data-testid={`link-member-${r.id}`}
                      >
                        {r.memberName}
                      </Link>
                      <div className="mono-id text-xs text-muted-foreground">
                        #{r.memberId} · {r.companyNumber}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.subjectName}
                      {r.subjectType === 'DEPENDENT' && (
                        <div className="text-xs text-muted-foreground">dependant</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{summary(r)}</TableCell>
                    <TableCell>
                      {r.hasDocument ? (
                        <FileText className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <span className="text-xs text-destructive">none</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusWithReviewer r={r} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setReviewing(r.id)}
                        data-testid={`button-review-${r.id}`}
                      >
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data && data.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {data.page} of {data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {reviewing && (
        <ReviewDialog requestId={reviewing} onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}
