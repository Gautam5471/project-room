// Attachment download (A009). A pure attachment manager: validates
// metadata (filename, size, MIME type), blocks dangerous extensions,
// tracks download state per attachment (pending → downloading → done or
// failed), and enforces a per-message size cap. All state is
// caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw AttachmentError. Actual byte fetching
// and storage wiring is a later slice.
const BLOCKED_EXTENSIONS = Object.freeze(["exe", "bat", "cmd", "com", "scr", "ps1", "vbs", "jar", "msi"]);
const DEFAULTS = Object.freeze({ maxFileBytes: 25 * 1024 * 1024, maxMessageBytes: 100 * 1024 * 1024 });
class AttachmentError extends Error { constructor(code, message) { super(message); this.name = "AttachmentError"; this.code = code; } }
const fail = (code, message) => { throw new AttachmentError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_attachment", message); };

// Windows (and most download handlers on it) silently drop trailing dots and
// spaces, so "evil.exe." and "evil.exe " land on disk as evil.exe. A colon
// names an NTFS alternate data stream: "evil.exe::$DATA" and
// "evil.exe:Zone.Identifier" are saved as evil.exe. Read the extension of
// the name before that colon, the way the file will actually be saved.
const extensionOf = filename => {
  const saved = filename.split(":")[0].replace(/[.\s]+$/u, "");
  const dot = saved.lastIndexOf(".");
  return dot === -1 ? "" : saved.slice(dot + 1).toLowerCase();
};
// Validate attachment metadata without touching bytes.
export function validateAttachment({ filename, sizeBytes, mimeType }, { maxFileBytes } = {}) {
  check(typeof filename === "string" && filename.length > 0 && filename.length <= 255,
    "filename must be 1-255 chars");
  check(!filename.includes("/") && !filename.includes("\\") && !filename.includes("\0"),
    "filename must not contain path separators");
  check(Number.isInteger(sizeBytes) && sizeBytes >= 0, "sizeBytes must be a non-negative integer");
  check(typeof mimeType === "string" && mimeType.length > 0, "mimeType must be a non-empty string");
  const max = maxFileBytes ?? DEFAULTS.maxFileBytes;
  check(Number.isInteger(max) && max > 0, "maxFileBytes must be positive");
  const ext = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.includes(ext))
    fail("blocked_extension", `extension ".${ext}" is blocked for security`);
  if (sizeBytes > max)
    fail("file_too_large", `file ${sizeBytes} bytes exceeds limit ${max}`);
  return Object.freeze({ filename, sizeBytes, mimeType, extension: ext });
}
// Create a download tracker. store is a caller-owned Map (attachmentId -> record).
export function createDownloadTracker({ store, maxMessageBytes } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const cap = maxMessageBytes ?? DEFAULTS.maxMessageBytes;
  check(Number.isInteger(cap) && cap > 0, "maxMessageBytes must be positive");
  const downloads = store ?? new Map();
  // Register an attachment for a message. Enforces the per-message cap.
  const register = (messageId, attachmentId, metadata) => {
    check(typeof messageId === "string" && messageId.length > 0, "messageId must be a non-empty string");
    check(typeof attachmentId === "string" && attachmentId.length > 0, "attachmentId must be a non-empty string");
    check(!downloads.has(attachmentId), `attachment "${attachmentId}" already registered`);
    const validated = validateAttachment(metadata);
    const messageTotal = [...downloads.values()]
      .filter(d => d.messageId === messageId)
      .reduce((t, d) => t + d.sizeBytes, 0) + validated.sizeBytes;
    if (messageTotal > cap)
      fail("message_too_large", `message attachments total ${messageTotal} bytes exceeds limit ${cap}`);
    const record = Object.freeze({ attachmentId, messageId, ...validated, state: "pending", error: null });
    downloads.set(attachmentId, record);
    return record;
  };
  const markDownloading = attachmentId => {
    check(downloads.has(attachmentId), `unknown attachment "${attachmentId}"`);
    const current = downloads.get(attachmentId);
    check(current.state === "pending", `attachment "${attachmentId}" is ${current.state}, not pending`);
    const updated = Object.freeze({ ...current, state: "downloading" });
    downloads.set(attachmentId, updated);
    return updated;
  };
  const markDone = attachmentId => {
    check(downloads.has(attachmentId), `unknown attachment "${attachmentId}"`);
    const current = downloads.get(attachmentId);
    check(current.state === "downloading", `attachment "${attachmentId}" is ${current.state}, not downloading`);
    const updated = Object.freeze({ ...current, state: "done" });
    downloads.set(attachmentId, updated);
    return updated;
  };
  const markFailed = (attachmentId, error) => {
    check(downloads.has(attachmentId), `unknown attachment "${attachmentId}"`);
    check(typeof error === "string" && error.length > 0, "error must be a non-empty string");
    const updated = Object.freeze({ ...downloads.get(attachmentId), state: "failed", error });
    downloads.set(attachmentId, updated);
    return updated;
  };
  return Object.freeze({ register, markDownloading, markDone, markFailed,
    size: () => downloads.size, DEFAULTS, BLOCKED_EXTENSIONS });
}
export { AttachmentError };
