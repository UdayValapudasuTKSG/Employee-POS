/** Upload rules shared by the import screens. */
export const SPREADSHEET_RE = /\.(xlsx|xlsm|xlsb|xls)$/i;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

/**
 * Every data-bearing sheet of an Excel workbook, in workbook order, as text.
 *
 * Every sheet, not just the first: the carrier ships Members and Dependants in
 * one workbook, and reading only SheetNames[0] silently discarded the
 * dependants. The server identifies each sheet from its own header row. Throws
 * with a message fit for the screen when nothing can be read.
 */
export async function readWorkbookSheets(file: File): Promise<WorkbookSheet[]> {
  // SheetJS is ~800 KB, so it is only pulled in when someone actually picks a
  // spreadsheet — a CSV upload never pays for it.
  const XLSX = await import('xlsx');
  const book = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  if (book.SheetNames.length === 0) throw new Error('The workbook has no sheets.');

  const parsed: WorkbookSheet[] = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    // raw:false + dateNF renders date cells as YYYY-MM-DD, which is what the
    // API expects; every other cell arrives as its displayed text.
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
      dateNF: 'yyyy-mm-dd',
    });
    const rows = matrix
      .map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
      .filter((row) => row.some((cell) => cell.trim() !== ''));
    // An empty trailing "Sheet3" is normal; skip it rather than fail.
    if (rows.length >= 2) parsed.push({ name, rows });
  }
  if (parsed.length === 0) throw new Error('No sheet has a header row and at least one data row.');
  return parsed;
}

/** Quote a cell only when it would otherwise break the CSV. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Downloads a header-only CSV template. */
export function downloadCsvTemplate(columns: string[], fileName: string): void {
  const csv = `${columns.map(csvCell).join(',')}\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
