// Public acquisition pages: template gallery, opt-in room pages, agent directory,
// and the demo room. Script-free HTML. Member-authored text is escaped on the
// page and marked untrusted on the JSON agents read. The pages read
// public_rooms, public_receipts, and public_directory_entries. They do not read
// rooms.projection, and a GET does not mint a share link. The demo room is the
// exception: it reads nothing at all — curated static content only.
import { escapeHtml, RECEIPTS_PAGE_CSP } from "./receipts-page.mjs";
import { CONTENT_TRUST } from "./content-trust.mjs";
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";
import { PUBLIC_PAGE_LASTMOD } from "../deploy/public-search.mjs";
import { listRoomTemplates, getRoomTemplate } from "./templates.mjs";
import { LEGAL_FOOTER_LINKS, reportHref } from "./legal-pages.mjs";
import { loadPublicRoom, listPublicRoomSitemap, queryDirectoryEntries, roomPageReceipts } from "./public-read-model.mjs";
import { excludeHiddenReceipts } from "./receipts-live.mjs";

export { RECEIPTS_PAGE_CSP as PUBLIC_PAGE_CSP };

const OG_IMAGE = `${ROOM_ORIGIN}/og/home.png`;

export function publicRef(value) {
  if (typeof value !== "string") return "";
  const ref = value.trim();
  if (!ref || ref.length > 80 || /[\u0000-\u001f\u007f]/.test(ref)) return "";
  return ref;
}

const withRef = (path, ref) => {
  const url = new URL(path, ROOM_ORIGIN);
  const clean = publicRef(ref);
  if (clean) url.searchParams.set("ref", clean);
  return `${url.pathname}${url.search}${url.hash}`;
};

const pageStyle = () => `:root{color-scheme:dark}
body{margin:0;background:#10141a;color:#e8eef6;font:17px/1.55 system-ui,sans-serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:clamp(1.6rem,5vw,2.2rem);line-height:1.15;letter-spacing:-.03em}
a{color:#8eb6ff}
.card{border-top:1px solid #2a3340;padding:1rem 0;overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.meta{color:#9aa6b2;font-size:.9rem}
footer{margin-top:2rem;border-top:1px solid #2a3340;padding-top:1rem;color:#9aa6b2}
img,svg,table{max-width:100%}`;

function head({ title, description, path }) {
  const canonical = `${ROOM_ORIGIN}${path}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="content-trust" content="${escapeHtml(CONTENT_TRUST)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<style>${pageStyle()}</style>
</head>`;
}

const shell = heading => `<body><header><p><a href="/">Project Room</a>${heading ? ` · ${heading}` : ""}</p></header>`;

const ROOM_RECEIPT_PAGE = 5;
const ROOM_RECEIPT_SCAN = 200;

// The room page shows five receipts. An owner-hidden row does not fill a
// slot: cutting the query at five and then dropping hidden rows left the
// page empty while an older public receipt remained.
function visibleRoomReceipts(store, slug, receiptsEnabled) {
  const receipts = [];
  let after = null;
  let scanned = 0;
  while (receipts.length < ROOM_RECEIPT_PAGE && scanned < ROOM_RECEIPT_SCAN) {
    const batch = roomPageReceipts(store, slug, receiptsEnabled, { limit: ROOM_RECEIPT_PAGE, after });
    if (!batch.length) break;
    scanned += batch.length;
    after = { at: batch.at(-1).at, id: batch.at(-1).id };
    for (const item of excludeHiddenReceipts(store, batch)) {
      if (receipts.length === ROOM_RECEIPT_PAGE) break;
      receipts.push({ id: item.id, title: item.title, href: `/receipts/${item.id}` });
    }
    if (batch.length < ROOM_RECEIPT_PAGE) break;
  }
  return receipts;
}

function requestHref(slug, ref) {
  return withRef(`/?request=${encodeURIComponent(slug)}`, ref);
}

export function publicRoomView(store, slug, { ref = "" } = {}) {
  const room = loadPublicRoom(store, slug);
  if (!room) return null;
  const clean = publicRef(ref);
  const join = room.joinMode === "link" && room.joinToken
    ? { mode: "link", href: withRef(`/#join/${room.joinToken}`, clean) }
    : { mode: "request", href: requestHref(slug, clean) };
  const receipts = visibleRoomReceipts(store, slug, room.receiptsEnabled);
  const document = {
    schema: "project-room-public-room/1",
    contentTrust: CONTENT_TRUST,
    untrusted: true,
    slug,
    title: room.title,
    purpose: room.purpose,
    counts: room.counts,
    names: room.names,
    tasks: room.tasks,
    receipts,
    join,
  };
  const description = room.purpose || `${room.title} on Project Room.`;
  const nameLine = room.names.length ? `<p>People who show their name: ${room.names.map(escapeHtml).join(", ")}</p>` : "";
  const taskLine = room.tasks.length
    ? `<ul>${room.tasks.map(item => `<li>${escapeHtml(item.title)}</li>`).join("")}</ul>`
    : `<p>No open public tasks.</p>`;
  const receiptLine = receipts.length
    ? `<ul>${receipts.map(item => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a></li>`).join("")}</ul>`
    : `<p>No public receipts from this room yet.</p>`;
  const html = `${head({ title: room.title, description, path: `/r/${slug}` })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<h1>${escapeHtml(room.title)}</h1>
<p>${escapeHtml(room.purpose)}</p>
<p class="meta">${room.counts.humans} ${room.counts.humans === 1 ? "person" : "people"} · ${room.counts.agents} ${room.counts.agents === 1 ? "agent" : "agents"}</p>
${nameLine}
<h2>Open tasks</h2>
${taskLine}
<h2>Public receipts</h2>
${receiptLine}
<p><a href="${escapeHtml(join.href)}">Join</a></p>
<p><a href="${escapeHtml(reportHref("room", slug))}">Report</a></p>
</main>
<footer><a href="/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return { html, document };
}

// Demo room (wave-2 human-UX #1599): one illustrative sanitized conversation
// for unauthenticated visitors — "what the product IS" before sign-in. The
// content is frozen and fictional; the view takes no store argument, so no
// live room data, member PII, or opt-in state can ever reach the page. It is
// labeled a demo snapshot throughout and must stay that way.
const DEMO_ROOM = Object.freeze({
  title: "The Demo Room",
  purpose: "Friends working together with one assistant in a shared conversation.",
  members: Object.freeze([
    Object.freeze({ name: "Mara", kind: "person" }),
    Object.freeze({ name: "Leo", kind: "person" }),
    Object.freeze({ name: "Room", kind: "assistant" }),
  ]),
  messages: Object.freeze([
    Object.freeze({ from: "Mara", body: "@Room, help us triage the support threads before Friday." }),
    Object.freeze({ from: "Leo", body: "Please prioritize the mobile issues. We have a release coming up." }),
    Object.freeze({ from: "Room", body: "I am grouping the reports and checking which ones affect mobile. I have included Leo's priority." }),
    Object.freeze({ from: "Room", body: "Here is the triage summary: three bugs, five questions and four requests. Two mobile bugs should come first." }),
    Object.freeze({ from: "Mara", body: "Looks good. Let's take those two first." }),
  ]),
  tasks: Object.freeze(["Fix the two mobile bugs", "Draft the weekly changelog"]),
  receipts: Object.freeze(["Support triage summary", "Changelog draft"]),
});

export function demoRoomView({ ref = "" } = {}) {
  const room = DEMO_ROOM;
  const clean = publicRef(ref);
  const start = withRef("/?start=room", clean);
  const description = `${room.title}: ${room.purpose} Demo snapshot with illustrative content.`;
  const memberLine = room.members.map(item => `<li>${escapeHtml(item.name)} · ${escapeHtml(item.kind)}</li>`).join("");
  const messageLine = room.messages.map(item =>
    `<article class="card"><p class="meta">${escapeHtml(item.from)}</p><p>${escapeHtml(item.body)}</p></article>`
  ).join("\n");
  const taskLine = `<ul>${room.tasks.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const receiptLine = `<ul>${room.receipts.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const document = {
    schema: "project-room-demo-room/1",
    contentTrust: CONTENT_TRUST,
    untrusted: true,
    demo: true,
    title: room.title,
    purpose: room.purpose,
    members: room.members.map(item => ({ name: item.name, kind: item.kind })),
    messages: room.messages.map(item => ({ from: item.from, body: item.body })),
    tasks: [...room.tasks],
    receipts: [...room.receipts],
  };
  const html = `${head({ title: `${room.title} · Project Room demo`, description, path: "/demo" })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<p class="meta">Demo snapshot — everything on this page is illustrative content, not a live room.</p>
<h1>${escapeHtml(room.title)}</h1>
<p>${escapeHtml(room.purpose)}</p>
<p class="meta">${room.members.filter(item => item.kind === "person").length} people · one assistant</p>
<h2>Who is here</h2>
<ul>${memberLine}</ul>
<h2>The conversation</h2>
${messageLine}
<h2>Open tasks</h2>
${taskLine}
<h2>Shared results</h2>
${receiptLine}
<p><a href="${escapeHtml(start)}">Start your own room</a> — sign in to join a real room.</p>
</main>
<footer><a href="/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return { html, document };
}

export function templatesIndex() {
  const templates = listRoomTemplates();
  const description = "Start a Project Room from a template: channels, starter tasks, and a board claim with no files yet.";
  const cards = templates.map(template => `<article class="card">
<h2><a href="/templates/${escapeHtml(template.slug)}">${escapeHtml(template.title)}</a></h2>
<p>${escapeHtml(template.purpose)}</p>
</article>`).join("");
  const html = `${head({ title: "Project Room — templates", description, path: "/templates" })}
${shell("")}
<main>
<h1>Templates</h1>
<p>Each template starts a room with a purpose, channels, and a few tasks. Sign in to create it. Your messages stay in the room.</p>
${cards}
</main>
<footer><a href="/agents">Agent directory</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return {
    html,
    document: { schema: "project-room-template-list/1", templates },
  };
}

export function templatePage(slug, { ref = "" } = {}) {
  const template = getRoomTemplate(slug);
  if (!template) return null;
  const description = template.purpose;
  const start = withRef(`/?start=template&template=${encodeURIComponent(template.slug)}`, ref);
  const tasks = template.tasks.map(item => `<li>${escapeHtml(item.title)}</li>`).join("");
  const html = `${head({ title: template.title, description, path: `/templates/${template.slug}` })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<h1>${escapeHtml(template.title)}</h1>
<p>${escapeHtml(template.purpose)}</p>
<h2>Starter tasks</h2>
<ul>${tasks}</ul>
<p><a href="${escapeHtml(start)}">Start this room</a></p>
</main>
<footer><a href="/templates">All templates</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return {
    html,
    document: {
      schema: "project-room-template/1",
      slug: template.slug,
      title: template.title,
      purpose: template.purpose,
      start,
    },
  };
}

export function agentDirectoryView(store, { ref = "", cursor = null } = {}) {
  const queried = queryDirectoryEntries(store, { cursor: cursor || null });
  if (queried.error) return queried;
  const cards = queried.agents.map(agent => ({
    ...agent,
    inviteHref: withRef(`/?start=invite-agent&agent=${encodeURIComponent(agent.agentId)}`, ref),
    untrusted: true,
  }));
  const description = "Agents who published a public card. Invite one into your room with your own referral link.";
  const nextHref = queried.nextCursor ? withRef(`/agents?cursor=${encodeURIComponent(queried.nextCursor)}`, ref) : "";
  const list = cards.length ? cards.map(agent => `<article class="card">
<h2>${escapeHtml(agent.name)}</h2>
<p>${escapeHtml(agent.description)}</p>
<p class="meta">${agent.skills.length ? escapeHtml(agent.skills.join(", ")) : "No skills listed"} · ${agent.receiptCount} public ${agent.receiptCount === 1 ? "receipt" : "receipts"} · ${agent.roomCount} public ${agent.roomCount === 1 ? "room" : "rooms"}</p>
<p><a href="${escapeHtml(agent.inviteHref)}">Invite to my room</a></p>
<p><a href="${escapeHtml(reportHref("agent", agent.agentId))}">Report</a></p>
</article>`).join("") : `<p>No agents have published a public card yet.</p>`;
  const more = nextHref ? `<p><a href="${escapeHtml(nextHref)}">More agents</a></p>` : "";
  const html = `${head({ title: "Project Room — agents", description, path: "/agents" })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<h1>Agents</h1>
<p>These agents opted in to a public card. Invite sends a join link from you. The referral is credited to you when their operator joins.</p>
${list}
${more}
</main>
<footer><a href="/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return {
    html,
    document: { schema: "project-room-agent-directory/1", contentTrust: CONTENT_TRUST, agents: cards, nextCursor: queried.nextCursor },
  };
}

export function publicSitemapEntries(store) {
  const entries = [
    { path: "/templates", lastmod: PUBLIC_PAGE_LASTMOD },
    ...listRoomTemplates().map(template => ({ path: `/templates/${template.slug}`, lastmod: PUBLIC_PAGE_LASTMOD })),
    { path: "/agents", lastmod: PUBLIC_PAGE_LASTMOD },
  ];
  for (const room of listPublicRoomSitemap(store)) {
    entries.push({
      path: `/r/${room.slug}`,
      lastmod: typeof room.setAt === "string" && room.setAt.length >= 10 ? room.setAt.slice(0, 10) : PUBLIC_PAGE_LASTMOD,
    });
  }
  return entries;
}
