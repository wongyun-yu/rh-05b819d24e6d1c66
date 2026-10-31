/* research hub service worker (v2) — decrypts page assets on the fly.
   A page asset at <scope>/p/<h>/P is published only as <base>/_a/<sha256(K_p||"p/<h>/P")[:24]>.enc (12-byte IV || AES-256-GCM
   ct+tag), where K_p = HKDF(K, "page:p/<h>#<epoch>") is that page's own key and <base> is this repo or, for a heavy page,
   an auxiliary repo on the same origin (hub.json pb, sealed with K_p).
   Keys arrive from the unlocked page (postMessage) and are kept in IndexedDB 'rh'/'k':
     "key"   = the owner's site key K (derives any page key; epochs from hub.json pm, sealed with HKDF(K, "meta"))
     "pages" = {pdir: raw K_p} for pages opened through a share link or an invite code.
   No plaintext is ever stored. */
const SCOPE = new URL(self.registration.scope).pathname;
const MIME = {jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", json: "application/json",
  tsv: "text/tab-separated-values; charset=utf-8", csv: "text/csv; charset=utf-8", txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", js: "text/javascript", css: "text/css",
  glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "text/plain", ply: "application/octet-stream",
  pdf: "application/pdf", wasm: "application/wasm", bin: "application/octet-stream"};
const enc = new TextEncoder();
let OWNER = null;            // raw K (Uint8Array) or null
let PAGES = {};              // pdir → raw K_p (Uint8Array)
let LOADED = false;
const DERIVED = new Map();   // "pdir#epoch" → raw K_p (owner path)
function b64d(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function hex(u) { return Array.from(u, (x) => x.toString(16).padStart(2, "0")).join(""); }
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("rh", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("k");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res) => {
    const q = db.transaction("k").objectStore("k").get(k);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => res(null);
  });
}
async function load() {
  if (LOADED) return;
  try {
    const o = await idbGet("key"); if (o && !OWNER) OWNER = new Uint8Array(o);
    const p = await idbGet("pages"); if (p) for (const k in p) if (!PAGES[k]) PAGES[k] = new Uint8Array(p[k]);
  } catch (err) {}
  LOADED = true;
}
async function hkdf(raw, info) {
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt: enc.encode("rh"), info: enc.encode(info)}, base, 256));
}
async function openSealed(raw, b) {
  const k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: b.subarray(0, 12)}, k, b.subarray(12)));
}
async function sha(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0), b = new Uint8Array(n); let o = 0;
  for (const p of parts) { b.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}
// hub.json (pm · pb) — re-read at most once a minute
let HUB = null, HUB_AT = 0, PM = null, PM_FOR = null;
async function hub() {
  if (!HUB || Date.now() - HUB_AT > 60000) {
    try { HUB = await (await fetch(SCOPE + "hub.json", {cache: "no-cache"})).json(); HUB_AT = Date.now(); PM = null; } catch (err) { HUB = HUB || {}; }
  }
  return HUB;
}
async function epochOf(pdir) {
  const h = await hub();
  if (!PM || PM_FOR !== OWNER) {
    PM = {}; PM_FOR = OWNER;
    try { if (h.pm) PM = JSON.parse(new TextDecoder().decode(await openSealed(await hkdf(OWNER, "meta"), b64d(h.pm)))); } catch (err) {}
  }
  return PM[pdir] || 0;
}
async function pageKey(pdir) {
  if (PAGES[pdir]) return PAGES[pdir];
  if (!OWNER) return null;
  const e = await epochOf(pdir), id = pdir + "#" + e;
  if (!DERIVED.has(id)) DERIVED.set(id, await hkdf(OWNER, "page:" + id));
  return DERIVED.get(id);
}
async function baseOf(raw) {
  const h = await hub();
  if (!h.pb) return SCOPE;
  const id = hex(await sha([raw, enc.encode("base")])).slice(0, 16);
  if (!h.pb[id]) return SCOPE;
  try { return new TextDecoder().decode(await openSealed(raw, b64d(h.pb[id]))); } catch (err) { return SCOPE; }
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if ((d.type === "owner" || d.type === "key") && d.raw) {   // "key" = shells from before v2 (old archives)
    OWNER = new Uint8Array(d.raw); DERIVED.clear(); PM = null;
  } else if (d.type === "page" && d.pdir && d.raw) {
    PAGES[d.pdir] = new Uint8Array(d.raw);
  } else if (d.type === "lock") {
    OWNER = null; PAGES = {}; DERIVED.clear(); PM = null;
  }
  if (e.ports && e.ports[0]) e.ports[0].postMessage({ok: true, v: 2});
});
// The build may re-encode media (jpg → WebP, png → lossless WebP) while keeping the published path,
// so the type comes from the bytes first and the extension second.
function sniff(b) {
  const s = (i, str) => [...str].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 12 && s(0, "RIFF") && s(8, "WEBP")) return "image/webp";
  if (b.length >= 8 && b[0] === 0x89 && s(1, "PNG")) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && s(0, "GIF8")) return "image/gif";
  if (b.length >= 12 && s(4, "ftyp")) return "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return "";
}
function passThrough(path) {
  return path.endsWith("/") || path.endsWith(".html") || path.endsWith(".enc") || path.endsWith("/sw.js") ||
    path.endsWith("/rh-ui.js") || path.endsWith("/robots.txt") || path.endsWith("/hub.json") || path.includes("/_a/");
}
async function serve(req, url) {
  await load();
  let rel = url.pathname.slice(SCOPE.length);
  try { rel = decodeURIComponent(rel); } catch (err) {}
  const m = rel.match(/^p\/[0-9a-f]+/);
  const raw = m && await pageKey(m[0]);
  if (!raw) return fetch(req);
  const name = hex(await sha([raw, enc.encode(rel)])).slice(0, 24);
  const r = await fetch((await baseOf(raw)) + "_a/" + name + ".enc");
  if (!r.ok) return fetch(req);
  const buf = new Uint8Array(await r.arrayBuffer());
  let pt;
  try { pt = await openSealed(raw, buf); } catch (err) { return new Response("decrypt failed", {status: 403}); }
  const ext = (url.pathname.split(".").pop() || "").toLowerCase();
  return ranged(pt, req.headers.get("Range"), sniff(pt.subarray(0, 16)) || MIME[ext] || "application/octet-stream");
}
// A <video> asks with "Range: bytes=…" — Safari (macOS · iOS) plays only when that gets 206 + Content-Range, so a byte range
// of the decrypted body is answered as such; no Range → the whole body (200). Unsatisfiable → 416.
function ranged(pt, range, type) {
  const n = pt.byteLength;
  const base = {"Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store"};
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === "" && m[2] === "")) return new Response(pt, {status: 200, headers: {...base, "Content-Length": String(n)}});
  let a, b;
  if (m[1] === "") { a = Math.max(0, n - parseInt(m[2], 10)); b = n - 1; }          // suffix: last N bytes
  else { a = parseInt(m[1], 10); b = m[2] === "" ? n - 1 : Math.min(parseInt(m[2], 10), n - 1); }
  if (a >= n || a > b) return new Response(null, {status: 416, headers: {...base, "Content-Range": `bytes */${n}`}});
  return new Response(pt.subarray(a, b + 1), {status: 206, headers: {...base, "Content-Length": String(b - a + 1),
    "Content-Range": `bytes ${a}-${b}/${n}`}});
}
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE) || passThrough(url.pathname)) return;
  e.respondWith(serve(e.request, url));
});
