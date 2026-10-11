// QA8 follow-up to the share-link preview fix: GX and guest-agent invite
// previews must not promise history the guest will not see.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { guestHistoryAccessLead, guestReadsHistoryFromJoin } from "../server/history-visibility.mjs";
import { GuestAgentLinks } from "../server/guest-agent-links.mjs";
import { EVENT_TYPES as T, event, PERMISSIONS, HISTORY_DEFAULTS_VERSION } from "../src/events.js";

const TAIL = "post messages, and react.";

test("guest history copy follows the room setting", () => {
  const v1 = { historyDefaultsVersion: HISTORY_DEFAULTS_VERSION };
  const legacy = {};
  const sinceJoin = { historyVisibility: { value: "since_join", revision: 1 } };
  const all = { historyVisibility: { value: "all", revision: 1 }, historyDefaultsVersion: HISTORY_DEFAULTS_VERSION };
  assert.equal(guestReadsHistoryFromJoin(v1), true);
  assert.equal(guestReadsHistoryFromJoin(legacy), true, "legacy rooms share the guest default (Oct 10 2026)");
  assert.equal(guestReadsHistoryFromJoin(sinceJoin), true);
  assert.equal(guestReadsHistoryFromJoin(all), false);
  assert.equal(guestHistoryAccessLead(v1), "Read messages posted after you join");
  assert.equal(guestHistoryAccessLead(legacy), "Read messages posted after you join");
  assert.equal(guestHistoryAccessLead(sinceJoin), "Read messages posted after you join");
  assert.match(guestHistoryAccessLead(all), /its history/);
  assert.doesNotMatch(guestHistoryAccessLead(v1), /history/);
});

test("guest-agent preview uses the room, not a fixed history promise", () => {
  const roomFor = room => ({
    db: null,
    room: () => ({ state: { room } })
  });
  const v1 = new GuestAgentLinks(roomFor({ id: "fresh", title: "Fresh", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION }));
  const hidden = v1.previewPublic({ room_id: "fresh", expires_at: 1 }, null);
  assert.match(hidden.access, /^Read messages posted after you join, post messages, and react\./);
  assert.doesNotMatch(hidden.access, /history/);
  assert.match(hidden.access, /No membership administration/);

  const legacy = new GuestAgentLinks(roomFor({ id: "old", title: "Old" }));
  assert.match(legacy.previewPublic({ room_id: "old", expires_at: 1 }, null).access, /^Read messages posted after you join, post messages, and react\./);
  const chosenAll = new GuestAgentLinks(roomFor({ id: "old", title: "Old", historyVisibility: { value: "all", revision: 1 } }));
  const open = chosenAll.previewPublic({ room_id: "old", expires_at: 1 }, null);
  assert.match(open.access, /Read the room and its history, post messages, and react\./);
  assert.match(open.access, new RegExp(TAIL.replace(".", "\\.")));
});

test("a v1 room's GX preview does not promise earlier messages", t => {
  const directory = mkdtempSync(join(tmpdir(), "qa8-guest-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const at = new Date(store.now()).toISOString();
  const roomId = "fresh-room";
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, at, data: {
      roomId, ownerId: "owner", title: "Fresh", purpose: "A new room", kind: "personal",
      historyDefaultsVersion: HISTORY_DEFAULTS_VERSION
    } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, at, data: {
      memberId: "owner", displayName: "Ada", kind: "human", permissions: [...PERMISSIONS]
    } })
  ]);
  const key = store.issueAccessKey(roomId, "owner");
  const revision = store.roomAuthority(roomId).members.owner.revision;
  const minted = store.guestInvites.mint(key, roomId, {
    requestId: randomUUID(), guestLabel: "Synapse visit", expectedOwnerRevision: revision
  });
  const preview = store.guestInvites.preview(minted.code);
  assert.match(preview.access, /^Read messages posted after you join, post messages, and react\./);
  assert.match(preview.access, /Drafts only with the contributor tier/);
  assert.doesNotMatch(preview.access, /its history/);

  store.command(key, roomId, { id: randomUUID(), type: T.ROOM_HISTORY_VISIBILITY_SET, data: { historyVisibility: "all" } });
  const shared = store.guestInvites.preview(minted.code);
  assert.match(shared.access, /Read the room and its history, post messages, and react\./);
});
