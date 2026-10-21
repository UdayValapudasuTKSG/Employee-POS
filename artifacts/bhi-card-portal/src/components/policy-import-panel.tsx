import { useRef, useState } from 'react';
import { useGetPolicyImportLayout, useImportPolicies } from '@workspace/api-client-react';
import type { PolicyImportInput, PolicyImportResult } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { MAX_FILE_BYTES, SPREADSHEET_RE, downloadCsvTemplate, readWorkbookSheets, type WorkbookSheet } from '@/lib/read-workbook';
import { AlertCircle, AlertTriangle, CheckCircle2, Download, ShieldCheck, Upload, X } from 'lucide-react';

const REPLACE_TITLE = 'Members who already have a policy';

/**
 * The Policies tab of Import data: bulk upload of member policies. Same
 * flow as the members import — load a file, preview, confirm any replacements,
 * commit — but its own upload, because policies are super admin data. The
 * Import page shows it only with POLICY_MANAGE, which the server enforces too.
 * Rows that cannot be loaded are skipped and listed; there is no fix list.
 */
export function PolicyImportPanel() {
  const { toast } = useToast();
  const [csvText, setCsvText] = useState('');
  const [sheets, setSheets] = useState<WorkbookSheet[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<PolicyImportResult | null>(null);
  const [confirmUpdates, setConfirmUpdates] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importMutation = useImportPolicies();
  const { data: layout } = useGetPolicyImportLayout();

  const hasData = sheets !== null || csvText.trim() !== '';

  const clearFile = () => {
    setSheets(null);
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const resetAll = () => {
    clearFile();
    setCsvText('');
    setResult(null);
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
    try {
      if (SPREADSHEET_RE.test(file.name)) {
        setSheets(await readWorkbookSheets(file));
        setCsvText('');
      } else {
        const text = await file.text();
        if (text.trim() === '') throw new Error('The file is empty.');
        setCsvText(text);
        setSheets(null);
      }
      setFileName(file.name);
      toast({ title: 'File loaded', description: `${file.name} ready to preview.` });
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
    if (!hasData) return;
    const data: PolicyImportInput = sheets ? { sheets, dryRun } : { csvText, dryRun };
    if (!dryRun && confirmUpdates) data.confirmUpdates = true;
    if (fileName) data.fileName = fileName;

    importMutation.mutate(
      { data },
      {
        onSuccess: (res) => {
          setResult(res);
          setConfirmUpdates(false);
          const failed = res.companies.filter((c) => !c.saved);
          if (!dryRun && failed.length > 0) {
            toast({
              title: 'Part of the import was not saved',
              description: `Nothing was saved for ${failed.map((c) => c.companyNumber).join(', ')}. See the results for details.`,
              variant: 'destructive',
            });
          } else if (dryRun && res.existingCount > 0) {
            toast({
              title: REPLACE_TITLE,
              description: `${res.existingCount} member${res.existingCount === 1 ? ' has' : 's have'} a policy this file would replace. Review them and confirm before committing.`,
              variant: 'destructive',
            });
          } else if (dryRun) {
            toast({
              title: 'Preview complete',
              description: `${res.okCount} new, ${res.warnCount} replacements, ${res.errorCount} errors`,
            });
          } else {
            toast({
              title: 'Policies imported',
              description: `${res.committedCount} polic${res.committedCount === 1 ? 'y' : 'ies'} added or replaced.`,
            });
          }
          if (!dryRun) {
            clearFile();
            setCsvText('');
          }
        },
        onError: (error: any) => {
          const body = error?.data?.error;
          toast({
            title: body?.code === 'UPDATES_NOT_CONFIRMED' ? REPLACE_TITLE : dryRun ? 'Preview failed' : 'Import failed',
            description: body?.message || 'Unable to process the data',
            variant: 'destructive',
          });
        },
      },
    );
  };

  // As on Import data: a commit needs a fresh preview, error rows do not block
  // it (they are skipped), and replacing a policy needs the box ticked.
  const loadable = result ? result.okCount + result.warnCount : 0;
  const canCommit =
    result?.dryRun === true && loadable > 0 && (result.existingCount === 0 || confirmUpdates);
  const replacing = result ? result.rows.filter((r) => r.existingRecord && r.status !== 'ERROR') : [];

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className={result ? undefined : 'lg:col-span-2'}>
          <CardHeader>
            <CardTitle className="text-base">Policy file</CardTitle>
          </CardHeader>
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
              data-testid="input-policy-file"
            />

            <div className="min-w-0 space-y-4">
              {fileName ? (
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{fileName}</div>
                    <div className="text-xs text-muted-foreground">
                      {sheets
                        ? `${sheets.length} sheet${sheets.length === 1 ? '' : 's'} read in your browser`
                        : 'Loaded as CSV text'}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={resetAll} disabled={importMutation.isPending}>
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
                >
                  <Upload className="h-6 w-6 text-muted-foreground" />
                  <div className="text-sm text-muted-foreground">Drop a .csv or .xlsx file here</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={reading || importMutation.isPending}
                    data-testid="button-choose-policy-file"
                  >
                    {reading ? 'Reading...' : 'Choose file'}
                  </Button>
                </div>
              )}

              {!sheets && (
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">Or paste the rows directly</div>
                  <Textarea
                    placeholder="Paste CSV data here..."
                    value={csvText}
                    onChange={(e) => {
                      setCsvText(e.target.value);
                      setResult(null);
                      if (fileName) clearFile();
                    }}
                    rows={8}
                    className="font-mono text-sm"
                  />
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => runImport(true)}
                  disabled={importMutation.isPending || reading || !hasData}
                  data-testid="button-policy-preview"
                >
                  {importMutation.isPending ? 'Processing...' : 'Preview changes'}
                </Button>
                <Button
                  onClick={() => runImport(false)}
                  disabled={!canCommit || importMutation.isPending}
                  data-testid="button-policy-commit"
                >
                  {importMutation.isPending ? 'Importing...' : 'Commit import'}
                </Button>
              </div>
            </div>

            <div className="min-w-0 space-y-4">
              {layout && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Template</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => downloadCsvTemplate(layout.columns, 'policies-import-template.csv')}
                    data-testid="button-template-policies"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    {layout.label}
                  </Button>
                </div>
              )}
              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertDescription>
                  {layout && (
                    <>
                      <div className="font-medium">{layout.label} sheet</div>
                      <div className="mt-1 break-words font-mono text-xs">{layout.columns.join(', ')}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{layout.description}</div>
                    </>
                  )}
                  <div className="mt-2 text-xs text-muted-foreground">
                    The members must already exist — import them first on the Members tab. A workbook
                    may also hold the other sheets; only the Policies sheet is read here. Dates can be
                    written 2026-01-01 or 1-Jan-2026. A row that cannot be loaded is skipped: correct it in
                    the file and upload it again. A member can see their card once their policy is on file.
                  </div>
                </AlertDescription>
              </Alert>
            </div>
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{result.dryRun ? 'Preview results' : 'Import results'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium" data-testid="policy-count-new">{result.okCount} new</span>
                </div>
                <div className="flex items-center gap-2">
                  <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
                  <span className="text-sm font-medium" data-testid="policy-count-replace">
                    {result.existingCount} already have a policy
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  <span className="text-sm font-medium" data-testid="policy-count-error">{result.errorCount} errors</span>
                </div>
              </div>

              {replacing.length > 0 && (
                <Alert variant="destructive" data-testid="alert-policy-replace">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="font-semibold">
                      {REPLACE_TITLE}: {replacing.length}
                    </div>
                    <div className="mt-1">
                      {result.dryRun
                        ? 'Committing replaces each of these members’ policy with the values in this file.'
                        : 'These members’ policies were replaced.'}
                    </div>
                    <div className="mt-3 max-h-60 overflow-auto rounded border border-destructive/30 bg-background">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-16">Row</TableHead>
                            <TableHead>Member</TableHead>
                            <TableHead>{result.dryRun ? 'Would change' : 'Changed'}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {replacing.map((row) => (
                            <TableRow key={`${row.sheet}-${row.rowNumber}`}>
                              <TableCell className="mono-id text-xs">{row.rowNumber}</TableCell>
                              <TableCell className="text-xs">
                                {row.memberName ?? '—'}{' '}
                                <span className="mono-id text-muted-foreground">{row.memberIdNumber}</span>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {row.changedFields.length ? row.changedFields.join(', ') : 'No changes — matches the policy on file'}
                              </TableCell>
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
                          data-testid="checkbox-confirm-policy-replace"
                        />
                        <span>
                          Yes, replace these {replacing.length} polic{replacing.length === 1 ? 'y' : 'ies'}. Commit
                          import stays disabled until this is ticked.
                        </span>
                      </label>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {result.dryRun && result.errorCount > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {result.errorCount} row{result.errorCount === 1 ? '' : 's'} cannot be loaded and will be
                    skipped. Committing now loads the {loadable} that can be.
                  </AlertDescription>
                </Alert>
              )}

              {result.companies
                .filter((c) => !c.saved)
                .map((c) => (
                  <Alert key={c.companyNumber} variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{c.message}</AlertDescription>
                  </Alert>
                ))}

              {!result.dryRun && result.committedCount > 0 && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertDescription>
                    {result.companies
                      .filter((c) => c.saved)
                      .map((c) => `${c.companyNumber}: ${c.created} added, ${c.updated} replaced`)
                      .join(' · ')}
                  </AlertDescription>
                </Alert>
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
                    <TableHead>Member</TableHead>
                    <TableHead>Policy no.</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={`${row.sheet}-${row.rowNumber}`} data-testid={`row-policy-${row.rowNumber}`}>
                      <TableCell className="font-medium">{row.rowNumber}</TableCell>
                      <TableCell className="text-sm">
                        <div>{row.memberName || '—'}</div>
                        <div className="mono-id text-xs text-muted-foreground">
                          {row.memberIdNumber || '—'}
                          {row.companyNumber && ` · ${row.companyNumber}`}
                        </div>
                      </TableCell>
                      <TableCell className="mono-id text-sm">{row.policyNumber || '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={row.status === 'OK' ? 'default' : row.status === 'WARN' ? 'secondary' : 'destructive'}
                        >
                          {row.status === 'OK' ? 'NEW' : row.status === 'WARN' ? 'REPLACE' : 'ERROR'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{row.message}</div>
                        {row.reasonCodes.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {row.reasonCodes.map((code) => (
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
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
