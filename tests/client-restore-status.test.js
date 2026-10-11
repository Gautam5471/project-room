// P3: a successful restore() must not leave a stale "sign in required" status
// behind. An anonymous probe on a cold direct-room URL paints that line; after
// a 200 session the status must read Connecting until the stream says Connected.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const sessionBinding = "session-binding-human";
const identity = { account: { id: "account-human", authEpoch: 0 }, member: { id: "human" }, roomId: "commons", csrf: "c", sessionBinding };
const snapshot = { sequence: 1, roomId: "commons", state: {}, cursor: 0, viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: sessionBinding };

function fixture(t) {
  let stream;
  class Events extends EventTarget { constructor() { super(); stream = this; } close() {} }
  const statuses = [];
  const client = new RoomClient({ events: Events, onStatus: text => statuses.push(text), onSnapshot: () => {},
    fetcher: async path => response(path === "/api/session" ? identity : snapshot) });
  t.after(() => client.disconnect());
  return { client, statuses, open: () => stream.dispatchEvent(new Event("open")) };
}

test("restore() after a stale signed-out status reports Connecting, then Connected on stream open", async t => {
  const { client, statuses, open } = fixture(t);
  client.onStatus("Not connected · account sign-in required"); // what the anonymous probe left on screen
  await client.restore();
  assert.equal(statuses.at(-1), "Connecting to room service…", "stale sign-in line is replaced once the session is confirmed");
  assert.ok(!statuses.slice(1).some(text => /sign.in required/.test(text)));
  open();
  assert.match(statuses.at(-1), /^Connected/);
});

test("a failed restore() never paints Connecting", async t => {
  const statuses = [];
  const client = new RoomClient({ events: EventTarget, onStatus: text => statuses.push(text), fetcher: async () => response({ error: "no" }, 401) });
  t.after(() => client.disconnect());
  await assert.rejects(() => client.restore());
  assert.ok(!statuses.includes("Connecting to room service…"));
});
