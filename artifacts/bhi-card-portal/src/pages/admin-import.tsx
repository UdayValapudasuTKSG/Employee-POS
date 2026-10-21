import { useRef, useState } from 'react';
import { Link } from 'wouter';
import { useImportMembers, useGetImportLayouts } from '@workspace/api-client-react';
import type {
  ImportInput,
  ImportLayoutDescriptor,
  ImportResult,
} from '@workspace/api-client-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/auth-context';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PolicyImportPanel } from '@/components/policy-import-panel';
import { MAX_FILE_BYTES, SPREADSHEET_RE, downloadCsvTemplate, readWorkbookSheets } from '@/lib/read-workbook';
import {
  FileUp,
  HandCoins,
  ShieldCheck,
  Users,
  UsersRound,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Copy,
  Upload,
  X,
  Download,
  PhoneOff,
  ClipboardList,
  Wrench,
} from 'lucide-react';

// The accepted sheets and their columns come from GET /v1/admin/import/layouts
// rather than being restated here. They used to be two arrays in this file, so
// every parser change had to be mirrored by hand and the screen could advertise
// columns the server no longer read. Templates are generated from the same
// list, which means a downloaded template always matches what will be accepted.

// The headline for rows rejected as duplicate members, in one place so the toast
// and the on-screen alert cannot drift apart.
const DUPLICATES_TITLE = 'Found duplicates';

// Rows whose phone number cannot receive a verification code. These get a modal
// rather than a toast: a toast disappears, and the whole point is that the
// administrator has to go back to the spreadsheet with a list of row numbers.
const BAD_PHONE_TITLE = 'Phone numbers outside Guyana';


// The server refuses the old short members layout by name (LAYOUT_WITHDRAWN).
// Its message names the sheet and the carrier columns to use instead.
const WITHDRAWN_TITLE = 'Old members layout no longer accepted';

/** The fix list, where held rows wait for HR to correct and upload again. */
const EXCEPTIONS_HREF = '/admin/import-exceptions';

/** One tab per sheet type. Policies is the super admin's own upload. */
type SheetType = 'CARRIER' | 'DEPENDANT' | 'BENEFICIARY';
type ImportType = SheetType | 'policies';

const TABS: { value: ImportType; label: string; what: string; help: string }[] = [
  {
    value: 'CARRIER',
    label: 'Members',
    what: 'members',
    help:
      'A member is matched on IDType + IDNumber, so importing the same person again updates them. ' +
      'Import members before their dependants, beneficiaries and policies.',
  },
  {
    value: 'DEPENDANT',
    label: 'Dependants',
    what: 'dependants',
    help:
      'Each row names its member by MemberIDNumber, and the member must already be imported. ' +
      'A dependant whose member is held on the fix list is held too.',
  },
  {
    value: 'BENEFICIARY',
    label: 'Beneficiaries',
    what: 'beneficiaries',
    help:
      'Each row names its member by MemberIDNumber, and the member must already be imported. ' +
      'A member’s shares should add up to 100.',
  },
  { value: 'policies', label: 'Policies', what: 'member policies', help: '' },
];

const TAB_ICONS: Record<ImportType, typeof FileUp> = {
  CARRIER: Users,
  DEPENDANT: UsersRound,
  BENEFICIARY: HandCoins,
  policies: ShieldCheck,
};

/** Rows a commit would actually load: the new ones plus the updates. */
function importableOf(result: ImportResult): number {
  return result.okCount + result.warnCount;
}

/**
 * Error rows that are not duplicates — malformed dates, missing columns, an
 * unknown company. Separated because the two want opposite responses: a
 * malformed row is fixed in the file and re-imported, a duplicate means the
 * person is already in the portal and the row should simply be dropped.
 */
function unreadableOf(result: ImportResult): number {
  return Math.max(0, result.errorCount - result.duplicateCount);
}

/** The rows the phone dialog lists, in sheet order. */
function badPhoneRows(result: ImportResult) {
  return result.rows.filter((row) => row.invalidPhone);
}

// Rows matching records already in the system. Committing them updates those
// records, so the preview lists them and the commit waits for a confirmation.
const EXISTING_TITLE = 'Already exists in the system';

function existingRows(result: ImportResult) {
  return result.rows.filter((row) => row.existingRecord && row.status !== 'ERROR');
}

const RECORD_TYPE_LABELS: Record<string, string> = {
  MEMBER: 'Member',
  DEPENDENT: 'Dependant',
  BENEFICIARY: 'Beneficiary',
};

/** The member columns an update can change, as the sheet names them. */
const FIELD_LABELS: Record<string, string> = {
  firstName: 'FirstName',
  lastName: 'LastName',
  middleInitials: 'MiddleInitials',
  dateOfBirth: 'DateOfBirth',
  sex: 'Sex',
  classCode: 'ClassCode',
  addressLine1: 'AddressLine1',
  addressLine2: 'AddressLine2',
  phone: 'Phone',
  email: 'Email',
  employmentDate: 'EmploymentDate',
  planDate: 'PlanDate',
  rateOfPay: 'RateOfPay',
  occupation: 'Occupation',
  notes: 'Notes',
  active: 'Active',
};

function changeText(row: ImportResult['rows'][number]): string {
  if (row.recordType !== 'MEMBER') return 'Updates the record on file';
  if (row.changedFields.length === 0) return 'No changes — matches the record';
  return row.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ');
}

export default function AdminImport() {
  const { toast } = useToast();
  const [csvText, setCsvText] = useState('');
  // Every data-bearing sheet of an uploaded workbook, in workbook order.
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // The uploaded file's own name, sent with the import so the batch records it.
  // fileName above is the on-screen label, which also lists the sheets.
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  // The server's LAYOUT_WITHDRAWN message, shown until the data is replaced.
  const [withdrawnMessage, setWithdrawnMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  // "Yes, update the existing records" — asked again after every preview.
  const [confirmUpdates, setConfirmUpdates] = useState(false);
  // Opened by a preview or a commit that found undeliverable numbers. Dismissing
  // it leaves the same list in the results table, so nothing is lost.
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importMutation = useImportMembers();
  const { data: layoutData } = useGetImportLayouts();
  const { hasPermission } = useAuth();
  const canImportPolicies = hasPermission('POLICY_MANAGE');
  const tabs = TABS.filter((t) => t.value !== 'policies' || canImportPolicies);
  // ?type=dependants (or beneficiaries, policies) opens straight onto that tab.
  const [importType, setImportType] = useState<ImportType>(() => {
    const asked = new URLSearchParams(window.location.search).get('type');
    return tabs.find((t) => t.label.toLowerCase() === asked)?.value ?? 'CARRIER';
  });
  const tab = TABS.find((t) => t.value === importType) ?? TABS[0]!;
  const allLayouts = layoutData?.layouts ?? [];
  // Templates and column help for this tab only.
  const layouts = allLayouts.filter((l) => l.layout === importType);

  /** What to call a layout in the results. Falls back to the raw code. */
  const layoutLabel = (layout: string): string =>
    allLayouts.find((l) => l.layout === layout)?.label ?? layout;

  const hasData = sheets !== null || csvText.trim() !== '';

  const clearFile = () => {
    setSheets(null);
    setFileName(null);
    setSourceFileName(null);
    setWithdrawnMessage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const resetAll = () => {
    clearFile();
    setCsvText('');
    setResult(null);
  };

  /** A preview belongs to the tab it was made on, so switching clears it. */
  const switchTab = (next: ImportType) => {
    if (next === importType) return;
    resetAll();
    setConfirmUpdates(false);
    setImportType(next);
  };

  const handleFile = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      toast({
        title: 'File too large',
        description: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 15 MB.`,
        variant: 'destructive',
      });
      return;
    }

    setReading(true);
    setResult(null);
    setWithdrawnMessage(null);
    try {
      if (SPREADSHEET_RE.test(file.name)) {
        const parsed = await readWorkbookSheets(file);
        setSheets(parsed);
        setCsvText('');
        setSourceFileName(file.name);
        const dataRows = parsed.reduce((n, s) => n + s.rows.length - 1, 0);
        setFileName(
          `${file.name} (${parsed.length === 1 ? `sheet "${parsed[0]!.name}"` : `${parsed.length} sheets: ${parsed.map((s) => s.name).join(', ')}`})`,
        );
        toast({
          title: 'Spreadsheet loaded',
          description: `${dataRows} data row${dataRows === 1 ? '' : 's'} across ${parsed.length} sheet${parsed.length === 1 ? '' : 's'} ready to preview.`,
        });
      } else {
        // CSV and TSV go over as text so the server does the parsing — one
        // parser, one set of rules, whether the text was pasted or uploaded.
        const text = await file.text();
        if (text.trim() === '') throw new Error('The file is empty.');
        setCsvText(text);
        setSheets(null);
        setFileName(file.name);
        setSourceFileName(file.name);
        toast({ title: 'File loaded', description: `${file.name} ready to preview.` });
      }
    } catch (error: any) {
      clearFile();
      toast({
        title: 'Could not read the file',
        description: error?.message || 'The file could not be parsed.',
        variant: 'destructive',
      });
    } finally {
      setReading(false);
    }
  };

  const runImport = (dryRun: boolean) => {
    if (!hasData) {
      toast({
        title: 'Nothing to import',
        description: 'Upload a file or paste CSV data first.',
        variant: 'destructive',
      });
      return;
    }

    const data: ImportInput = sheets ? { sheets, dryRun } : { csvText, dryRun };
    // Only this tab's sheet is read, even from a workbook holding all of them.
    if (importType !== 'policies') data.layout = importType;
    if (!dryRun && confirmUpdates) data.confirmUpdates = true;
    // Pasted text has no file name; an upload's is kept on the import batch.
    if (sourceFileName) data.fileName = sourceFileName;
    setWithdrawnMessage(null);

    importMutation.mutate(
      { data },
      {
        onSuccess: (res) => {
          setResult(res);
          setConfirmUpdates(false);

          // A company whose commit failed saved nothing at all. That outranks
          // every per-row message, because the rows reported as fine were not
          // written for that company either.
          const failed = res.batches.filter((b) => !b.saved);
          if (!dryRun && failed.length > 0) {
            toast({
              title: 'Part of the import was not saved',
              description: `Nothing was saved for ${failed.map((b) => b.companyNumber).join(', ')}. See the results for details.`,
              variant: 'destructive',
            });
            clearFile();
            setCsvText('');
            return;
          }

          // Undeliverable numbers take precedence over every other message.
          // They are the one failure the administrator can fix row by row, and a
          // modal is the only thing that survives long enough to be read and
          // acted on — a toast is gone before you have found the spreadsheet.
          if (res.invalidPhoneCount > 0) {
            setPhoneDialogOpen(true);
            const n = res.invalidPhoneCount;
            toast({
              title: BAD_PHONE_TITLE,
              description: `${n} row${n === 1 ? '' : 's'} carry a number that cannot receive a verification code.`,
              variant: 'destructive',
            });
            if (!dryRun) {
              clearFile();
              setCsvText('');
            }
            return;
          }

          // A duplicate is the one outcome worth interrupting for, on a preview
          // and on a commit alike: it means the file names people the database
          // already holds, which is usually a file that has been loaded before.
          // The alert in the results card carries the same headline and stays up.
          if (res.duplicateCount > 0) {
            const n = res.duplicateCount;
            toast({
              title: DUPLICATES_TITLE,
              description: dryRun
                ? `${n} row${n === 1 ? '' : 's'} already exist and will be skipped. ${importableOf(res)} others can be imported.`
                : `${n} row${n === 1 ? '' : 's'} already existed and were skipped. ${res.committedCount} imported.`,
              variant: 'destructive',
            });
          } else if (dryRun && res.existingCount > 0) {
            const n = res.existingCount;
            toast({
              title: EXISTING_TITLE,
              description: `${n} row${n === 1 ? '' : 's'} match records already in the system and would update them. Review the list and confirm before committing.`,
              variant: 'destructive',
            });
          } else if (dryRun) {
            toast({
              title: 'Preview complete',
              description: `${res.okCount} new, ${res.warnCount} updates, ${res.errorCount} errors`,
            });
          } else {
            toast({
              title: 'Import complete',
              description:
                // "rows", not "members": a workbook commits members, dependants
                // and beneficiaries, and this is the total across all of them.
                `${res.committedCount} row${res.committedCount === 1 ? '' : 's'} imported` +
                (res.resolvedExceptions.length > 0
                  ? `, ${res.resolvedExceptions.length} held record${res.resolvedExceptions.length === 1 ? '' : 's'} fixed`
                  : '') +
                (res.heldCount > 0 ? `, ${res.heldCount} held for the fix list` : ''),
            });
          }
          if (!dryRun) {
            clearFile();
            setCsvText('');
          }
        },
        onError: (error: any) => {
          const body = error?.data?.error;
          if (body?.code === 'LAYOUT_WITHDRAWN') {
            // Not a transient failure: the file itself has to change, so the
            // explanation stays on screen instead of in a toast.
            setResult(null);
            setWithdrawnMessage(
              body.message ||
                'This file uses the old short members layout, which is no longer accepted. Use the carrier Members layout.',
            );
            toast({
              title: WITHDRAWN_TITLE,
              description: 'See the message under the file.',
              variant: 'destructive',
            });
            return;
          }
          if (body?.code === 'UPDATES_NOT_CONFIRMED') {
            toast({ title: EXISTING_TITLE, description: body.message, variant: 'destructive' });
            return;
          }
          toast({
            title: dryRun ? 'Preview failed' : 'Import failed',
            description: error?.data?.error?.message || 'Unable to process the data',
            variant: 'destructive',
          });
        },
      }
    );
  };

  /** A header-only CSV for one layout, generated from what the server accepts. */
  const downloadTemplate = (layout: ImportLayoutDescriptor) =>
    downloadCsvTemplate(layout.columns, `${layout.label.toLowerCase().replace(/\s+/g, '-')}-import-template.csv`);

  // A commit needs a fresh preview — never a stale one from before the data was
  // edited. Error rows do NOT block it: a real carrier file of several hundred
  // rows nearly always has a handful the carrier must fix, and blocking on those
  // would mean nothing could ever be imported. The server skips error rows, so
  // committing loads the good ones and leaves the rest to be re-imported once
  // the file is corrected.
  const previewMatchesInput = result?.dryRun === true;
  const importable = result ? importableOf(result) : 0;
  const existingInPreview = previewMatchesInput && result ? result.existingCount : 0;
  const canCommit = previewMatchesInput && importable > 0 && (existingInPreview === 0 || confirmUpdates);

  return (
    <div>
      <PageHeader
        title="Import data"
        description={`Upload a CSV or Excel file of ${tab.what} (or paste CSV), preview the changes, then commit`}
        action={
          <Link href={EXCEPTIONS_HREF}>
            <Button variant="outline" size="sm" data-testid="link-import-exceptions">
              <ClipboardList className="mr-2 h-4 w-4" />
              View import exceptions
            </Button>
          </Link>
        }
      />

      {/* One tab per sheet type. Policies is super admin data, so only that role
          sees its tab. */}
      <Tabs value={importType} onValueChange={(v) => switchTab(v as ImportType)} className="mb-5">
        <TabsList className="h-auto flex-wrap">
          {tabs.map((t) => {
            const Icon = TAB_ICONS[t.value];
            return (
              <TabsTrigger key={t.value} value={t.value} data-testid={`tab-import-${t.label.toLowerCase()}`}>
                <Icon className="mr-2 h-4 w-4" />
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {importType === 'policies' ? (
        <PolicyImportPanel />
      ) : (
      <>
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Full width until there is a preview to sit beside it; an empty
            right-hand column read as a broken layout. */}
        <Card className={result ? undefined : 'lg:col-span-2'}>
          <CardHeader>
            <CardTitle className="text-base">{tab.label} file</CardTitle>
          </CardHeader>
          {/* At full width the file and the column help sit side by side;
              beside a preview they stack. */}
          <CardContent
            className={result ? 'space-y-4' : 'grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]'}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xlsb,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
              data-testid="input-import-file"
            />

            <div className="min-w-0 space-y-4">
              {fileName ? (
                <div
                  className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3"
                  data-testid="selected-file"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{fileName}</div>
                    <div className="text-xs text-muted-foreground">
                      {sheets
                        ? `${sheets.reduce((n, s) => n + s.rows.length - 1, 0)} data rows read in your browser`
                        : 'Loaded as CSV text'}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetAll}
                    disabled={importMutation.isPending}
                    data-testid="button-clear-file"
                  >
                    <X className="h-4 w-4" />
                    <span className="sr-only">Remove file</span>
                  </Button>
                </div>
              ) : (
                <div
                  className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0];
                    if (file) void handleFile(file);
                  }}
                  data-testid="dropzone-import"
                >
                  <Upload className="h-6 w-6 text-muted-foreground" />
                  <div className="text-sm text-muted-foreground">
                    Drop a .csv or .xlsx file here
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={reading || importMutation.isPending}
                    data-testid="button-choose-file"
                  >
                    {reading ? 'Reading...' : 'Choose file'}
                  </Button>
                </div>
              )}

              {!sheets && (
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    Or paste the rows directly
                  </div>
                  <Textarea
                    placeholder="Paste CSV data here..."
                    value={csvText}
                    onChange={(e) => {
                      setCsvText(e.target.value);
                      setResult(null);
                      setWithdrawnMessage(null);
                      if (fileName) clearFile();
                    }}
                    rows={10}
                    className="font-mono text-sm"
                    data-testid="textarea-csv"
                  />
                </div>
              )}

              {withdrawnMessage && (
                <Alert variant="destructive" data-testid="alert-layout-withdrawn">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="font-medium">{WITHDRAWN_TITLE}</div>
                    {/* The server's message names the sheet and lists the carrier
                        Members columns, so it is shown as sent. */}
                    <div className="mt-1 break-words">{withdrawnMessage}</div>
                    <div className="mt-1 text-xs">
                      Rebuild that sheet from the Members template below, then preview again.
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => runImport(true)}
                  disabled={importMutation.isPending || reading || !hasData}
                  data-testid="button-dry-run"
                >
                  {importMutation.isPending ? 'Processing...' : 'Preview changes'}
                </Button>
                <Button
                  variant="default"
                  onClick={() => runImport(false)}
                  disabled={!canCommit || importMutation.isPending}
                  data-testid="button-commit"
                >
                  {importMutation.isPending ? 'Importing...' : 'Commit import'}
                </Button>
              </div>
            </div>

            <div className="min-w-0 space-y-4">
              {/* One template button per accepted layout, generated from the
                  server's own column lists. */}
              {layouts.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Template</span>
                  {layouts.map((l) => (
                    <Button
                      key={l.layout}
                      variant="ghost"
                      size="sm"
                      onClick={() => downloadTemplate(l)}
                      disabled={importMutation.isPending}
                      data-testid={`button-template-${l.layout.toLowerCase()}`}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {l.label}
                    </Button>
                  ))}
                </div>
              )}

              <Alert>
                <FileUp className="h-4 w-4" />
                <AlertDescription>
                  {layouts.map((l) => (
                    <div key={l.layout} className="mb-3 last:mb-0">
                      <div className="font-medium">{l.label} sheet</div>
                      <div className="mt-1 break-words font-mono text-xs">
                        {l.columns.join(', ')}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{l.description}</div>
                    </div>
                  ))}
                  <div className="mt-2 text-xs text-muted-foreground">
                    {tab.help} Only the {tab.label} sheet of a workbook is read on this tab, recognised
                    from its header row, so column order and capitalisation do not matter. Dates can be
                    written 1983-05-07, 7-May-1983 or 07-05-1983 (day first); avoid slashes, which
                    are read month first. Active is Active or Inactive (Yes/No also work). Import
                    never creates a company — onboard it under Companies first. Always use Preview
                    changes before Commit import. A row that cannot be loaded is held on the
                    company's Import exceptions list: correct it in the spreadsheet and import it
                    again, which clears it (and restores anyone held with it), or mark it resolved
                    there with a note.
                  </div>
                </AlertDescription>
              </Alert>
            </div>
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {result.dryRun ? 'Preview results' : 'Import results'}
                <Badge variant="secondary">{layoutLabel(result.layout)}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium" data-testid="count-ok">
                    {result.okCount} new
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
                  <span className="text-sm font-medium" data-testid="count-warn">
                    {result.existingCount} already exist
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  <span className="text-sm font-medium" data-testid="count-error">
                    {result.errorCount} errors
                  </span>
                </div>
                {result.duplicateCount > 0 && (
                  <div className="flex items-center gap-2">
                    <Copy className="h-4 w-4 text-destructive" />
                    <span className="text-sm font-medium" data-testid="count-duplicate">
                      {result.duplicateCount} duplicates
                    </span>
                  </div>
                )}
                {result.heldCount > 0 && (
                  <div className="flex items-center gap-2">
                    <ClipboardList aria-hidden="true" className="h-4 w-4 text-warning" />
                    <span className="text-sm font-medium" data-testid="count-held">
                      {result.heldCount} held
                    </span>
                  </div>
                )}
              </div>

              {/* Rows for people already in the system: listed, and on a preview the
                  commit waits for an explicit yes. */}
              {result.existingCount > 0 && (
                <Alert variant="destructive" data-testid="alert-existing">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="font-semibold">
                      {EXISTING_TITLE}: {result.existingCount} record
                      {result.existingCount === 1 ? '' : 's'}
                    </div>
                    <div className="mt-1">
                      {result.dryRun
                        ? `These rows match members, dependants or beneficiaries already on file. Committing will not add them again — it will update the existing records with the values in this file.`
                        : `These rows matched records already on file and updated them.`}
                    </div>
                    <div className="mt-3 max-h-72 overflow-auto rounded border border-destructive/30 bg-background">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-16">Row</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Company</TableHead>
                            <TableHead>ID number</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>{result.dryRun ? 'Would change' : 'Changed'}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {existingRows(result).map((row, i) => (
                            <TableRow key={`${row.rowNumber}-${i}`} data-testid={`row-existing-${row.rowNumber}`}>
                              <TableCell className="mono-id text-xs">{row.rowNumber}</TableCell>
                              <TableCell className="text-xs">{RECORD_TYPE_LABELS[row.recordType] ?? row.recordType}</TableCell>
                              <TableCell className="mono-id text-xs">{row.companyNumber ?? '—'}</TableCell>
                              <TableCell className="mono-id text-xs">{row.idNumber ?? '—'}</TableCell>
                              <TableCell className="text-xs">{row.name ?? '—'}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{changeText(row)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {result.dryRun && (
                      <label className="mt-3 flex cursor-pointer items-start gap-2 font-medium text-foreground">
                        <Checkbox
                          checked={confirmUpdates}
                          onCheckedChange={(v) => setConfirmUpdates(v === true)}
                          className="mt-0.5"
                          data-testid="checkbox-confirm-updates"
                        />
                        <span>
                          Yes, update these {result.existingCount} existing record
                          {result.existingCount === 1 ? '' : 's'}. Commit import stays disabled until
                          this is ticked.
                        </span>
                      </label>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {/* A company whose commit rolled back saved nothing, including the
                  rows the table below reports as fine. */}
              {result.batches
                .filter((b) => !b.saved)
                .map((b) => (
                  <Alert
                    key={`failed-${b.companyNumber}`}
                    variant="destructive"
                    data-testid={`alert-batch-failed-${b.companyNumber}`}
                  >
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      <div className="font-medium">
                        Nothing was saved for company{' '}
                        <span className="mono-id">{b.companyNumber}</span>
                      </div>
                      <div className="mt-1">
                        {b.message ||
                          'A write failed, so every change for this company was rolled back.'}{' '}
                        Import the file again once the problem is fixed.
                      </div>
                    </AlertDescription>
                  </Alert>
                ))}

              {result.dryRun && (result.resolvedExceptions.length > 0 || result.heldCount > 0) && (
                <Alert data-testid="alert-exceptions-preview">
                  <ClipboardList className="h-4 w-4" />
                  <AlertDescription>
                    {result.resolvedExceptions.length > 0 && (
                      <div data-testid="text-resolves-count">
                        This file resolves {result.resolvedExceptions.length} held record
                        {result.resolvedExceptions.length === 1 ? '' : 's'} on the fix list.
                      </div>
                    )}
                    {result.heldCount > 0 && (
                      <div data-testid="text-held-count">
                        {result.heldCount} row{result.heldCount === 1 ? '' : 's'} will be held for
                        the fix list, for HR to correct and upload again.
                      </div>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {result.duplicateCount > 0 && (
                <Alert variant="destructive" data-testid="alert-duplicates">
                  <Copy className="h-4 w-4" />
                  <AlertDescription>
                    <div className="font-medium">{DUPLICATES_TITLE}</div>
                    <div className="mt-1">
                      {result.duplicateCount} row{result.duplicateCount === 1 ? '' : 's'} repeat an
                      earlier row of this same file, or carry an ID number already registered to
                      a member of another company, and {result.dryRun ? 'will be' : 'were'}{' '}
                      skipped. Row details below say which record each one collided with.
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {result.dryRun && unreadableOf(result) > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {unreadableOf(result)} row{unreadableOf(result) === 1 ? '' : 's'} below
                    cannot be loaded and will be skipped. Committing now loads the{' '}
                    {importable} that can be — fix the rest in the file and import it again to
                    pick them up.
                  </AlertDescription>
                </Alert>
              )}

              {result.sheets.length > 1 && (
                <div className="rounded border border-border">
                  <div className="border-b border-border px-3 py-2 text-xs font-semibold">
                    Per sheet
                  </div>
                  {result.sheets.map((s) => (
                    <div
                      key={s.name}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      data-testid={`sheet-result-${s.name}`}
                    >
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="secondary">{layoutLabel(s.layout)}</Badge>
                      <span className="text-muted-foreground">
                        {s.okCount} new · {s.warnCount} updates · {s.errorCount} errors
                        {s.duplicateCount > 0 && ` · ${s.duplicateCount} duplicates`}
                        {s.heldCount > 0 && ` · ${s.heldCount} held`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {!result.dryRun && result.committedCount > 0 && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertDescription>
                    {result.committedCount} row{result.committedCount === 1 ? '' : 's'}{' '}
                    imported successfully
                    {result.sheets.length > 1 && (
                      <>
                        {' '}
                        across{' '}
                        {result.sheets
                          .filter((s) => s.committedCount > 0)
                          .map((s) => `${s.committedCount} ${layoutLabel(s.layout).toLowerCase()}`)
                          .join(', ')}
                      </>
                    )}
                    .
                  </AlertDescription>
                </Alert>
              )}

              {!result.dryRun && result.heldCount > 0 && (
                <Alert data-testid="alert-held-after-commit">
                  <ClipboardList className="h-4 w-4" />
                  <AlertDescription>
                    {result.heldCount} row{result.heldCount === 1 ? ' was' : 's were'} held for
                    the fix list.{' '}
                    <Link href={EXCEPTIONS_HREF} className="font-medium underline">
                      View import exceptions
                    </Link>
                  </AlertDescription>
                </Alert>
              )}

              {!result.dryRun && result.resolvedExceptions.length > 0 && (
                <div className="rounded border border-border" data-testid="resolved-exceptions">
                  <div className="border-b border-border px-3 py-2 text-xs font-semibold">
                    Held records fixed ({result.resolvedExceptions.length})
                  </div>
                  {result.resolvedExceptions.map((x) => {
                    const who = x.personName || `Held record #${x.exceptionId}`;
                    return (
                      <div
                        key={x.exceptionId}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                        data-testid={`resolved-exception-${x.exceptionId}`}
                      >
                        <span className="font-medium">
                          {x.memberId > 0 ? (
                            <Link
                              href={`/admin/companies/${encodeURIComponent(x.companyNumber)}/members/${x.memberId}`}
                              className="hover:underline"
                            >
                              {who}
                            </Link>
                          ) : (
                            who
                          )}
                          <span className="mono-id ml-2 text-muted-foreground">
                            #{x.exceptionId} · {x.companyNumber}
                          </span>
                        </span>
                        <span className="text-muted-foreground">
                          {x.restoredDependents} dependant{x.restoredDependents === 1 ? '' : 's'} ·{' '}
                          {x.restoredBeneficiaries} beneficiar
                          {x.restoredBeneficiaries === 1 ? 'y' : 'ies'} restored
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {!result.dryRun && result.batches.length > 0 && (
                <div className="rounded border border-border" data-testid="import-batches">
                  <div className="border-b border-border px-3 py-2 text-xs font-semibold">
                    Import batches
                  </div>
                  {result.batches.map((b) => (
                    <div
                      key={b.companyNumber}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      data-testid={`import-batch-${b.companyNumber}`}
                    >
                      <span className="mono-id font-medium">{b.companyNumber}</span>
                      <span className="mono-id min-w-0 break-all text-muted-foreground">
                        {b.sourceFile ?? '—'}
                      </span>
                      <Badge variant={b.saved ? 'success' : 'destructive'}>
                        {b.saved ? 'Saved' : 'Not saved'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {result && result.rows.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Row details</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    {/* For a dependant or beneficiary row, Name is theirs and
                        the ID number is the member they were linked to. */}
                    <TableHead>Name</TableHead>
                    <TableHead>ID number</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={row.rowNumber} data-testid={`row-import-${row.rowNumber}`}>
                      <TableCell className="font-medium">{row.rowNumber}</TableCell>
                      <TableCell className="text-sm">{row.name || '—'}</TableCell>
                      <TableCell className="mono-id text-sm">
                        <div>{row.idNumber || '—'}</div>
                        {row.companyNumber && (
                          <div className="text-xs text-muted-foreground">{row.companyNumber}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === 'OK'
                              ? 'default'
                              : row.status === 'WARN'
                              ? 'secondary'
                              : 'destructive'
                          }
                        >
                          {/* Duplicates are ERROR rows, but saying so reads as
                              "the file is broken" when the file is fine and the
                              person is simply already here. */}
                          {row.duplicate ? 'DUPLICATE' : row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {/* The message names the missing or too-long field; the
                            codes match the ones on the fix list. */}
                        <div>{row.message}</div>
                        {(row.reasonCodes.length > 0 ||
                          row.held ||
                          row.resolvesExceptionId !== null) && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {row.reasonCodes.map((code) => (
                              <Badge
                                key={code}
                                variant="outline"
                                className="px-1.5 py-0 font-mono text-[10px] font-semibold"
                              >
                                {code}
                              </Badge>
                            ))}
                            {row.held && (
                              <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                                <ClipboardList aria-hidden="true" className="h-3 w-3" />
                                Held for HR fix list
                              </Badge>
                            )}
                            {row.resolvesExceptionId !== null && (
                              <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                                <Wrench aria-hidden="true" className="h-3 w-3" />
                                Fixes held record #{row.resolvesExceptionId}
                              </Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Undeliverable phone numbers. Modal rather than an inline alert because
          the list of row numbers is the thing the administrator needs in front
          of them while they edit the spreadsheet. */}
      <Dialog open={phoneDialogOpen} onOpenChange={setPhoneDialogOpen}>
        <DialogContent className="max-w-2xl border-destructive/40">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <PhoneOff className="h-[18px] w-[18px]" />
              </div>
              <DialogTitle className="text-destructive">{BAD_PHONE_TITLE}</DialogTitle>
            </div>
            <DialogDescription className="text-left">
              {result && (
                <>
                  <strong className="text-foreground">
                    {result.invalidPhoneCount} row
                    {result.invalidPhoneCount === 1 ? '' : 's'}
                  </strong>{' '}
                  {result.invalidPhoneCount === 1 ? 'was' : 'were'} rejected. This plan can only
                  send verification codes to Guyana (+592) numbers, so a member stored with a
                  number from another country could never receive one and would not be able to
                  look up their card.
                  {result.dryRun
                    ? ' Nothing has been imported — correct these numbers and preview again.'
                    : ' Every other row was imported; only these were skipped.'}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Row</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result &&
                  badPhoneRows(result).map((row) => (
                    <TableRow key={`${row.rowNumber}-${row.idNumber ?? ''}`}>
                      <TableCell className="mono-id align-top text-xs">{row.rowNumber}</TableCell>
                      <TableCell className="align-top text-sm">
                        <div className="font-medium text-foreground">{row.name ?? '—'}</div>
                        {row.idNumber && (
                          <div className="mono-id text-xs text-muted-foreground">
                            {row.idNumber}
                          </div>
                        )}
                      </TableCell>
                      {/* The server's message names the offending number and the
                          expected shape, so it is shown verbatim rather than
                          restated less precisely here. */}
                      <TableCell className="align-top text-sm text-muted-foreground">
                        {row.message}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Guyana numbers are seven digits. Write them as{' '}
              <span className="mono-id">+592 6455555</span> or just{' '}
              <span className="mono-id">6455555</span> — the importer adds the country code. Leave
              the cell empty for a member with no phone; they can still be found by email.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (!result) return;
                // Pasted straight back into the spreadsheet or an email to the
                // carrier, which is what actually gets these fixed.
                const text = badPhoneRows(result)
                  .map((r) => `Row ${r.rowNumber}\t${r.name ?? ''}\t${r.message}`)
                  .join('\n');
                navigator.clipboard.writeText(text).then(
                  () => toast({ title: 'Copied', description: 'The list is on your clipboard.' }),
                  () =>
                    toast({
                      title: 'Could not copy',
                      description: 'Your browser blocked clipboard access.',
                      variant: 'destructive',
                    }),
                );
              }}
              data-testid="button-copy-bad-phones"
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy list
            </Button>
            <Button onClick={() => setPhoneDialogOpen(false)} data-testid="button-close-bad-phones">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </>
      )}
    </div>
  );
}
