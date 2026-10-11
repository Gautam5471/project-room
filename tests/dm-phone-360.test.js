// WAVE-500 G8 worker 23/50: DM thread attachments at 360px phone width.
//
// An attachment with a long filename (phone camera rolls love those) must
// truncate inside the ~300px message column instead of forcing horizontal
// overflow on the timeline. The composer keyboard contract (viewport asks the
// mobile keyboard to resize the layout so the composer stays visible) is
// guarded here too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// Returns the concatenated declaration blocks for every exact `selector { ... }` rule.
function rule(selector) {
  const needle = `${selector} {`;
  let blocks = "", from = 0, found = false;
  for (;;) {
    const start = css.indexOf(needle, from);
    if (start === -1) break;
    found = true;
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    assert.ok(close !== -1, `${selector} rule is closed`);
    blocks += css.slice(open + 1, close);
    from = close + 1;
  }
  assert.ok(found, `${selector} has a rule in src/styles.css`);
  return blocks;
}

test("attachment chips can shrink below their filename inside the message column", () => {
  const base = rule(".file-chip");
  assert.match(base, /min-width:\s*0/, "chip is allowed to shrink (flex default min-width:auto would overflow)");
});

test("attachment filenames truncate with an ellipsis instead of overflowing at 360px", () => {
  const label = rule(".file-chip > :first-child");
  assert.match(label, /min-width:\s*0/, "label flex item can shrink");
  assert.match(label, /overflow:\s*hidden/, "overflow is clipped");
  assert.match(label, /text-overflow:\s*ellipsis/, "clipped text shows an ellipsis");
  assert.match(label, /white-space:\s*nowrap/, "filename stays on one line while truncating");
});

test("the viewport asks the mobile keyboard to resize the layout, not cover the composer", () => {
  const meta = html.match(/<meta name="viewport"[^>]*>/);
  assert.ok(meta, "viewport meta exists in index.html");
  assert.match(meta[0], /interactive-widget=resizes-content/,
    "keyboard resizes the layout viewport so the bottom-anchored composer stays visible");
});
