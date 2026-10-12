import test from "node:test";
import assert from "node:assert/strict";
import { createTimelinePin, arrivalsAfterShown } from "../src/conversation.js";

// R68-1: older history filling in above the newest message is not news.
test("only messages after the newest one shown count as arrivals", () => {
  const ids = ["m1", "m2", "m3", "m4", "m5", "m6"].map(id => ({ id }));
  const shown = new Set(["m3", "m4"]);
  assert.deepEqual(arrivalsAfterShown(ids, m => shown.has(m.id)).map(m => m.id), ["m5", "m6"]);
  assert.deepEqual(arrivalsAfterShown(ids, m => ["m5", "m6"].includes(m.id)), [], "a backfill above the shown tail is not new");
  assert.deepEqual(arrivalsAfterShown(ids.slice(0, 2), () => false).map(m => m.id), ["m1", "m2"], "an empty view still counts first arrivals");
});

test("a timeline pin holds until someone scrolls", () => {
  const list = { scrollTop: 900, scrollHeight: 1200, clientHeight: 300 };
  const pin = createTimelinePin();
  assert.equal(pin.holds("room:a", list), false);
  pin.set("room:a", list);
  assert.equal(pin.holds("room:a", list), true);
  assert.equal(pin.holds("room:b", list), false, "another view is not pinned");
  list.clientHeight = 80; list.scrollHeight = 5000;
  assert.equal(pin.holds("room:a", list), true, "a shorter list or more content keeps the pin");
  list.clientHeight = 400; list.scrollHeight = 1200; list.scrollTop = 800;
  assert.equal(pin.holds("room:a", list), true, "a taller list clamps scrollTop but stays flush with the bottom");
  list.scrollTop = 200;
  assert.equal(pin.holds("room:a", list), false, "the reader scrolled up");
  pin.set("room:a", list); pin.clear();
  assert.equal(pin.holds("room:a", list), false);
});
