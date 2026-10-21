/**
 * Validation for the proof attached to a Request For Modification.
 *
 * Pure: no database, no Express. The route calls decodeDocument and either
 * stores the result or returns the error code verbatim.
 *
 * The controlling rule is that the client's declared MIME type is never
 * trusted. The type is sniffed from the file's magic bytes and the *sniffed*
 * value is what gets stored and later used to build the Blob in the browser.
 * That is what stops "evil.svg renamed to proof.png" being rendered as markup.
 */

import { createHash } from "node:crypto";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/**
 * Base64 inflates by 4/3. Reject on the encoded length first so a hostile body
 * is refused before ~7 MB is decoded into a Buffer.
 */
export const MAX_BASE64_CHARS = Math.ceil((MAX_DOCUMENT_BYTES / 3) * 4) + 1024;

/**
 * SVG is deliberately absent and must stay absent: an SVG is an HTML document
 * that executes script when rendered inline, and these are displayed to an
 * admin whose session token lives in localStorage.
 */
export const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export type DocumentMime = (typeof ALLOWED_DOCUMENT_TYPES)[number];

export type DocumentRejection =
  | "INVALID_BASE64"
  | "FILE_TOO_LARGE"
  | "FILE_EMPTY"
  | "UNSUPPORTED_FILE_TYPE"
  | "TYPE_MISMATCH";

export type DecodedDocument = {
  bytes: Buffer;
  mimeType: DocumentMime;
  sha256: string;
  byteSize: number;
};

export type DecodeResult =
  | { ok: true; document: DecodedDocument }
  | { ok: false; code: DocumentRejection; message: string };

const startsWith = (buf: Buffer, sig: number[]): boolean =>
  buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/**
 * Identifies the container from its leading bytes.
 *
 * This proves the container, not that the payload is a decodable image —
 * validating that properly would need an image-decoding dependency. It is
 * sufficient here because PDFs are never rendered inline and <img> cannot
 * execute script whatever the bytes turn out to be.
 */
export function sniffDocumentType(buf: Buffer): DocumentMime | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

/**
 * Strips anything that could traverse a path, break a Content-Disposition
 * header, or hide the real extension. The result is display text and a
 * `download` attribute value — never used to derive a type.
 */
export function sanitiseFileName(raw: string): string {
  const base = String(raw ?? "")
    .replace(/[\\/]/g, "_")
    // Control characters, DEL and quotes: any of these could forge a
    // Content-Disposition header or hide the real extension.
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .replace(/\.{2,}/g, ".")
    .trim();
  const cleaned = base === "" || base === "." ? "document" : base;
  return cleaned.slice(0, 120);
}

/** Exact decoded length implied by a base64 string, without decoding it. */
function decodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function decodeDocument(contentBase64: string, declaredMime: string): DecodeResult {
  // Accept a data: URL prefix — FileReader.readAsDataURL is the easiest way to
  // produce base64 in a browser and its output starts with one.
  const raw = String(contentBase64 ?? "").replace(/^data:[^;]*;base64,/, "");
  const b64 = raw.replace(/\s+/g, "");

  if (b64 === "") {
    return { ok: false, code: "FILE_EMPTY", message: "The file is empty." };
  }
  if (b64.length > MAX_BASE64_CHARS) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: "The document must be 5 MB or smaller.",
    };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    return { ok: false, code: "INVALID_BASE64", message: "The upload was corrupted in transit." };
  }

  const expected = decodedLength(b64);
  const bytes = Buffer.from(b64, "base64");
  // Buffer.from is lenient and silently drops characters it does not recognise,
  // so a garbage payload would otherwise decode to a "valid" few bytes. The
  // regex above catches most of it; this catches the rest.
  if (bytes.byteLength !== expected) {
    return { ok: false, code: "INVALID_BASE64", message: "The upload was corrupted in transit." };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, code: "FILE_EMPTY", message: "The file is empty." };
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: "The document must be 5 MB or smaller.",
    };
  }

  const sniffed = sniffDocumentType(bytes);
  if (!sniffed) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: "Attach a PDF, JPEG or PNG. Other file types are not accepted.",
    };
  }
  if (sniffed !== declaredMime) {
    return {
      ok: false,
      code: "TYPE_MISMATCH",
      message: `The file is a ${sniffed} but was sent as ${declaredMime}. Re-attach the original file.`,
    };
  }

  return {
    ok: true,
    document: {
      bytes,
      mimeType: sniffed,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    },
  };
}
