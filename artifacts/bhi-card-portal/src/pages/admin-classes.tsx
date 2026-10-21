import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClasses,
  getListClassesQueryKey,
  useCreateClass,
  useUpdateClass,
  getGetRateCardQueryKey,
  type ClassItem,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/screen-ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useApiErrorToast } from '@/lib/api-errors';
import { AlertCircle, Info, Plus } from 'lucide-react';

// The classes every company shares (spec FR-021, FR-022). A class code is one
// letter or digit, so there can never be more than 36. A class is retired,
// never deleted: members who carry it keep it. A new class is not assignable
// until all four of its standard tiers are priced on the Rates page.

const RATES_HREF = '/admin/rates';
const CLASS_CODE_RE = /^[A-Z0-9]$/;
const MAX_CLASS_CODES = 36;

/** Titles for the refusals this page can meet; the server's message is the description. */
const ERROR_TITLES: Record<string, string> = {
  CLASS_EXISTS: 'Class code already in use',
  CLASS_CODES_EXHAUSTED: 'No class codes left',
  INVALID_INPUT: 'Check the details',
};

/** Rates for this class, opened on the "Add rate set" tab with the class picked. */
function addRatesPath(classCode: string): string {
  return `${RATES_HREF}?tab=add&class=${encodeURIComponent(classCode)}`;
}

/** Blank optional fields go to the server as null rather than empty strings. */
const optional = (v: string) => (v.trim() ? v.trim() : null);

/** A blank sort order is null; anything else must be a whole number. */
function parseSortOrder(v: string): { ok: boolean; value: number | null } {
  const trimmed = v.trim();
  if (!trimmed) return { ok: true, value: null };
  return /^-?\d{1,6}$/.test(trimmed) ? { ok: true, value: Number(trimmed) } : { ok: false, value: null };
}

function useInvalidateClasses() {
  const queryClient = useQueryClient();
  return () => {
    // No params: prefix-matches the list with and without retired classes.
    queryClient.invalidateQueries({ queryKey: getListClassesQueryKey() });
    // Class names and retired flags also show on the rate card.
    queryClient.invalidateQueries({ queryKey: getGetRateCardQueryKey() });
  };
}

const EMPTY_FORM = { classCode: '', className: '', description: '', sortOrder: '', reason: '' };

function AddClassDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(ERROR_TITLES);
  const invalidate = useInvalidateClasses();
  const createMutation = useCreateClass();
  const [form, setForm] = useState(EMPTY_FORM);

  const set = (field: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [field]: e.target.value });

  const close = () => {
    setForm(EMPTY_FORM);
    onClose();
  };

  const code = form.classCode.trim().toUpperCase();
  const sort = parseSortOrder(form.sortOrder);
  const codeInvalid = code.length > 0 && !CLASS_CODE_RE.test(code);
  const valid =
    CLASS_CODE_RE.test(code) &&
    form.className.trim().length > 0 &&
    sort.ok &&
    form.reason.trim().length >= 3;

  const submit = () => {
    createMutation.mutate(
      {
        data: {
          classCode: code,
          className: form.className.trim(),
          description: optional(form.description),
          sortOrder: sort.value,
          reason: form.reason.trim(),
        },
      },
      {
        onSuccess: (created) => {
          invalidate();
          toast({
            title: 'Class added',
            description: `${created.classCode} — ${created.className}. Price its four standard tiers before giving it to members.`,
          });
          close();
        },
        onError: (e: any) => apiError(e, 'Unable to add the class'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add class</DialogTitle>
          <DialogDescription>
            Classes are shared by every company. The class cannot be given to members until its four standard tiers
            are priced on the Rates page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="class-code">Code</Label>
              <Input
                id="class-code"
                value={form.classCode}
                onChange={(e) => setForm({ ...form, classCode: e.target.value.toUpperCase() })}
                maxLength={1}
                placeholder="A–Z, 0–9"
                className="mono-id mt-1.5"
                aria-invalid={codeInvalid}
                data-testid="input-class-code"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="class-name">Name</Label>
              <Input
                id="class-name"
                value={form.className}
                onChange={set('className')}
                maxLength={50}
                className="mt-1.5"
                data-testid="input-class-name"
              />
            </div>
          </div>
          {codeInvalid && (
            <p className="text-xs text-destructive">The code is one letter or digit (A–Z, 0–9).</p>
          )}
          <div>
            <Label htmlFor="class-description">Description (optional)</Label>
            <Textarea
              id="class-description"
              rows={2}
              value={form.description}
              onChange={set('description')}
              maxLength={255}
              className="mt-1.5"
              data-testid="textarea-class-description"
            />
          </div>
          <div>
            <Label htmlFor="class-sort">Sort order (optional)</Label>
            <Input
              id="class-sort"
              inputMode="numeric"
              value={form.sortOrder}
              onChange={set('sortOrder')}
              className="tnum mt-1.5 w-32"
              aria-invalid={!sort.ok}
              data-testid="input-class-sort"
            />
            {!sort.ok && <p className="mt-1 text-xs text-destructive">Sort order is a whole number.</p>}
          </div>
          <div>
            <Label htmlFor="class-reason">Reason (required, min 3 characters)</Label>
            <Textarea
              id="class-reason"
              rows={2}
              value={form.reason}
              onChange={set('reason')}
              className="mt-1.5"
              data-testid="textarea-class-reason"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || createMutation.isPending} data-testid="button-confirm-add-class">
            {createMutation.isPending ? 'Adding…' : 'Add class'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Rename, re-describe or reorder a class. The code never changes. */
function EditClassDialog({ item, onClose }: { item: ClassItem; onClose: () => void }) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(ERROR_TITLES);
  const invalidate = useInvalidateClasses();
  const updateMutation = useUpdateClass();
  const [className, setClassName] = useState(item.className);
  const [description, setDescription] = useState(item.description ?? '');
  const [sortOrder, setSortOrder] = useState(item.sortOrder === null ? '' : String(item.sortOrder));
  const [reason, setReason] = useState('');

  const sort = parseSortOrder(sortOrder);
  const changed =
    className.trim() !== item.className ||
    optional(description) !== (item.description ?? null) ||
    sort.value !== item.sortOrder;
  const valid = className.trim().length > 0 && sort.ok && changed && reason.trim().length >= 3;

  const submit = () => {
    updateMutation.mutate(
      {
        classCode: item.classCode,
        data: {
          className: className.trim(),
          description: optional(description),
          sortOrder: sort.value,
          reason: reason.trim(),
        },
      },
      {
        onSuccess: (updated) => {
          invalidate();
          toast({ title: 'Class updated', description: `${updated.classCode} — ${updated.className}` });
          onClose();
        },
        onError: (e: any) => apiError(e, 'Unable to update the class'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit class {item.classCode}</DialogTitle>
          <DialogDescription>
            The code cannot change. Members carrying this class keep it; only its name, description and order change.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="edit-class-name">Name</Label>
            <Input
              id="edit-class-name"
              value={className}
              onChange={(e) => setClassName(e.target.value)}
              maxLength={50}
              className="mt-1.5"
              data-testid="input-edit-class-name"
            />
          </div>
          <div>
            <Label htmlFor="edit-class-description">Description (optional)</Label>
            <Textarea
              id="edit-class-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={255}
              className="mt-1.5"
              data-testid="textarea-edit-class-description"
            />
          </div>
          <div>
            <Label htmlFor="edit-class-sort">Sort order (optional)</Label>
            <Input
              id="edit-class-sort"
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="tnum mt-1.5 w-32"
              aria-invalid={!sort.ok}
              data-testid="input-edit-class-sort"
            />
            {!sort.ok && <p className="mt-1 text-xs text-destructive">Sort order is a whole number.</p>}
          </div>
          <div>
            <Label htmlFor="edit-class-reason">Reason (required, min 3 characters)</Label>
            <Textarea
              id="edit-class-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5"
              data-testid="textarea-edit-class-reason"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || updateMutation.isPending} data-testid="button-confirm-edit-class">
            {updateMutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Retire or reactivate, both of which need a reason for the audit trail. */
function StatusDialog({ item, onClose }: { item: ClassItem; onClose: () => void }) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(ERROR_TITLES);
  const invalidate = useInvalidateClasses();
  const updateMutation = useUpdateClass();
  const [reason, setReason] = useState('');

  const retiring = item.active;

  const submit = () => {
    updateMutation.mutate(
      { classCode: item.classCode, data: { active: !retiring, reason: reason.trim() } },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: retiring ? 'Class retired' : 'Class reactivated',
            description: `${item.classCode} — ${item.className}`,
          });
          onClose();
        },
        onError: (e: any) => apiError(e, retiring ? 'Unable to retire the class' : 'Unable to reactivate the class'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {retiring ? 'Retire' : 'Reactivate'} class {item.classCode} — {item.className}
          </DialogTitle>
          <DialogDescription>
            {retiring
              ? `The class can no longer be given to members. The ${item.memberCount} member${
                  item.memberCount === 1 ? '' : 's'
                } who carry it keep it, and it can be reactivated later.`
              : 'The class can be given to members again, as long as its four standard tiers are priced.'}
          </DialogDescription>
        </DialogHeader>
        <div>
          <div className="mb-1 text-xs font-semibold">Reason (required, min 3 characters)</div>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="textarea-class-status-reason"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={retiring ? 'destructive' : 'default'}
            onClick={submit}
            disabled={reason.trim().length < 3 || updateMutation.isPending}
            data-testid="button-confirm-class-status"
          >
            {updateMutation.isPending ? 'Saving…' : retiring ? 'Retire class' : 'Reactivate class'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The classes shared by every company. Everyone can read them; only a super
 * admin (CLASS_MANAGE) adds, edits, retires or reactivates one.
 */
export default function AdminClasses() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('CLASS_MANAGE');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClassItem | null>(null);
  const [statusTarget, setStatusTarget] = useState<ClassItem | null>(null);

  const params = { includeRetired };
  const { data, isLoading, error } = useListClasses(params, {
    query: { queryKey: getListClassesQueryKey(params) },
  });
  const classes = data?.classes ?? [];
  const needsRates = classes.filter((c) => c.active && !c.rateComplete);
  const columnCount = canManage ? 8 : 7;

  return (
    <div>
      <PageHeader
        title="Classes"
        description={`The classes shared by every company. A code is one letter or digit, so there can be at most ${MAX_CLASS_CODES}.`}
        action={
          canManage ? (
            <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-class">
              <Plus className="mr-2 h-4 w-4" />
              Add class
            </Button>
          ) : undefined
        }
      />

      <Alert className="mb-6">
        <Info className="h-4 w-4" />
        <AlertDescription>
          A new class cannot be given to members until its four standard tiers — Employee only, Employee +1, Employee
          +2 and Employee + more than two — are priced.{' '}
          <Link href={RATES_HREF} className="font-medium text-foreground underline" data-testid="link-rates">
            Go to rates
          </Link>
          {needsRates.length > 0 && (
            <>
              {' '}
              ({needsRates.length} active class{needsRates.length === 1 ? '' : 'es'} still{' '}
              {needsRates.length === 1 ? 'needs' : 'need'} rates.)
            </>
          )}
        </AlertDescription>
      </Alert>

      <div className="mb-4 flex items-center gap-2">
        <Switch
          id="include-retired"
          checked={includeRetired}
          onCheckedChange={setIncludeRetired}
          data-testid="switch-include-retired"
        />
        <Label htmlFor="include-retired" className="text-sm font-normal">
          Include retired classes
        </Label>
      </div>

      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Unable to load classes.</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Sort order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Rates</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  {canManage && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(4)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(columnCount)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-16" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : classes.length > 0 ? (
                  classes.map((c) => (
                    <TableRow key={c.classCode} data-testid={`row-class-${c.classCode}`}>
                      <TableCell className="mono-id font-medium">{c.classCode}</TableCell>
                      <TableCell>{c.className}</TableCell>
                      <TableCell className="max-w-xs text-sm text-muted-foreground">{c.description ?? '—'}</TableCell>
                      <TableCell className="tnum text-right">{c.sortOrder ?? '—'}</TableCell>
                      <TableCell>
                        <StatusPill tone={c.active ? 'success' : 'neutral'}>{c.active ? 'Active' : 'Retired'}</StatusPill>
                      </TableCell>
                      <TableCell>
                        {c.rateComplete ? (
                          <StatusPill tone="success">Rates complete</StatusPill>
                        ) : canManage ? (
                          <Link href={addRatesPath(c.classCode)} data-testid={`link-class-rates-${c.classCode}`}>
                            <StatusPill tone="warning" className="cursor-pointer underline-offset-2 hover:underline">
                              Needs rates
                            </StatusPill>
                          </Link>
                        ) : (
                          <StatusPill tone="warning">Needs rates</StatusPill>
                        )}
                      </TableCell>
                      <TableCell className="tnum text-right">{c.memberCount}</TableCell>
                      {canManage && (
                        <TableCell className="whitespace-nowrap text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditTarget(c)}
                            data-testid={`button-edit-class-${c.classCode}`}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-2"
                            onClick={() => setStatusTarget(c)}
                            data-testid={`button-class-status-${c.classCode}`}
                          >
                            {c.active ? 'Retire' : 'Reactivate'}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                      {includeRetired ? 'No classes yet' : 'No active classes'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canManage && <AddClassDialog open={addOpen} onClose={() => setAddOpen(false)} />}
      {editTarget && <EditClassDialog item={editTarget} onClose={() => setEditTarget(null)} />}
      {statusTarget && <StatusDialog item={statusTarget} onClose={() => setStatusTarget(null)} />}
    </div>
  );
}
