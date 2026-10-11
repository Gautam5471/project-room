import test from "node:test";
import assert from "node:assert/strict";
import { validateAttachment, createDownloadTracker, AttachmentError } from "../server/attachments.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof AttachmentError && error.code === code);

test("validateAttachment reads the extension Windows saves when a colon names an NTFS stream", () => {
  for (const filename of ["evil.exe::$DATA", "evil.exe:Zone.Identifier", "evil.bat:hidden.txt", "evil.cmd.:$DATA"]) {
    throwsCode(() => validateAttachment({ filename, sizeBytes: 10, mimeType: "text/plain" }), "blocked_extension");
  }
  const pdf = validateAttachment({ filename: "report.pdf:Zone.Identifier", sizeBytes: 12, mimeType: "application/pdf" });
  assert.equal(pdf.extension, "pdf");
  assert.equal(pdf.filename, "report.pdf:Zone.Identifier");
  assert.equal(validateAttachment({ filename: "archive.tar.gz", sizeBytes: 1, mimeType: "application/gzip" }).extension, "gz");
  assert.equal(validateAttachment({ filename: "notes.txt.", sizeBytes: 1, mimeType: "text/plain" }).extension, "txt");
  const tracker = createDownloadTracker();
  throwsCode(() => tracker.register("m1", "a-stream", {
    filename: "evil.exe::$DATA", sizeBytes: 10, mimeType: "text/plain"
  }), "blocked_extension");
});
