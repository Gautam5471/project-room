import { uiText } from "./strings.js";

// Composer file chips. Bytes go to the room file routes, which call the same
// room_attachments store the MCP file tools use (stage, then commit onto the
// message the member just posted). The password and the file bytes never
// land in localStorage or sessionStorage.

export const COMPOSER_FILE_BYTES = 1048576;

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function attachmentFromBytes({ id, filename, mediaType, bytes }) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (view.byteLength > COMPOSER_FILE_BYTES) {
    const error = new Error("That file is larger than 1 MB.");
    error.code = "file_too_large";
    throw error;
  }
  const name = typeof filename === "string" && filename.trim() ? filename.trim() : "file";
  const type = typeof mediaType === "string" && mediaType.trim() ? mediaType.trim() : "application/octet-stream";
  return { id, filename: name, mediaType: type, data: bytesToBase64(view) };
}

export function fileChipLabel(filename) {
  const name = typeof filename === "string" && filename.trim() ? filename.trim() : "file";
  return name;
}

export function composerAudienceNote(members, to) {
  // A truthy map lookup treats toString as a recipient and writes a private note for nobody.
  const recipient = to && members && Object.hasOwn(members, to) ? members[to] : undefined;
  if (!recipient) return null;
  return `Private — only you and ${recipient.displayName} can see this message.`;
}

// The "Talking to" picker is the broadcast-vs-DM control: "Everyone" sends to
// the room, a member makes it a private DM. It stays visible whenever there
// is someone to address — hiding it until a recipient was already chosen
// made room-chat DMs undiscoverable, because the hidden control was the only
// way to start one. Request mode always shows it (the request needs a
// recipient). A solo room hides it (the only option would be "Everyone").
export function composerAudiencePickerVisible({ members, selfId, requestMode } = {}) {
  if (requestMode) return true;
  return (members || []).some(member => member && member.active !== false && member.id !== selfId);
}

// Upload refusals the server words for operators ('extension ".exe" is
// blocked for security') get plain copy in the composer.
export function attachFailureCopy(error) {
  if (error?.code === "file_too_large") return "That file is larger than 1 MB.";
  if (error?.code === "blocked_extension") return uiText("file.attach.blockedType");
  return error?.message || uiText("file.attach.failed");
}

// Files commit onto a message after it posts, and the commit appends no room
// event, so another member's client reads the file list again shortly after
// their message arrives, then once more to cover a slow commit.
export const ROOM_FILE_REFRESH_DELAYS_MS = Object.freeze([1200, 5000]);
export function arrivalsNeedFileRefresh(newMessages, selfId) {
  return (newMessages || []).some(message => message && message.authorId !== selfId);
}
