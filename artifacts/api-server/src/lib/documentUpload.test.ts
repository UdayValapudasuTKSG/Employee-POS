import { describe, expect, it } from "vitest";
import {
  ALLOWED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  decodeDocument,
  sanitiseFileName,
  sniffDocumentType,
} from "./documentUpload";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x22),
]);
// An SVG is an HTML document. Renaming it .png and declaring image/png is the
// exact attack the sniffing exists to stop.
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

const b64 = (b: Buffer) => b.toString("base64");

describe("sniffDocumentType", () => {
  it("identifies the three accepted containers", () => {
    expect(sniffDocumentType(PDF)).toBe("application/pdf");
    expect(sniffDocumentType(JPEG)).toBe("image/jpeg");
    expect(sniffDocumentType(PNG)).toBe("image/png");
  });

  it("refuses anything else, including SVG and empty input", () => {
    expect(sniffDocumentType(SVG)).toBeNull();
    expect(sniffDocumentType(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffDocumentType(Buffer.from("PK\x03\x04"))).toBeNull();
    expect(sniffDocumentType(Buffer.alloc(0))).toBeNull();
    expect(sniffDocumentType(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated JPEG magic
  });

  it("never reports a type outside the allow-list", () => {
    for (const buf of [PDF, JPEG, PNG]) {
      expect(ALLOWED_DOCUMENT_TYPES).toContain(sniffDocumentType(buf)!);
    }
    expect(ALLOWED_DOCUMENT_TYPES).not.toContain("image/svg+xml" as never);
  });
});

describe("sanitiseFileName", () => {
  it("strips path separators", () => {
    expect(sanitiseFileName("../../etc/passwd")).not.toContain("/");
    expect(sanitiseFileName("C:\\Users\\me\\id.pdf")).not.toContain("\\");
  });

  it("strips control characters and quotes that could forge a header", () => {
    const out = sanitiseFileName('bad\r\nContent-Type: text/html\u0000"x".pdf');
    expect(out).not.toMatch(/[\u0000-\u001f\u007f"]/);
  });

  it("collapses dot runs so the real extension cannot be hidden", () => {
    expect(sanitiseFileName("proof....png")).toBe("proof.png");
  });

  it("keeps a sensible name and caps the length", () => {
    expect(sanitiseFileName("birth certificate.pdf")).toBe("birth certificate.pdf");
    expect(sanitiseFileName("x".repeat(500)).length).toBe(120);
  });

  it("falls back rather than returning an empty name", () => {
    expect(sanitiseFileName("")).toBe("document");
    expect(sanitiseFileName("///")).toBe("___");
    expect(sanitiseFileName(".")).toBe("document");
  });
});

describe("decodeDocument", () => {
  it("accepts each allowed type and returns the sniffed value", () => {
    for (const [buf, mime] of [
      [PDF, "application/pdf"],
      [JPEG, "image/jpeg"],
      [PNG, "image/png"],
    ] as const) {
      const r = decodeDocument(b64(buf), mime);
      expect(r.ok, mime).toBe(true);
      if (!r.ok) continue;
      expect(r.document.mimeType).toBe(mime);
      expect(r.document.byteSize).toBe(buf.byteLength);
      expect(r.document.bytes.equals(buf)).toBe(true);
      expect(r.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("tolerates a data: URL prefix and embedded whitespace", () => {
    const withPrefix = `data:image/png;base64,${b64(PNG)}`;
    expect(decodeDocument(withPrefix, "image/png").ok).toBe(true);
    const wrapped = b64(PNG).replace(/(.{8})/g, "$1\n");
    expect(decodeDocument(wrapped, "image/png").ok).toBe(true);
  });

  it("rejects a renamed SVG declared as PNG", () => {
    const r = decodeDocument(b64(SVG), "image/png");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Sniffing fails before the mismatch check, since SVG is not a known type.
    expect(r.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects a real PNG declared as a PDF", () => {
    const r = decodeDocument(b64(PNG), "application/pdf");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("TYPE_MISMATCH");
    expect(r.message).toContain("image/png");
  });

  it("rejects oversize content before and after decoding", () => {
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_DOCUMENT_BYTES, 0x41)]);
    const r = decodeDocument(b64(big), "image/png");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects malformed base64 rather than silently truncating it", () => {
    // Buffer.from is lenient: it drops characters it does not recognise, so
    // without an explicit check this would decode to a short "valid" file.
    const r = decodeDocument("!!!!not base64 at all!!!!", "image/png");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_BASE64");
  });

  it("rejects base64 whose length is not a multiple of four", () => {
    const r = decodeDocument(`${b64(PNG)}A`, "image/png");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_BASE64");
  });

  it("rejects empty content", () => {
    for (const empty of ["", "   ", "data:image/png;base64,"]) {
      const r = decodeDocument(empty, "image/png");
      expect(r.ok, JSON.stringify(empty)).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe("FILE_EMPTY");
    }
  });

  it("hashes content stably, so the same file always yields the same sha256", () => {
    const a = decodeDocument(b64(PDF), "application/pdf");
    const b = decodeDocument(b64(PDF), "application/pdf");
    expect(a.ok && b.ok && a.document.sha256 === b.document.sha256).toBe(true);
  });
});
