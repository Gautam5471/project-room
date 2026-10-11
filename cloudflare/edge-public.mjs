// Static assets and discovery documents answered by the Worker isolate.
// They must not enter the invite-only-pilot Durable Object: that object is
// single-threaded, and a cold wake or a synchronous stretch closes its input
// gate for every route that shares it. Asset bytes are cached for the life
// of this isolate; a deploy starts a new one.
import { publicAssetPaths } from '../deploy/public-assets.mjs';
import { acceptPrefersHtml, publicHtmlNotFoundPath, publicSearchAssets, publicSearchCanonical, publicSearchMarketingPolicy, publicPageCsp, PUBLIC_NOT_FOUND_HTML, PUBLIC_SEARCH_CSP, reviewedPublicSearchPaths } from '../deploy/public-search.mjs';
import { discoveryDoc, EDGE_DOOR_HOSTS, ROOM_ORIGIN, SKILLS_CATALOG_PATH } from '../deploy/agent-discovery.mjs';
import { buildOpenApiJson } from '../server/discoverability.mjs';
import { MCP_SERVER_CARD_PATH, MCP_DISCOVERY_CACHE_CONTROL, MCP_SERVER_CARD_CORS } from '../src/mcp-server-card.mjs';

const APP_CSP = "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const ASSET_CACHE_MAX = 96;
const assetCache = new Map();
let openApiCache = null;

const assetType = path => path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript'
  : path.endsWith('.css') ? 'text/css'
  : path.endsWith('.html') ? 'text/html'
  : path.endsWith('.png') ? 'image/png'
  : path.endsWith('.ttf') ? 'font/ttf'
  : path.endsWith('.txt') ? 'text/plain'
  : path.endsWith('.svg') ? 'image/svg+xml'
  : path.endsWith('.webmanifest') ? 'application/manifest+json'
  : path.endsWith('.json') ? 'application/json'
  : path.endsWith('.sh') ? 'text/plain'
  : 'text/markdown; charset=utf-8';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/offers', ['offers.html', 'text/html']],
  ...publicAssetPaths.map(path => [`/${path}`, [path, assetType(path)]])
]);
for (const [url, file] of publicSearchAssets(publicAssetPaths)) assets.set(url, [file, 'text/html']);
// DX-1a begin: scripts/install.sh is the installer. Its public URL is /install.sh.
assets.set('/install.sh', ['scripts/install.sh', 'text/plain']);
// DX-1a end

const skillsDoc = discoveryDoc(SKILLS_CATALOG_PATH);

function discoveryLinks(url) {
  const base = url.origin === ROOM_ORIGIN || EDGE_DOOR_HOSTS.includes(url.hostname) ? ROOM_ORIGIN : '';
  return [
    `<${base}/.well-known/agent-card.json>; rel="alternate"; type="application/json"`,
    `<${base}/llms.txt>; rel="help"`,
    `<${base}/skills>; rel="describedby"`,
    `<${base}/room>; rel="alternate"; type="text/html"`
  ].join(', ');
}

function baseHeaders(url) {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.set('Content-Security-Policy', APP_CSP);
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return headers;
}

function methodNotAllowed(headers, allow) {
  headers.set('Allow', allow);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  const body = JSON.stringify({ error: { code: 'method_not_allowed', message: 'Method not allowed' } });
  headers.set('Content-Length', String(body.length));
  return new Response(body, { status: 405, headers });
}

// `asset` is a file served from env.ASSETS. `discovery` and `openapi` are
// generated documents with no per-caller data. The skills catalog is not
// here: the Durable Object injects the live member layer.
// GR1: www.getdasha.com/room/<page> keeps the prefix through the worker rewrite.
// The same packaged document is served, with a canonical Link on the room host.
function roomMarketingPath(pathname) {
  if (!pathname.startsWith('/room/')) return null;
  const rest = pathname.slice('/room'.length);
  // /room/ is the public door, not the app shell.
  if (rest === '/' || rest === '') return null;
  return assets.has(rest) ? rest : null;
}

let securityContactWarned = false;

function securityContactFrom(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const contact = trimmed.includes(':') ? trimmed : `mailto:${trimmed}`;
  if (!/^mailto:/i.test(contact) && !/^https:\/\//i.test(contact)) return null;
  return contact;
}

function securityTxtResponse(request, url, contact) {
  const headers = baseHeaders(url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers, 'GET, HEAD');
  if (!contact) {
    if (!securityContactWarned) {
      securityContactWarned = true;
      console.warn('ROOM_SECURITY_CONTACT is unset; /.well-known/security.txt returns 404');
    }
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    const body = 'Not found\n';
    headers.set('Content-Length', String(body.length));
    return new Response(request.method === 'HEAD' ? null : body, { status: 404, headers });
  }
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = `Contact: ${contact}\nExpires: ${expires}\n`;
  const bytes = new TextEncoder().encode(body);
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

export function classifyEdgePath(pathname) {
  if (pathname === '/.well-known/security.txt' || pathname === '/room/.well-known/security.txt') return 'security-txt';
  if (pathname === '/openapi.json' || pathname === '/room/openapi.json') return 'openapi';
  const doc = discoveryDoc(pathname);
  if (doc && doc !== skillsDoc) return 'discovery';
  if (assets.has(pathname) || roomMarketingPath(pathname)) return 'asset';
  return null;
}

const REVALIDATED_ASSET_TYPES = ['text/javascript', 'text/css', 'image/svg+xml', 'application/manifest+json'];
export function assetCachePolicy(type) {
  const base = String(type).split(';')[0].trim();
  if ((base.startsWith('image/') && base !== 'image/svg+xml') || base.startsWith('font/')) return 'public, max-age=86400';
  if (REVALIDATED_ASSET_TYPES.includes(base)) return 'no-cache';
  return null;
}
const assetEtags = new WeakMap();
async function assetEtag(bytes) {
  let etag = assetEtags.get(bytes);
  if (!etag) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    etag = `"${Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('')}"`;
    assetEtags.set(bytes, etag);
  }
  return etag;
}
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  return header.split(',').some(tag => {
    const value = tag.trim().replace(/^W\//, '');
    return value === '*' || value === etag;
  });
}

async function loadCachedAsset(env, file) {
  const cached = assetCache.get(file);
  if (cached) {
    assetCache.delete(file);
    assetCache.set(file, cached);
    return cached;
  }
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function' || !env.ROOM_ORIGIN) return null;
  const response = await env.ASSETS.fetch(new Request(new URL('/' + file, env.ROOM_ORIGIN)));
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  assetCache.set(file, bytes);
  while (assetCache.size > ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value);
  return bytes;
}

function openApiBody(origin) {
  if (!openApiCache || openApiCache.origin !== origin) {
    openApiCache = { origin, body: JSON.stringify(buildOpenApiJson({ origin })) };
  }
  return openApiCache.body;
}

function openApiResponse(request, url) {
  const headers = baseHeaders(url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers, 'GET, HEAD');
  const bytes = new TextEncoder().encode(openApiBody(url.origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

function discoveryResponse(request, url) {
  const doc = discoveryDoc(url.pathname);
  const headers = baseHeaders(url);
  headers.set('X-Robots-Tag', 'all');
  headers.set('Link', discoveryLinks(url));
  const card = doc === discoveryDoc(MCP_SERVER_CARD_PATH);
  if (card) {
    headers.set('Cache-Control', MCP_DISCOVERY_CACHE_CONTROL);
    for (const [name, value] of Object.entries(MCP_SERVER_CARD_CORS)) headers.set(name, value);
  }
  const allow = card ? 'GET, HEAD, OPTIONS' : 'GET, HEAD';
  if (request.method === 'OPTIONS' && card) {
    headers.set('Allow', allow);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers, allow);
  let body;
  try { body = doc.body; }
  catch { return null; }
  const bytes = new TextEncoder().encode(body);
  headers.set('Content-Type', doc.type);
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

async function assetResponse(request, env, url) {
  const headers = baseHeaders(url);
  const servedPath = roomMarketingPath(url.pathname) ?? url.pathname;
  const canonical = publicSearchCanonical(servedPath, publicAssetPaths);
  const canonicalTarget = canonical && reviewedPublicSearchPaths.includes(canonical) ? canonical : null;
  headers.set('Link', canonicalTarget ? `${discoveryLinks(url)}, <${ROOM_ORIGIN}${canonicalTarget}>; rel="canonical"` : discoveryLinks(url));
  // About and compare pages have no scripts. The app shell and offers page keep
  // the room policy from baseHeaders so their modules load.
  if (canonical && publicSearchMarketingPolicy(canonical)) headers.set('Content-Security-Policy', publicPageCsp(url.origin, PUBLIC_SEARCH_CSP));
  if (canonical && !url.search && canonical !== servedPath) {
    headers.set('Location', canonical);
    return new Response(null, { status: 301, headers });
  }
  if (canonical && !url.search && reviewedPublicSearchPaths.includes(canonical)) headers.set('X-Robots-Tag', 'all');
  const [file, type] = assets.get(servedPath);
  const bytes = await loadCachedAsset(env, file);
  if (!bytes) {
    // A reviewed page with no packaged bytes is an error, not a public
    // document. Do not leave the indexable robots tag that a present page
    // would have set above.
    // Q3-E: browsers get the static HTML 404. Other clients keep the plain
    // body. Unknown paths are answered by the Node server after routing, so
    // live pages such as /receipts are not claimed here.
    if (publicHtmlNotFoundPath(url.pathname) && acceptPrefersHtml(request.headers.get('accept'))) {
      const page = new TextEncoder().encode(PUBLIC_NOT_FOUND_HTML);
      headers.set('X-Robots-Tag', 'noindex');
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.set('Content-Length', String(page.byteLength));
      return new Response(request.method === 'HEAD' ? null : page, { status: 404, headers });
    }
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : 'Not found\n', { status: 404, headers });
  }
  const contentType = (type.startsWith('image/') && !type.includes('svg')) || type.startsWith('font/') ? type : (type.includes('charset') ? type : `${type}; charset=utf-8`);
  headers.set('Content-Type', contentType);
  // Static assets were no-store, so every visit re-downloaded the ~1.9 MB app
  // shell (app.js, styles, emoji catalog). Binary images and fonts get the
  // same one-day cache the Node server gives them. Scripts, styles and SVG
  // keep unhashed names, so they revalidate on every load (no-cache) against a
  // content ETag and an unchanged file costs a 304. HTML stays no-store.
  const policy = assetCachePolicy(type);
  if (policy) {
    headers.set('Cache-Control', policy);
    const etag = await assetEtag(bytes);
    headers.set('ETag', etag);
    if (etagMatches(request.headers.get('if-none-match'), etag)) {
      headers.delete('Content-Type');
      return new Response(null, { status: 304, headers });
    }
  }
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

// Response for a path that must not enter the Durable Object, or null when
// the request still belongs to the object (health, API, skills members).
export async function edgePublicResponse(request, env, url) {
  const kind = classifyEdgePath(url.pathname);
  if (!kind) return null;
  if (kind === 'security-txt') return securityTxtResponse(request, url, securityContactFrom(env?.ROOM_SECURITY_CONTACT));
  if (kind === 'openapi') return openApiResponse(request, url);
  if (kind === 'discovery') return discoveryResponse(request, url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(baseHeaders(url), 'GET, HEAD');
  return assetResponse(request, env, url);
}
