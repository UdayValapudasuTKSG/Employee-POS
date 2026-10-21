// The member-facing correction request.
//
// Two names for one thing, on purpose. Members and HR see "Request for
// correction (RFC)"; the API route, the change_requests table, the generated
// client and this file's own name all say Request For Modification. The
// initialism the business uses changed, the schema did not, and renaming a
// database column and a published endpoint to follow a label would be a
// migration and a breaking API change for no functional gain.
//
// So: every string a user reads says RFC. Every identifier — the filename,
// RfmDialog, the rfm-* element ids and data-testids the smoke tests select on —
// stays RFM and matches the backend it talks to. Change the strings freely;
// leave the identifiers alone unless the API is being renamed too.

import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateChangeRequest,
  useListOwnChangeRequests,
  getListOwnChangeRequestsQueryKey,
  DependentRelationship,
} from '@workspace/api-client-react';
import type { CardPayload, ChangeRequestDocumentType } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { isFutureDate, TODAY } from '@/lib/dates';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { FilePlus2, Upload, X, AlertCircle } from 'lucide-react';

/** The Access list a dependant's relationship can be changed to (API DependentRelationship). */
const RELATIONSHIPS = Object.values(DependentRelationship);

const DOCUMENT_TYPES: { value: ChangeRequestDocumentType; label: string }[] = [
  { value: 'BIRTH_CERTIFICATE', label: 'Birth certificate' },
  { value: 'NATIONAL_ID', label: 'National ID' },
  { value: 'DRIVERS_LICENCE', label: "Driver's licence" },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'MARRIAGE_CERTIFICATE', label: 'Marriage certificate' },
  { value: 'OTHER', label: 'Other supporting document' },
];

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = '.pdf,.jpg,.jpeg,.png';
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

/**
 * What can be corrected. The member ticks what they are changing, and only
 * ticked fields are sent.
 *
 * This exists because the previous form inferred intent from whichever boxes
 * had text in them, which made "leave it blank to keep it" the only signal —
 * easy to misread, and impossible to express "this name is right, I am only
 * fixing the date". A tick is explicit, and unticking a field clears whatever
 * was typed so a stale value can never be submitted.
 *
 * `relationship` is offered only for a dependant; a member has none. A
 * dependant has one full-name field in the BHI model, so a dependant's name is
 * one `fullName` box while the member keeps first and last name.
 */
const CHANGEABLE = [
  { key: 'firstName', label: 'First name', who: 'member' },
  { key: 'lastName', label: 'Last name', who: 'member' },
  { key: 'fullName', label: 'Full name', who: 'dependant' },
  { key: 'dateOfBirth', label: 'Date of birth', who: 'both' },
  { key: 'relationship', label: 'Relationship', who: 'dependant' },
] as const;

type ChangeableKey = (typeof CHANGEABLE)[number]['key'];

const NO_FIELDS: Record<ChangeableKey, boolean> = {
  firstName: false,
  lastName: false,
  fullName: false,
  dateOfBirth: false,
  relationship: false,
};

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Reads a File as bare base64.
 *
 * Uses FileReader rather than String.fromCharCode(...new Uint8Array(buf)), which
 * blows the argument limit somewhere around 100 kB and would fail on every real
 * document.
 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function RfmDialog({ card }: { card: CardPayload }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  // 'me' rather than '' so the Select always has a real value.
  const [subject, setSubject] = useState<string>('me');
  const [fields, setFields] = useState<Record<ChangeableKey, boolean>>({ ...NO_FIELDS });
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [fullName, setFullName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [relationship, setRelationship] = useState('');
  const [note, setNote] = useState('');
  const [documentType, setDocumentType] =
    useState<ChangeRequestDocumentType>('BIRTH_CERTIFICATE');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createMutation = useCreateChangeRequest();
  const { data: existing } = useListOwnChangeRequests({
    query: { enabled: open, queryKey: getListOwnChangeRequestsQueryKey() },
  });

  const dependants = card.dependents;
  const isDependant = subject !== 'me';
  const selected = useMemo(
    () => dependants.find((d) => d.id === subject),
    [dependants, subject],
  );

  const current = isDependant
    ? {
        firstName: '',
        lastName: '',
        fullName: selected?.fullName ?? '',
        dateOfBirth: selected?.dateOfBirth ?? '',
        relationship: selected?.relationship ?? '',
      }
    : {
        // The card carries the member's full name as one string.
        firstName: card.employeeName.split(' ')[0] ?? '',
        lastName: card.employeeName.split(' ').slice(1).join(' '),
        fullName: card.employeeName,
        dateOfBirth: '',
        relationship: '',
      };

  const clearFields = () => {
    setFields({ ...NO_FIELDS });
    setFirstName('');
    setLastName('');
    setFullName('');
    setDateOfBirth('');
    setRelationship('');
  };

  const reset = () => {
    setSubject('me');
    clearFields();
    setNote('');
    setDocumentType('BIRTH_CERTIFICATE');
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** Unticking a field must also drop what was typed into it. */
  const toggleField = (key: ChangeableKey, on: boolean) => {
    setFields((prev) => ({ ...prev, [key]: on }));
    if (on) return;
    if (key === 'firstName') setFirstName('');
    if (key === 'lastName') setLastName('');
    if (key === 'fullName') setFullName('');
    if (key === 'dateOfBirth') setDateOfBirth('');
    if (key === 'relationship') setRelationship('');
  };

  /**
   * The pending request for the SUBJECT currently selected, which is the unit
   * the server limits — one open request per person, not per member.
   *
   * Matched on subjectType and name because that is all the member's own view
   * of a request exposes; it carries no dependant id. Two dependants with the
   * same name would confuse this hint, and only this hint — the server does the
   * real check against the dependant id and rejects the submission either way.
   */
  const pendingForSubject = (existing ?? []).find((r) => {
    if (r.status !== 'PENDING') return false;
    if (!isDependant) return r.subjectType === 'MEMBER';
    return (
      r.subjectType === 'DEPENDENT' &&
      r.subjectName === (selected?.fullName ?? '').trim()
    );
  });

  // Mirrors the server: at least one TICKED field, and it must differ from what
  // is on record. Checked here only to disable the button — the server decides.
  const changed = [
    !isDependant && fields.firstName && firstName.trim() && firstName.trim() !== current.firstName,
    !isDependant && fields.lastName && lastName.trim() && lastName.trim() !== current.lastName,
    isDependant && fields.fullName && fullName.trim() && fullName.trim() !== current.fullName,
    fields.dateOfBirth && dateOfBirth.trim() && dateOfBirth.trim() !== current.dateOfBirth,
    isDependant &&
      fields.relationship &&
      relationship &&
      relationship !== current.relationship,
  ].some(Boolean);

  const canSubmit =
    changed && file !== null && !pendingForSubject && !createMutation.isPending;

  const chooseFile = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_BYTES) {
      toast({
        title: 'File too large',
        description: `${picked.name} is ${(picked.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`,
        variant: 'destructive',
      });
      return;
    }
    if (picked.type && !ALLOWED_MIME.includes(picked.type)) {
      toast({
        title: 'Unsupported file type',
        description: 'Attach a PDF, JPEG or PNG.',
        variant: 'destructive',
      });
      return;
    }
    setFile(picked);
  };

  const submit = async () => {
    if (!file) return;
    let contentBase64: string;
    try {
      contentBase64 = await readAsBase64(file);
    } catch {
      toast({
        title: 'Could not read the file',
        description: 'Try attaching it again.',
        variant: 'destructive',
      });
      return;
    }

    createMutation.mutate(
      {
        data: {
          dependentId: isDependant ? subject : null,
          // Only ticked fields travel. An unticked one is null, which the API
          // reads as "leave this as it is".
          // A dependant's full name travels whole in requestedFirstName with
          // no last name; the server stores it as the dependant's full name.
          requestedFirstName: isDependant
            ? (fields.fullName && fullName.trim()) || null
            : (fields.firstName && firstName.trim()) || null,
          requestedLastName: isDependant ? null : (fields.lastName && lastName.trim()) || null,
          requestedDateOfBirth: (fields.dateOfBirth && dateOfBirth.trim()) || null,
          requestedRelationship:
            isDependant && fields.relationship && relationship
              ? (relationship as never)
              : null,
          employeeNote: note.trim() || null,
          document: {
            documentType,
            fileName: file.name,
            // The browser's guess. The server re-derives it from the file's
            // magic bytes and rejects a mismatch.
            mimeType: (file.type || 'application/pdf') as never,
            contentBase64,
          },
        },
      },
      {
        onSuccess: () => {
          toast({
            title: 'Request submitted',
            description: 'Your HR department will review it and the supporting document.',
          });
          queryClient.invalidateQueries({ queryKey: getListOwnChangeRequestsQueryKey() });
          reset();
          setOpen(false);
        },
        onError: (error: any) => {
          toast({
            title: 'Could not submit the request',
            description: error?.data?.error?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <>
      {/*
        Deliberately the largest control on the card, and the only filled one.
        A member who spots a wrong name has to find this; "RFC" at the same
        weight as Print told them nothing and looked like a third way to export
        the card. The initialism stays, in brackets, because HR uses it.

        The words carry the meaning and the initialism only tags along, which is
        why this reads "correction" rather than the "modification" the API,
        database and docs still use — see the note at the top of this file.
      */}
      <Button
        size="lg"
        onClick={() => setOpen(true)}
        className="w-full text-base font-semibold sm:w-auto"
        data-testid="button-rfm"
      >
        <FilePlus2 className="mr-2 h-5 w-5" />
        Request for correction (RFC)
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Request for correction (RFC)</DialogTitle>
            <DialogDescription>
              Ask your HR department to correct your details or a dependant's. Tick what is
              wrong, give the correct value, and attach proof — a birth certificate, national
              ID, driver's licence or passport. One request per person at a time.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {pendingForSubject && (
              <Alert variant="destructive" data-testid="alert-rfm-pending">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {isDependant
                    ? `${pendingForSubject.subjectName} already has a request awaiting review.`
                    : 'You already have a request awaiting review for your own details.'}{' '}
                  Only one correction per person can be open at a time — wait for HR to
                  decide it before raising another.
                </AlertDescription>
              </Alert>
            )}

            <div>
              <Label htmlFor="rfm-subject">Who needs correcting?</Label>
              <Select
                value={subject}
                onValueChange={(v) => {
                  setSubject(v);
                  // A tick means "change this person's first name"; carrying it
                  // to a different person would be a different claim entirely.
                  clearFields();
                }}
              >
                <SelectTrigger id="rfm-subject" data-testid="select-rfm-subject">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">Me — {card.employeeName}</SelectItem>
                  {dependants.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.fullName} ({title(d.relationship)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-lg border border-border p-3">
              <div className="mb-1 text-sm font-medium">What needs changing?</div>
              <p className="mb-3 text-xs text-muted-foreground">
                Tick each detail you are correcting. Anything left unticked stays exactly
                as it is.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {CHANGEABLE.filter((f) => f.who === 'both' || f.who === (isDependant ? 'dependant' : 'member')).map((f) => (
                  <label
                    key={f.key}
                    htmlFor={`rfm-tick-${f.key}`}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                  >
                    <Checkbox
                      id={`rfm-tick-${f.key}`}
                      checked={fields[f.key]}
                      onCheckedChange={(v) => toggleField(f.key, v === true)}
                      data-testid={`checkbox-rfm-${f.key}`}
                    />
                    <span className="text-sm">{f.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Only the ticked fields get an input, so the form shows exactly
                what is being claimed and nothing else. */}
            {isDependant && fields.fullName && (
              <div>
                <Label htmlFor="rfm-full">New full name</Label>
                <Input
                  id="rfm-full"
                  value={fullName}
                  placeholder={current.fullName || '—'}
                  onChange={(e) => setFullName(e.target.value)}
                  data-testid="input-rfm-full-name"
                />
                {current.fullName && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    On record: {current.fullName}
                  </p>
                )}
              </div>
            )}

            {!isDependant && (fields.firstName || fields.lastName) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.firstName && (
                  <div>
                    <Label htmlFor="rfm-first">New first name</Label>
                    <Input
                      id="rfm-first"
                      value={firstName}
                      placeholder={current.firstName || '—'}
                      onChange={(e) => setFirstName(e.target.value)}
                      data-testid="input-rfm-first-name"
                    />
                    {current.firstName && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        On record: {current.firstName}
                      </p>
                    )}
                  </div>
                )}
                {fields.lastName && (
                  <div>
                    <Label htmlFor="rfm-last">New last name</Label>
                    <Input
                      id="rfm-last"
                      value={lastName}
                      placeholder={current.lastName || '—'}
                      onChange={(e) => setLastName(e.target.value)}
                      data-testid="input-rfm-last-name"
                    />
                    {current.lastName && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        On record: {current.lastName}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {(fields.dateOfBirth || (isDependant && fields.relationship)) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.dateOfBirth && (
                  <div>
                    <Label htmlFor="rfm-dob">New date of birth</Label>
                    <Input
                      id="rfm-dob"
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      max={TODAY}
                      data-testid="input-rfm-dob"
                    />
                    {isFutureDate(dateOfBirth) && (
                      <p className="mt-1 text-sm text-destructive" data-testid="error-rfm-dob">
                        Date of birth cannot be in the future.
                      </p>
                    )}
                    {current.dateOfBirth && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        On record: {current.dateOfBirth}
                      </p>
                    )}
                  </div>
                )}
                {isDependant && fields.relationship && (
                  <div>
                    <Label htmlFor="rfm-relationship">New relationship</Label>
                    <Select value={relationship} onValueChange={setRelationship}>
                      <SelectTrigger
                        id="rfm-relationship"
                        data-testid="select-rfm-relationship"
                      >
                        <SelectValue placeholder={title(current.relationship || 'Select')} />
                      </SelectTrigger>
                      <SelectContent>
                        {RELATIONSHIPS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {title(r)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {current.relationship && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        On record: {title(current.relationship)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <Label htmlFor="rfm-doc-type">Supporting document</Label>
              <Select
                value={documentType}
                onValueChange={(v) => setDocumentType(v as ChangeRequestDocumentType)}
              >
                <SelectTrigger id="rfm-doc-type" data-testid="select-rfm-document-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => chooseFile(e.target.files?.[0])}
              data-testid="input-rfm-file"
            />
            {file ? (
              <div
                className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2"
                data-testid="rfm-selected-file"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(file.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  data-testid="button-rfm-clear-file"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove attachment</span>
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-rfm-choose-file"
              >
                <Upload className="mr-2 h-4 w-4" />
                Attach proof (PDF, JPEG or PNG, max 5 MB)
              </Button>
            )}

            <div>
              <Label htmlFor="rfm-note">Anything HR should know? (optional)</Label>
              <Textarea
                id="rfm-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="textarea-rfm-note"
              />
            </div>

            {(existing ?? []).length > 0 && (
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 text-xs font-semibold">Your previous requests</div>
                <div className="space-y-1">
                  {(existing ?? []).slice(0, 5).map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 text-xs"
                      data-testid={`rfm-history-${r.id}`}
                    >
                      <span className="truncate text-muted-foreground">{r.subjectName}</span>
                      <Badge
                        variant={
                          r.status === 'APPROVED'
                            ? 'default'
                            : r.status === 'PENDING'
                              ? 'secondary'
                              : 'destructive'
                        }
                      >
                        {r.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={!canSubmit}
              data-testid="button-rfm-submit"
            >
              {createMutation.isPending ? 'Submitting…' : 'Submit request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
