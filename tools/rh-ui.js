/* Research Hub owner UI — share dialog · ⌘K page search · theme · toast. Loaded by the hub (dashboard) and by the page
   bar (nav.js) for the owner only. Public file: no secret lives here; it works from window.__rh.owner (the site key K the
   shell already holds) and a GitHub token the owner pastes once (stored sealed with HKDF(K, "gh") in this browser).

   Share settings = share.enc on the repo's `ctl` branch, sealed with HKDF(K, "share"):
     {v: 1, pages: {"p/<h>": {mode: "private"|"invite"|"link", epoch, invites: [{id, name, code, at}], at}}}
   The build (hub_build.py) reads it: page key K_p = HKDF(K, "page:<pdir>#<epoch>"), invite slots = K_p wrapped by
   PBKDF2(code, "rh-inv:<pdir>:<id>"). Granting is instant (the link / the invite slot travel in the URL fragment);
   revoking raises the epoch, and the next build re-encrypts the page so old links and codes stop opening it. */
(function () {
  "use strict";
  if (window.RHUI) return;
  var enc = new TextEncoder(), dec = new TextDecoder();
  var ITER = 310000;
  var MODK = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  function rh() { return window.__rh || {}; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]; }); }
  function b64d(s) { s = String(s).replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function b64e(u) { var s = ""; for (var i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }
  function b64url(u) { return b64e(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function K() { return rh().owner ? b64d(rh().owner) : null; }
  async function hkdf(raw, info) {
    var base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt: enc.encode("rh"), info: enc.encode(info)}, base, 256));
  }
  async function seal(raw, data) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    var ct = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: iv}, k, data));
    var out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12); return out;
  }
  async function openSealed(raw, b) {
    var k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: b.subarray(0, 12)}, k, b.subarray(12)));
  }
  function normCode(s) { return String(s).toUpperCase().replace(/[^0-9A-Z]/g, ""); }
  function newCode() {
    var A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(12)), s = "";
    for (var i = 0; i < 12; i++) s += A[r[i] % A.length] + (i === 3 || i === 7 ? "-" : "");
    return s;
  }
  function newId() { var r = crypto.getRandomValues(new Uint8Array(6)); return Array.from(r, function (x) { return (x % 36).toString(36); }).join("") + Date.now().toString(36).slice(-2); }
  // uploaded pages (u/…) are keyed from K_u = HKDF(K, "uploads") — the cloud step (GitHub Actions) holds K_u, never K
  var KUc = null;
  async function KU() { var k = K(); if (!KUc || KUc.k !== k) KUc = {k: k, v: await hkdf(k, "uploads")}; return KUc.v; }
  async function pageKey(pdir, epoch) { return await hkdf(/^u\//.test(pdir) ? await KU() : K(), "page:" + pdir + "#" + (epoch || 0)); }
  // the cloud list (u.enc, sealed HKDF(K_u, "list")): boards made in the hub · upload pages · their epochs · refusals
  var cloudP = null;
  function cloud(fresh) {
    if (cloudP && !fresh && Date.now() - cloudP.at < 3e4) return cloudP.p;
    cloudP = {at: Date.now(), p: (async function () {
      try {
        var r = await fetch(new URL("u.enc", rh().root || location.href).href, {cache: "no-cache"});
        if (!r.ok) return null;
        var pt = await openSealed(await hkdf(await KU(), "list"), new Uint8Array(await r.arrayBuffer()));
        return JSON.parse(await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
      } catch (e) { cloudP = null; return null; }
    })()};
    return cloudP.p;
  }
  function pageUrl(pdir) { return new URL(pdir + "/", rh().root || location.href).href; }

  // ---- GitHub (share.enc on the ctl branch) -------------------------------------------------------------------------
  function ghCfg() {
    var t = null; try { t = JSON.parse(localStorage.getItem("rh-gh-test") || "null"); } catch (e) {}   // local test server only
    if (t) return t;
    var owner = location.hostname.split(".")[0], repo = location.pathname.split("/")[1] || "";
    return {api: "https://api.github.com", repo: owner + "/" + repo, raw: "https://raw.githubusercontent.com/" + owner + "/" + repo + "/ctl/share.enc"};
  }
  async function getToken() {
    try { var v = localStorage.getItem("rh-gh"); if (!v) return ""; return dec.decode(await openSealed(await hkdf(K(), "gh"), b64d(v))); } catch (e) { return ""; }
  }
  async function putToken(tok) {
    if (!tok) { try { localStorage.removeItem("rh-gh"); } catch (e) {} return; }
    var b = await seal(await hkdf(K(), "gh"), enc.encode(tok));
    try { localStorage.setItem("rh-gh", b64e(b)); } catch (e) {}
  }
  async function gh(method, path, tok, body) {
    var g = ghCfg();
    var r = await fetch(g.api + path, {method: method, cache: "no-store", headers: Object.assign({"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
      tok ? {"Authorization": "Bearer " + tok} : {}, body ? {"Content-Type": "application/json"} : {}), body: body ? JSON.stringify(body) : undefined});
    var j = null; try { j = await r.json(); } catch (e) {}
    return {status: r.status, ok: r.ok, j: j};
  }
  // What a token can do here, checked once when it is pasted: repo visible → Contents read → Contents write.
  // The write check PUTs with an impossible sha: GitHub answers 409 when the token may write and 403 when it may not;
  // nothing is written either way. The three requests run together (one round trip instead of three).
  // → {why: "" when fine, else what to fix (Korean, shown in the dialog), got: the share.enc read, reused by the dialog}
  async function checkToken(tok) {
    var g = ghCfg();
    try {
      var rs = await Promise.all([gh("GET", "/repos/" + g.repo, tok), gh("GET", "/repos/" + g.repo + "/contents/share.enc?ref=ctl", tok),
        gh("PUT", "/repos/" + g.repo + "/contents/share.enc", tok, {message: "permission check", branch: "ctl", content: btoa("x"), sha: "0000000000000000000000000000000000000000"})]);
      if (rs[0].status === 401) return {why: "토큰이 맞지 않습니다(만료됐거나 잘못 붙여 넣음). 새로 만든 토큰을 붙여 넣어 주세요."};
      if (!rs[0].ok) return {why: "이 토큰으로는 저장소가 보이지 않습니다(" + rs[0].status + "). Repository access 에서 이 저장소를 골랐는지 확인해 주세요."};
      if (rs[1].status === 401 || rs[1].status === 403) return {why: "토큰에 Contents 권한이 없습니다. 토큰 설정의 Repository permissions 에서 ‘+ Add permissions → Contents’ 를 추가하고 Read and write 로 바꿔 주세요."};
      if (rs[2].status === 401 || rs[2].status === 403) return {why: "토큰의 Contents 권한이 읽기 전용입니다. Repository permissions → Contents 를 Read and write 로 바꿔 주세요."};
      return {why: "", got: rs[1]};
    } catch (e) { return {why: "GitHub에 연결하지 못했습니다(" + e.message + "). 잠시 뒤 다시 시도해 주세요."}; }
  }
  async function openState(text) { return JSON.parse(dec.decode(await openSealed(await hkdf(K(), "share"), b64d(text)))); }
  // Last share.enc seen, kept in this browser so the dialog opens at once and refreshes behind. It is the same sealed
  // text the public ctl branch holds (HKDF(K, "share")), so caching it here adds nothing an outsider could read.
  function putCache(text, sha) { try { localStorage.setItem("rh-sc", JSON.stringify({t: text, sha: sha || null})); } catch (e) {} }
  async function cached() {
    try { var c = JSON.parse(localStorage.getItem("rh-sc") || "null"); if (!c || !c.t) return null; return {st: await openState(c.t), sha: c.sha}; } catch (e) { return null; }
  }
  async function fromApi(r) {   // a contents GET of share.enc → {st, sha, ro}
    if (r.status === 401 || r.status === 403) throw new Error("token");
    if (r.status === 404) return {st: {v: 1, pages: {}}, sha: null, ro: false, missing: true};
    if (!r.ok) throw new Error("gh " + r.status);
    var text = atob(r.j.content.replace(/\s/g, "")).trim(), st = await openState(text);
    putCache(text, r.j.sha);
    return {st: st, sha: r.j.sha, ro: false};
  }
  var inflight = {};   // one read per token at a time (the hub's badges and the dialog ask together)
  function loadState(tok) {   // → {st, sha, ro}
    var key = tok ? "t" : "-";
    if (!inflight[key]) inflight[key] = loadState1(tok).finally(function () { delete inflight[key]; });
    return inflight[key];
  }
  async function loadState1(tok) {
    var g = ghCfg();
    if (tok) return fromApi(await gh("GET", "/repos/" + g.repo + "/contents/share.enc?ref=ctl", tok));
    var t = await fetch(g.raw + "?t=" + Date.now(), {cache: "no-store"});
    if (!t.ok) return {st: {v: 1, pages: {}}, sha: null, ro: true};
    var text = (await t.text()).trim(), st = await openState(text);
    putCache(text, null);
    return {st: st, sha: null, ro: true};
  }
  async function saveState(tok, st, sha) {
    var g = ghCfg();
    var text = b64e(await seal(await hkdf(K(), "share"), enc.encode(JSON.stringify(st))));
    var r = await gh("PUT", "/repos/" + g.repo + "/contents/share.enc", tok, {message: "ctl", branch: "ctl", content: btoa(text), sha: sha || undefined});
    if (!sha && (r.status === 404 || r.status === 422) && /branch/i.test((r.j && r.j.message) || "")) throw new Error("noctl");
    if (r.status === 409 || r.status === 422) return {conflict: true};
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("perm");
    if (!r.ok) throw new Error("gh " + r.status);
    var sha2 = r.j && r.j.content && r.j.content.sha;
    putCache(text, sha2);
    return {sha: sha2};
  }
  var liveP = null;
  function liveEpochs() {   // what the published build uses now (hub.json pm, sealed with HKDF(K, "meta")) — once per 60 s
    if (liveP && Date.now() - liveP.at < 6e4) return liveP.p;
    liveP = {at: Date.now(), p: (async function () {
      try {
        var h = await (await fetch(new URL("hub.json", rh().root || location.href).href, {cache: "no-cache"})).json();
        var pm = h.pm ? JSON.parse(dec.decode(await openSealed(await hkdf(K(), "meta"), b64d(h.pm)))) : {};
        var c = await cloud(); return Object.assign(pm, (c && c.epochs) || {});
      } catch (e) { liveP = null; return {}; }
    })()};
    return liveP.p;
  }

  // ---- shadow host + styles -----------------------------------------------------------------------------------------
  var host, root;
  function isDark() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true; if (t === "light") return false;
    return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  var CSS =
    ":host{all:initial}" +
    ".L{--bg:#fff;--bg2:#fafafa;--ink:#09090b;--mut:#71717a;--faint:#a1a1aa;--line:#e4e4e7;--line2:#d4d4d8;--hov:#f4f4f5;--acc:#3e63dd;--ring:rgba(62,99,221,.25);--ok:#16a34a;--warn:#b45309;--warnbg:#fffbeb;--bad:#dc2626;--sh:0 24px 64px -16px rgba(0,0,0,.25),0 2px 6px rgba(0,0,0,.06);--scrim:rgba(9,9,11,.32)}" +
    ".D{--bg:#111113;--bg2:#0c0c0e;--ink:#fafafa;--mut:#a1a1aa;--faint:#71717a;--line:#27272a;--line2:#3f3f46;--hov:#1c1c1f;--acc:#8da4ff;--ring:rgba(141,164,255,.28);--ok:#4ade80;--warn:#fbbf24;--warnbg:#1f1a0b;--bad:#f87171;--sh:0 24px 64px -16px rgba(0,0,0,.7);--scrim:rgba(0,0,0,.55)}" +
    "*{box-sizing:border-box}.L{color-scheme:light}.D{color-scheme:dark}" +
    ".wrap{font:14px/1.5 'Pretendard Variable',Pretendard,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;color:var(--ink);letter-spacing:-.005em;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word}" +
    ".mono{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}" +
    ".ov{position:fixed;inset:0;z-index:2147483600;background:var(--scrim);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;animation:fi .14s ease-out}" +
    "@keyframes fi{from{opacity:0}}@keyframes up{from{opacity:0;transform:translateY(6px) scale(.985)}}" +
    ".dlg{width:min(520px,100%);max-height:80vh;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line2) transparent;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh);animation:up .16s ease-out}" +
    "@media (prefers-reduced-motion:reduce){.ov,.dlg,.dot{animation:none}}" +
    "button,input{font:inherit;color:inherit}" +
    "button{cursor:pointer}" +
    ":focus-visible{outline:2px solid var(--acc);outline-offset:2px}" +
    ".hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 6px}" +
    ".eb{font-size:12px;color:var(--mut);font-weight:500}" +
    "h2{margin:2px 0 0;font-size:17px;font-weight:650;letter-spacing:-.02em;line-height:1.3}" +
    ".x{width:30px;height:30px;border:0;border-radius:8px;background:none;color:var(--mut);display:grid;place-items:center;flex:none}" +
    ".x:hover{background:var(--hov);color:var(--ink)}" +
    ".sec{padding:12px 20px}" +
    ".lbl{font-size:12.5px;font-weight:600;color:var(--mut);margin-bottom:8px;display:flex;align-items:center;gap:6px}" +
    ".lbl .n{font-weight:500;color:var(--faint)}" +
    ".opts{display:grid;gap:6px}" +
    ".opt{display:grid;grid-template-columns:32px 1fr 18px;align-items:center;gap:12px;text-align:left;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);transition:border-color .12s,background .12s}" +
    ".opt:hover{background:var(--hov)}" +
    ".opt[aria-checked=true]{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}" +
    ".opt .ic{width:32px;height:32px;border-radius:8px;background:var(--hov);display:grid;place-items:center;color:var(--ink)}" +
    ".opt[aria-checked=true] .ic{background:var(--ink);color:var(--bg)}" +
    ".opt b{display:block;font-weight:600;font-size:14px}.opt span{display:block;font-size:12.5px;color:var(--mut)}" +
    ".opt .ck{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--line2)}" +
    ".opt[aria-checked=true] .ck{border:5px solid var(--ink)}" +
    ".opt:disabled{cursor:not-allowed;opacity:.55}" +
    ".add{display:flex;gap:8px}" +
    ".in{flex:1;min-width:0;height:36px;padding:0 11px;border:1px solid var(--line2);border-radius:8px;background:var(--bg)}" +
    ".in:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}" +
    ".btn{height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--line2);background:var(--bg);font-weight:600;font-size:13.5px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}" +
    ".btn:hover{background:var(--hov)}" +
    ".btn.pri{background:var(--ink);border-color:var(--ink);color:var(--bg)}.btn.pri:hover{opacity:.88;background:var(--ink)}" +
    ".btn.ghost{border-color:transparent;color:var(--mut)}.btn.ghost:hover{color:var(--ink)}" +
    ".btn:disabled{opacity:.5;cursor:not-allowed}" +
    "ul.ppl{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:2px}" +
    "ul.ppl li{display:grid;grid-template-columns:30px 1fr auto auto;align-items:center;gap:10px;padding:6px 6px;border-radius:8px}" +
    "ul.ppl li:hover{background:var(--hov)}" +
    ".av{width:30px;height:30px;border-radius:50%;background:var(--hov);border:1px solid var(--line);display:grid;place-items:center;font-size:12.5px;font-weight:600}" +
    ".who b{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.who span{font-size:12px;color:var(--mut)}" +
    ".ib{width:30px;height:30px;border:0;border-radius:7px;background:none;color:var(--mut);display:grid;place-items:center}" +
    ".ib:hover{background:var(--line);color:var(--ink)}.ib.del:hover{color:var(--bad)}" +
    ".off ul.ppl{opacity:.5}" +
    ".note{margin:4px 20px 0;padding:10px 12px;border-radius:9px;font-size:12.5px;line-height:1.5;background:var(--bg2);border:1px solid var(--line);color:var(--mut)}" +
    ".note.warn{background:var(--warnbg);border-color:color-mix(in srgb,var(--warn) 30%,transparent);color:var(--ink)}" +
    ".note b{color:var(--ink)}" +
    ".ft{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px 18px;margin-top:8px;border-top:1px solid var(--line)}" +
    ".stt{font-size:12.5px;color:var(--mut);display:flex;align-items:center;gap:7px;min-width:0}" +
    ".dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.run{background:var(--acc);animation:pu 1s ease-in-out infinite}@keyframes pu{50%{opacity:.25}}" +
    ".acts{display:flex;gap:8px;flex:none}" +
    ".ghp{display:grid;gap:10px}.ghp ol{margin:0;padding-left:18px;color:var(--mut);font-size:13px;display:grid;gap:3px}.ghp ol b{color:var(--ink);font-weight:600}" +
    ".ghp a{color:var(--acc)}" +
    ".err{color:var(--bad);font-size:12.5px;min-height:1em}" +
    ".exp{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12.5px;color:var(--mut);flex-wrap:wrap}" +
    ".sel{height:30px;padding:0 8px;border:1px solid var(--line2);border-radius:7px;background:var(--bg);color:var(--ink);font:inherit;font-size:12.5px}" +
    ".sel:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}" +
    ".add .sel{height:36px}" +
    ".dl{font-family:'Geist Mono',ui-monospace,monospace;font-size:11.5px;color:var(--warn)}" +
    ".linkbox{display:flex;gap:8px;align-items:center;padding:6px 6px 6px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg2)}" +
    ".linkbox code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--mut)}" +
    /* upload */
    ".dz{display:grid;justify-items:center;gap:4px;padding:22px 16px;border:1.5px dashed var(--line2);border-radius:12px;background:var(--bg2);text-align:center;cursor:pointer;transition:border-color .12s,background .12s}" +
    ".dz:hover,.dz.on{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 6%,var(--bg))}" +
    ".dz b{font-size:14px;font-weight:600}.dz span{font-size:12.5px;color:var(--mut)}.dz .dzi{width:36px;height:36px;border-radius:10px;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;color:var(--ink);margin-bottom:4px}" +
    "ul.fl{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}" +
    "ul.fl li{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px;padding:8px 8px 8px 10px;border:1px solid var(--line);border-radius:10px}" +
    "ul.fl li>span{display:block;min-width:0}ul.fl .in{height:32px;width:100%}ul.fl small{display:block;margin-top:4px;font-size:11.5px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "ul.fl li.ok{border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}ul.fl li.ok b{font-size:13.5px;font-weight:600}" +
    ".g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.g2 .sel,.w{width:100%;height:36px}" +
    "@media (max-width:480px){.g2{grid-template-columns:1fr}}" +
    ".rn{margin-bottom:10px}.rn .rl{font-size:12.5px;color:var(--mut);margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rn .rl .n{color:var(--faint)}" +
    "ul.sl li{grid-template-columns:22px 1fr auto;padding:6px 6px 6px 10px}ul.sl .no{font-size:11.5px;color:var(--faint)}ul.sl .in{height:32px}" +
    "ul.sl li.fx{background:var(--bg2)}ul.sl li.fx .t{font-size:13.5px;font-weight:500;color:var(--mut);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "ul.sl .tg{font-size:11.5px;color:var(--faint);padding-right:6px;white-space:nowrap}ul.sl .mv{display:flex;gap:2px}.ib:disabled{opacity:.35;cursor:not-allowed}.ib:disabled:hover{background:none;color:var(--mut)}" +
    ".btn.dang{color:var(--bad)}.btn.dang:hover{background:color-mix(in srgb,var(--bad) 10%,transparent);color:var(--bad)}" +
    /* palette */
    ".pal{width:min(600px,100%);background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh);overflow:hidden;animation:up .14s ease-out}" +
    ".pq{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line)}" +
    ".pq svg{color:var(--faint);flex:none}" +
    ".pq input{flex:1;height:52px;border:0;background:none;font-size:15.5px;outline:none}" +
    ".kbd{font:11px 'Geist Mono',ui-monospace,monospace;color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:1px 6px;background:var(--bg2)}" +
    ".pl{max-height:min(420px,60vh);overflow:auto;padding:6px}" +
    ".pg{font-size:11.5px;font-weight:600;color:var(--faint);padding:8px 10px 4px}" +
    ".pi{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;color:var(--ink);text-decoration:none}" +
    ".pi[aria-selected=true]{background:var(--hov)}" +
    ".pi .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}" +
    ".pi .m{font-size:12px;color:var(--mut);white-space:nowrap}" +
    ".pi .gi{width:26px;height:26px;border-radius:7px;border:1px solid var(--line);display:grid;place-items:center;color:var(--mut);flex:none}" +
    ".pe{padding:28px;text-align:center;color:var(--mut);font-size:13px}" +
    ".pf{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--mut);background:var(--bg2)}" +
    ".toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483646;background:var(--ink);color:var(--bg);padding:9px 14px;border-radius:9px;font-size:13px;font-weight:500;box-shadow:var(--sh);animation:up .16s ease-out;max-width:calc(100vw - 32px)}";
  function ensureHost() {
    if (host && host.isConnected) { root.querySelector(".wrap").className = "wrap " + (isDark() ? "D" : "L"); return; }
    host = document.createElement("div"); host.id = "rh-ui";
    host.style.cssText = "position:static;display:block;margin:0;padding:0;border:0;width:0;height:0";
    document.body.appendChild(host);
    root = host.attachShadow({mode: "open"});
    root.innerHTML = "<style>" + CSS + "</style><div class='wrap " + (isDark() ? "D" : "L") + "'></div>";
  }
  function wrap() { ensureHost(); return root.querySelector(".wrap"); }
  var IC = {
    lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    users: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6"/><path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    upar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
    dnar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    page: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></svg>'
  };
  function toast(msg) {
    var w = wrap(), t = document.createElement("div"); t.className = "toast"; t.textContent = msg; w.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  async function copy(text) {
    window.RHUI._last = text;   // (read back by the local end-to-end test)
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e2) {} ta.remove(); return ok;
    }
  }
  var lastFocus = null;
  function modal(html, cls) {
    close();
    lastFocus = document.activeElement;
    var w = wrap(), ov = document.createElement("div"); ov.className = "ov"; ov.innerHTML = '<div class="' + cls + '" role="dialog" aria-modal="true">' + html + "</div>";
    ov.addEventListener("mousedown", function (e) { if (e.target === ov) close(); });
    ov.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Tab") {   // keep focus inside the dialog
        var f = Array.prototype.filter.call(ov.querySelectorAll("button,input,a[href]"), function (x) { return !x.disabled && x.offsetParent !== null; });
        if (!f.length) return;
        var a = root.activeElement;
        if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    ov.addEventListener("wheel", function (e) { if (!e.target.closest(".dlg,.pl")) e.preventDefault(); }, {passive: false});
    w.appendChild(ov);
    return ov;
  }
  function close() {
    if (!root) return;
    var ov = root.querySelector(".ov"); if (!ov) return;
    ov.remove();
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }

  function ghPanel(why) {
    var g = ghCfg();
    return '<div class="sec"><div class="note" style="margin:0"><div class="ghp"><div><b>GitHub 연결</b> · ' + why + ' 이 저장소에만 쓸 수 있는 토큰이 한 번 필요합니다. 토큰은 허브 키로 암호화해 이 브라우저에만 둡니다.</div>' +
      '<ol><li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Fine-grained 토큰 만들기 ↗</a></li><li>Repository access → <b>Only select repositories</b> → <b class="mono">' + esc(g.repo.split("/")[1] || g.repo) + "</b></li><li>Repository permissions → <b>+ Add permissions → Contents</b> → <b>Read and write</b></li><li>맨 아래 Generate token → 나온 값을 아래에 붙여 넣기</li></ol>" +
      '<form class="add" data-a="tok"><input class="in mono" name="tok" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"><button class="btn pri">연결</button></form></div></div></div>';
  }

  // ---- share dialog -------------------------------------------------------------------------------------------------
  var LEVEL = {"private": 0, "invite": 1, "link": 2};
  function fmtWhen(iso) { var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); }; return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes()); }
  function left(iso) {   // "3일 남음" · "5시간 남음" · "만료됨"
    if (!iso) return ""; var ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "만료 처리 대기"; if (ms < 864e5) return Math.max(1, Math.round(ms / 36e5)) + "시간 남음"; return Math.round(ms / 864e5) + "일 남음";
  }
  function inDays(n) { return new Date(Date.now() + n * 864e5).toISOString(); }
  var EXPS = [["", "기한 없음"], ["1", "1일"], ["7", "7일"], ["30", "30일"], ["90", "90일"]];
  async function share(pg) {   // pg = {pdir, title}
    if (!K()) return toast("소유자로 연 페이지에서만 공유를 바꿀 수 있습니다");
    // busy = "" | "check" (token) | "save"; fresh = the state came from GitHub just now (else: this browser's last copy)
    var S = {tok: await getToken(), st: null, sha: null, ro: true, live: {}, busy: "", err: "", ghOpen: false, loaded: false, fresh: false, pend: null};
    var c0 = await cached();
    if (c0) { S.st = c0.st; S.sha = c0.sha; S.ro = !S.tok; S.loaded = true; }
    var ov = modal('<div class="hd"><div><div class="eb">공유</div><h2></h2></div><button class="x" data-a="close" aria-label="닫기">' + IC.x + '</button></div><div class="body"></div>', "dlg");
    ov.querySelector("h2").textContent = pg.title || "이 페이지";
    var body = ov.querySelector(".body");
    function ent() { var p = S.st && S.st.pages[pg.pdir]; return p || {mode: "private", epoch: 0, invites: []}; }
    function pending() { return (ent().epoch || 0) > (S.live[pg.pdir] || 0); }
    async function linkFor(e) { return pageUrl(pg.pdir) + "#k=" + b64url(await pageKey(pg.pdir, e)); }
    async function inviteText(inv) {
      var e = ent().epoch || 0, kp = await pageKey(pg.pdir, e);
      var b = await crypto.subtle.importKey("raw", enc.encode(normCode(inv.code)), "PBKDF2", false, ["deriveBits"]);
      var kek = new Uint8Array(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: enc.encode("rh-inv:" + pg.pdir + ":" + inv.id), iterations: ITER}, b, 256));
      var url = pageUrl(pg.pdir) + "#i=" + inv.id + "." + b64url(await seal(kek, kp));
      return {url: url, code: inv.code, text: (pg.title || "Research Hub") + "\n링크: " + url + "\n접속 코드: " + inv.code + "\n(코드는 링크와 다른 경로로 전달하는 것이 안전합니다)"};
    }
    function draw() {
      var e = ent(), m = e.mode || "private", ro = S.ro || !S.tok, n = (e.invites || []).length;
      var opt = function (k, ic, t, d) { return '<button class="opt" role="radio" data-m="' + k + '" aria-checked="' + (m === k) + '"' + (ro || S.busy ? " disabled" : "") + '><span class="ic">' + ic + '</span><span><b>' + t + "</b><span>" + d + '</span></span><span class="ck"></span></button>'; };
      var h = '<div class="sec"><div class="lbl">접근 권한</div><div class="opts" role="radiogroup" aria-label="접근 권한">' +
        opt("private", IC.lock, "나만", "허브 비밀번호를 가진 나만 볼 수 있습니다") +
        opt("invite", IC.users, "초대한 사람만", "내가 건넨 접속 코드를 넣은 사람만 볼 수 있습니다") +
        opt("link", IC.globe, "링크가 있는 모든 사람", "링크를 아는 누구나 볼 수 있습니다 · 로그인 없음") + "</div></div>";
      h += '<div class="sec" style="padding-top:0"><div class="eb">' + (ro ? (S.loaded ? "공유 범위를 바꾸려면 먼저 아래에서 GitHub를 연결하세요(한 번만)." : "") : {
        "private": "공유하려면 ‘초대한 사람만’이나 ‘링크가 있는 모든 사람’을 고르세요. 고르는 즉시 저장됩니다.",
        invite: "아래에 이름을 적고 ‘초대’를 누르면 그 사람 전용 링크와 접속 코드가 복사됩니다. 그대로 보내면 됩니다.",
        link: "아래 링크를 복사해 보내면 됩니다. 받는 사람은 비밀번호 없이 이 페이지만 볼 수 있습니다."}[m]) + "</div></div>";
      if (m === "link") {
        h += '<div class="sec"><div class="lbl">공유 링크</div><div class="linkbox"><code class="mono" data-link>만드는 중…</code><button class="btn pri" data-a="copylink">' + IC.copy + "복사</button></div>" +
          '<div class="exp"><span>기한</span><select class="sel" data-a="linkexp" aria-label="링크 기한"' + (ro || S.busy ? " disabled" : "") + ">" +
          (e.link_exp ? '<option value="keep" selected>' + esc(fmtWhen(e.link_exp)) + "까지</option>" : "") +
          EXPS.map(function (x) { return '<option value="' + x[0] + '"' + (!e.link_exp && !x[0] ? " selected" : "") + ">" + x[1] + "</option>"; }).join("") +
          "</select>" + (e.link_exp ? '<span class="dl">' + esc(left(e.link_exp)) + "</span><span>· 지나면 다음 빌드에서 링크가 막힙니다</span>" : "") + "</div></div>";
      }
      h += '<div class="sec ' + (m === "private" ? "off" : "") + '"><div class="lbl">초대한 사람 <span class="n">' + n + "</span></div>" +
        '<form class="add" data-a="add"><input class="in" name="nm" maxlength="40" placeholder="이름 (예: 지도교수님, 공동저자 A)" ' + (ro || S.busy ? "disabled" : "") + ' autocomplete="off">' +
        '<select class="sel" name="days" aria-label="초대 기한"' + (ro || S.busy ? " disabled" : "") + ">" + EXPS.map(function (x) { return '<option value="' + x[0] + '">' + x[1] + "</option>"; }).join("") + "</select>" +
        '<button class="btn" ' + (ro || S.busy ? "disabled" : "") + ">초대</button></form>" +
        '<ul class="ppl">' + (e.invites || []).map(function (inv) {
          return '<li><span class="av">' + esc((inv.name || "?").slice(0, 1)) + '</span><span class="who"><b>' + esc(inv.name) + '</b><span class="mono">' + esc(inv.code) + "</span>" +
            (inv.exp ? ' <span class="dl" title="' + esc(fmtWhen(inv.exp)) + '까지">· ' + esc(left(inv.exp)) + "</span>" : "") + "</span>" +
            '<button class="ib" data-a="copyinv" data-id="' + esc(inv.id) + '" title="링크 + 코드 복사" aria-label="' + esc(inv.name) + ' 링크와 코드 복사">' + IC.copy + "</button>" +
            '<button class="ib del" data-a="del" data-id="' + esc(inv.id) + '" title="초대 취소" aria-label="' + esc(inv.name) + ' 초대 취소"' + (ro || S.busy ? " disabled" : "") + ">" + IC.trash + "</button></li>";
        }).join("") + "</ul>" +
        (m === "private" && n ? '<div class="eb" style="margin-top:6px">‘나만’ 상태에서는 초대가 멈춥니다. 다시 ‘초대한 사람만’으로 바꾸면 같은 코드로 열립니다.</div>' : "") +
        ((e.expired || []).length ? '<div class="eb" style="margin-top:6px">기한이 지나 빠진 초대: ' + e.expired.slice(-5).map(function (x) { return esc(x.name) + "(" + esc(fmtWhen(x.at)) + ")"; }).join(", ") + "</div>" : "") +
        (e.link_expired_at && m !== "link" ? '<div class="eb" style="margin-top:6px">공유 링크가 ' + esc(fmtWhen(e.link_expired_at)) + "에 기한이 지나 닫혔습니다.</div>" : "") + "</div>";
      if (S.loaded && pending()) {
        h += '<div class="note warn"><b>회수 적용 대기</b> · ' + (/^u\//.test(pg.pdir) ? "1~2분 안에" : "다음 빌드(약 30분 이내)에서") + ' 이 페이지를 새 키로 다시 암호화합니다. 그때까지는 예전 링크·코드도 열립니다' + (m === "link" ? ", 새 링크는 그 뒤에 열립니다" : "") + ".</div>";
      }
      if (!S.tok || S.ghOpen) h += ghPanel("공유 설정을 저장하려면");
      h += '<div class="sec"><div class="err" data-err>' + esc(S.err) + "</div></div>";
      var st = S.busy === "check" ? ["run", "토큰 권한 확인 중…"] : S.busy ? ["run", "저장 중…"] : !S.loaded ? ["run", "불러오는 중…"]
        : !S.tok ? ["bad", "GitHub 연결 안 됨 · 보기만 가능"] : !S.fresh ? ["run", "최신 설정 확인 중… · 바로 바꿔도 됩니다"] : ["ok", "변경하면 바로 저장됩니다"];
      h += '<div class="ft"><span class="stt"><span class="dot ' + st[0] + '"></span><span>' + st[1] + "</span></span><span class=\"acts\">" +
        (S.tok && !S.ghOpen ? '<button class="btn ghost" data-a="gh">토큰</button>' : "") +
        (m === "link" && S.tok ? '<button class="btn ghost" data-a="reset" ' + (S.busy ? "disabled" : "") + ">링크 재설정</button>" : "") +
        '<button class="btn" data-a="close">완료</button></span></div>';
      // a redraw (background refresh, save done) must not eat what is being typed
      var keep = {}, fo = root.activeElement, foName = fo && body.contains(fo) && fo.name;
      body.querySelectorAll("input[name],select[name]").forEach(function (x) { keep[x.name] = x.value; });
      body.innerHTML = h;
      body.querySelectorAll("input[name],select[name]").forEach(function (x) { if (keep[x.name] != null) x.value = keep[x.name]; });
      if (foName) { var nf = body.querySelector('[name="' + foName + '"]'); if (nf && !nf.disabled) nf.focus(); }
      var lk = body.querySelector("[data-link]");
      if (lk) linkFor(e.epoch || 0).then(function (u) { lk.textContent = u; });
    }
    function apply(r) { S.st = r.st; S.sha = r.sha; S.ro = r.ro; S.fresh = true; }
    function refresh() {   // GitHub (or the public copy) + the live build's epochs, together
      if (S.pend) return S.pend;
      S.pend = (async function () {
        var rs = await Promise.all([loadState(S.tok).then(function (r) { return {r: r}; }, function (e) { return {e: e}; }), liveEpochs()]);
        S.live = rs[1];
        if (rs[0].r) { apply(rs[0].r); if (!S.busy) S.err = ""; }
        else {
          var err = rs[0].e; S.st = S.st || {v: 1, pages: {}}; S.ro = true; S.fresh = true;
          if (err.message === "token") {   // stored token no longer allowed (expired / permissions changed) → ask for a new one
            S.err = "저장된 토큰으로 공유 설정을 읽지 못했습니다(만료됐거나 Contents 권한이 없음). 새 토큰을 붙여 넣어 주세요.";
            S.tok = ""; S.ghOpen = true; await putToken("");
          } else S.err = "공유 설정을 읽지 못했습니다(" + err.message + ").";
        }
        S.loaded = true;
      })().finally(function () { S.pend = null; if (!S.busy) draw(); });
      return S.pend;
    }
    async function mutate(fn, okMsg) {
      if (!S.tok) { S.err = "먼저 GitHub를 연결해 주세요."; return draw(); }
      S.busy = "save"; S.err = "";
      if (S.pend) { draw(); await S.pend; if (!S.tok) { S.busy = ""; return draw(); } }   // build on the freshest copy
      var before = JSON.stringify(S.st);
      try {
        for (var i = 0; i < 3; i++) {
          var p = S.st.pages[pg.pdir] = S.st.pages[pg.pdir] || {mode: "private", epoch: 0, invites: []};
          p.invites = p.invites || [];
          var out = fn(p); p.at = new Date().toISOString();
          draw();   // show the change at once; GitHub confirms behind ("저장 중…")
          var r = await saveState(S.tok, S.st, S.sha);
          if (!r.conflict) {
            S.sha = r.sha || S.sha; if (okMsg) toast(typeof okMsg === "function" ? okMsg(out) : okMsg);
            var e0 = ((JSON.parse(before).pages || {})[pg.pdir] || {}).epoch || 0;
            if (/^u\//.test(pg.pdir) && (p.epoch || 0) > e0) sendInbox(S.tok, {op: "epoch", pdir: pg.pdir, epoch: p.epoch || 0}).catch(function () {});
            window.dispatchEvent(new CustomEvent("rh-share", {detail: {pdir: pg.pdir, mode: p.mode || "private", n: p.invites.length}}));
            return out;
          }
          apply(await loadState(S.tok)); before = JSON.stringify(S.st);   // someone else saved first → re-apply on top
        }
        throw new Error("저장이 계속 충돌합니다");
      } catch (err) {
        S.st = JSON.parse(before);   // undo the shown change
        if (err.message === "perm") S.ghOpen = true;   // read-only token: reopen the GitHub panel right here
        S.err = err.message === "perm" ? "저장 권한이 없습니다. 토큰의 Contents 권한을 Read and write 로 바꾼 새 토큰을 아래에 붙여 넣어 주세요."
          : err.message === "noctl" ? "공유 설정 브랜치(ctl)가 아직 없습니다. 다음 빌드 뒤에 다시 시도해 주세요." : "저장하지 못했습니다(" + err.message + ").";
        S.busy = ""; await refresh();
      } finally { S.busy = ""; draw(); }
    }
    ov.addEventListener("click", async function (ev) {   // the whole dialog: the header ✕ sits outside .body
      var b = ev.target.closest("button"); if (!b || b.disabled) return;
      var a = b.getAttribute("data-a"), m = b.getAttribute("data-m");
      if (m) {
        var cur = ent().mode || "private"; if (m === cur) return;
        await mutate(function (p) {
          // narrowing access revokes: new epoch → the next build re-encrypts, old links / stored keys stop opening it
          var had = cur === "link" || (cur === "invite" && p.invites.length);
          if (LEVEL[m] < LEVEL[cur] && had) p.epoch = (p.epoch || 0) + 1;
          p.mode = m;
        }, {"private": "나만 보기로 바꿨습니다", invite: "초대한 사람만 볼 수 있습니다", link: "링크가 있는 모든 사람이 볼 수 있습니다"}[m]);
      } else if (a === "close") close();
      else if (a === "copylink") { if (await copy(await linkFor(ent().epoch || 0))) toast("링크를 복사했습니다"); }
      else if (a === "reset") {
        if (!confirmInline(b, "지금 링크를 끊을까요?")) return;
        await mutate(function (p) { p.epoch = (p.epoch || 0) + 1; }, "새 링크를 만들었습니다 · 다음 빌드 뒤 열립니다");
      } else if (a === "copyinv") {
        var inv = (ent().invites || []).filter(function (x) { return x.id === b.getAttribute("data-id"); })[0];
        if (inv) { var t = await inviteText(inv); if (await copy(t.text)) toast(inv.name + " 님의 링크와 코드를 복사했습니다"); }
      } else if (a === "del") {
        var id = b.getAttribute("data-id");
        if (!confirmInline(b, "취소")) return;
        await mutate(function (p) {
          p.invites = p.invites.filter(function (x) { return x.id !== id; });
          if (p.mode === "invite") p.epoch = (p.epoch || 0) + 1;   // in link mode the link still opens the page anyway
        }, "초대를 취소했습니다");
      } else if (a === "gh") { S.ghOpen = true; draw(); }
    });
    // two-step confirm without window.confirm (a dialog would block the page)
    function confirmInline(btn, label) {
      if (btn.getAttribute("data-armed") === "1") return true;
      btn.setAttribute("data-armed", "1"); var old = btn.innerHTML; btn.innerHTML = '<span style="font-size:12px;font-weight:600;color:var(--bad);padding:0 4px">' + esc(label) + "</span>";
      btn.style.width = "auto"; setTimeout(function () { if (btn.isConnected) { btn.removeAttribute("data-armed"); btn.innerHTML = old; btn.style.width = ""; } }, 2500);
      return false;
    }
    body.addEventListener("change", async function (ev) {
      var t = ev.target; if (t.getAttribute("data-a") !== "linkexp" || t.value === "keep") return;
      var days = +t.value || 0;
      await mutate(function (p) { if (days) p.link_exp = inDays(days); else delete p.link_exp; },
        days ? "링크 기한: " + days + "일" : "링크 기한을 없앴습니다");
    });
    body.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target, a = f.getAttribute("data-a");
      if (a === "add") {
        var nm = f.nm.value.trim(); if (!nm) return f.nm.focus();
        var days = +f.days.value || 0;
        var inv = await mutate(function (p) {
          var it = {id: newId(), name: nm, code: newCode(), at: new Date().toISOString()};
          if (days) it.exp = inDays(days);
          p.invites.push(it);
          if ((p.mode || "private") === "private") p.mode = "invite";
          return it;
        });
        if (inv) { var t = await inviteText(inv); var ok = await copy(t.text); toast(ok ? nm + " 님의 링크와 코드를 복사했습니다" : "초대를 만들었습니다"); }
      } else if (a === "tok") {
        var tok = f.tok.value.trim(); if (!tok) return f.tok.focus();
        S.busy = "check"; S.err = ""; draw();
        var ck = await checkToken(tok), got = null;
        if (!ck.why) try { got = await fromApi(ck.got); } catch (e) { ck.why = "공유 설정을 읽지 못했습니다(" + e.message + ")."; }
        S.busy = "";
        if (ck.why) { S.err = ck.why; S.ghOpen = true; return draw(); }
        await putToken(tok); S.tok = tok; S.ghOpen = false; apply(got); S.live = await liveEpochs(); S.loaded = true;
        f.tok.value = ""; draw(); toast("GitHub에 연결했습니다 · 읽기·쓰기 권한 확인됨");
      }
    });
    draw(); refresh();
  }

  // ---- uploads: an HTML file (often someone else's) → ctl inbox/<id>.enc, sealed with HKDF(K, "inbox") ----------------
  // The next build saves it in the project's folder on the build machine, lists it (hub_uploads.tsv) and publishes it as a
  // page shown in a sandboxed frame. Unlisting / a new version travel the same way (op del / add with the page's slug).
  var UP_MAX = 30 * 1024 * 1024;   // 10-15: a 31 MB API request (23 MB sealed) verified on the real repo
  async function gz(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()); }
  function upId() { var r = crypto.getRandomValues(new Uint8Array(10)); return Array.from(r, function (x) { return (x % 36).toString(36); }).join("") + Date.now().toString(36).slice(-4); }
  async function getPending() { try { var v = localStorage.getItem("rh-up"); return v ? JSON.parse(dec.decode(await openSealed(await hkdf(K(), "inbox"), b64d(v)))) : []; } catch (e) { return []; } }
  async function setPending(l) { try { localStorage.setItem("rh-up", b64e(await seal(await hkdf(K(), "inbox"), enc.encode(JSON.stringify(l))))); } catch (e) {} }
  async function sendInbox(tok, msg) {   // msg = {op: add|del, project, category, title, name?, slug?, html?} · {op: board, project, title, stages, new?, del?}
    var id = upId(), now = new Date().toISOString();
    var sealed = await seal(await hkdf(await KU(), "inbox"), await gz(enc.encode(JSON.stringify(Object.assign({v: 1, id: id, at: now}, msg)))));
    var r = await gh("PUT", "/repos/" + ghCfg().repo + "/contents/inbox/" + id + ".enc", tok, {message: "inbox", branch: "ctl", content: b64e(sealed)});
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("perm");
    if (r.status === 413) throw new Error("big");
    if (!r.ok) throw new Error("gh " + r.status + (r.j && r.j.message ? " " + r.j.message : ""));
    var l = await getPending();
    l.push({id: id, op: msg.op, project: msg.project, category: msg.category, title: msg.title, slug: msg.slug || "", at: now, sha: (r.j && r.j.content && r.j.content.sha) || "",
            stages: msg.stages, del: !!msg.del, new: !!msg.new, set: msg.set});
    await setPending(l);
    window.dispatchEvent(new CustomEvent("rh-inbox"));
    wake(tok);
    return id;
  }
  // wake the cloud step (GitHub Actions · repository_dispatch) — a miss is caught by its 10-minute schedule
  var wokeAt = 0, wakeWarned = false;
  async function wake(tok) {
    wokeAt = Date.now();
    var st = 0;
    try { st = (await gh("POST", "/repos/" + ghCfg().repo + "/dispatches", tok, {event_type: "inbox"})).status; } catch (e) {}
    if (st !== 204 && !wakeWarned) {   // the upload is saved either way — the 10-minute schedule picks it up
      wakeWarned = true;
      toast("저장됐습니다 · 바로 반영 요청이 " + (st === 403 || st === 404 ? "거절돼(토큰 권한)" : "닿지 않아") + " 10분 안에 자동으로 반영됩니다");
    }
    return st === 204;
  }
  // what still waits for a build: this browser's uploads whose inbox file is still on ctl → {items, other, gone}
  async function pendingUploads() {
    var l = await getPending(), names = null;
    if (!l.length && !(await getToken())) return {items: [], other: 0, gone: []};
    try {
      var r = await gh("GET", "/repos/" + ghCfg().repo + "/contents/inbox?ref=ctl", await getToken());
      if (r.status === 404) names = []; else if (r.ok && Array.isArray(r.j)) names = r.j.map(function (x) { return String(x.name).replace(/\.enc$/, ""); });
    } catch (e) {}
    var c = l.length ? await cloud(true) : null, handled = {};   // the deployed list knows what is live before the API listing does
    ((c && c.done) || []).forEach(function (d) { handled[d] = 1; });
    var keep = l.filter(function (x) { return !handled[x.id] && (names ? names.indexOf(x.id) >= 0 : Date.now() - new Date(x.at).getTime() < 3 * 36e5); });
    if (keep.some(function (x) { return Date.now() - new Date(x.at).getTime() > 18e4; }) && Date.now() - wokeAt > 12e4) wake(await getToken());
    var gone = l.filter(function (x) { return keep.indexOf(x) < 0; });
    if (gone.length) await setPending(keep);
    var mine = {}; keep.forEach(function (x) { mine[x.id] = 1; });
    return {items: keep, other: names ? names.filter(function (n) { return !mine[n]; }).length : 0, gone: gone};
  }
  async function cancelUpload(id) {
    var l = await getPending(), x = l.filter(function (y) { return y.id === id; })[0], tok = await getToken();
    if (!x || !tok) return false;
    var r = await gh("DELETE", "/repos/" + ghCfg().repo + "/contents/inbox/" + id + ".enc", tok, {message: "inbox", branch: "ctl", sha: x.sha});
    if (!r.ok && r.status !== 404) return false;
    await setPending(l.filter(function (y) { return y.id !== id; }));
    window.dispatchEvent(new CustomEvent("rh-inbox"));
    return true;
  }
  function errText(err) {
    return err.message === "perm" ? "GitHub 토큰에 이 저장소의 Contents 쓰기 권한이 없습니다. 아래에서 Read and write 토큰을 다시 연결해 주세요."
      : err.message === "big" ? "파일이 너무 큽니다(GitHub가 거절)." : "올리지 못했습니다(" + err.message + "). 잠시 뒤 다시 시도해 주세요.";
  }
  async function unlist(it) {   // it = {project, category, slug, title}
    var tok = await getToken();
    if (!tok) { toast("먼저 공유나 올리기 창에서 GitHub를 연결해 주세요"); return false; }
    try { await sendInbox(tok, {op: "del", project: it.project, category: it.category, slug: it.slug, title: it.title}); toast("1~2분 안에 허브 목록에서 내립니다 · 원본 파일은 남습니다"); return true; }
    catch (e) { toast(errText(e)); return false; }
  }
  function fmtBytes(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB"; }
  // o = {projects: [{id, name}], stagesBy: {project: [{key, label}]}, project, category, files, replace: {project, category, slug, title}}
  async function upload(o) {
    if (!K()) return toast("소유자로 연 허브에서만 올릴 수 있습니다");
    var S = {tok: await getToken(), files: [], busy: "", err: "", done: [], ghOpen: false,
             project: (o.replace && o.replace.project) || o.project || ((o.projects || [])[0] || {}).id || "",
             category: (o.replace && o.replace.category) || o.category || ""};
    function secs() { return (o.stagesBy || {})[S.project] || []; }
    function pickCat() {   // keep the section if this board has it — else shared, else the first
      var l = secs();
      if (!l.some(function (s) { return s.key === S.category; })) S.category = l.some(function (s) { return s.key === "shared"; }) ? "shared" : (l[0] || {}).key || "";
    }
    if (!o.replace) pickCat();
    var ov = modal('<div class="hd"><div><div class="eb">' + (o.replace ? "새 버전" : "올리기") + '</div><h2></h2></div><button class="x" data-a="close" aria-label="닫기">' + IC.x + '</button></div><div class="body"></div>', "dlg");
    ov.querySelector("h2").textContent = o.replace ? o.replace.title : "HTML 올리기";
    var body = ov.querySelector(".body");
    async function addFiles(list) {
      S.err = "";
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!/\.html?$/i.test(f.name) && f.type !== "text/html") { S.err = f.name + " — HTML 파일(.html)만 올릴 수 있습니다."; continue; }
        if (f.size > UP_MAX) { S.err = f.name + " — 파일당 30 MB까지 올릴 수 있습니다."; continue; }
        var text = await f.text();
        var x = {name: f.name, size: f.size, text: text, title: o.replace ? o.replace.title : f.name};   // the card shows the file's own name (10-16)
        if (o.replace) S.files = [x]; else S.files.push(x);
      }
      draw();
    }
    function draw() {
      var n = S.files.length, fin = S.done.length && !n, ro = !!S.busy;
      var h = "";
      if (fin) {
        h += '<div class="sec"><div class="lbl">올렸습니다 · 게시 대기</div><ul class="fl">' + S.done.map(function (d) {
          return '<li class="ok"><span><b>' + esc(d.title) + "</b><small>" + esc(d.where) + "</small></span><span></span></li>"; }).join("") + "</ul></div>" +
          '<div class="note">1~2분 안에 허브에 올라갑니다(GitHub가 처리 — 이 PC·Claude와 무관). 원본은 GitHub에 암호화해 두고, 연구 PC가 켜지면 판 폴더에도 같은 이름으로 받아 둡니다. 그때까지 판 화면에 ‘게시 대기’로 보입니다.</div>';
      } else {
        h += (S.done.length ? '<div class="sec" style="padding-bottom:0"><div class="eb">이미 올라감: ' + S.done.map(function (d) { return esc(d.title); }).join(", ") + "</div></div>" : "") +
          '<div class="sec"><label class="dz" data-dz tabindex="0"><input type="file" accept=".html,.htm,text/html"' + (o.replace ? "" : " multiple") + ' hidden>' +
          '<span class="dzi">' + IC.up + "</span><b>" + (o.replace ? "새 버전 HTML을 끌어다 놓거나 눌러서 고르세요" : "HTML 파일을 끌어다 놓거나 눌러서 고르세요") + "</b>" +
          "<span>그림·스크립트가 한 파일에 들어 있는 HTML · 파일당 30 MB까지</span></label>" +
          (n ? '<ul class="fl">' + S.files.map(function (f, i) {
            return '<li><span><input class="in" data-t="' + i + '" value="' + esc(f.title) + '" aria-label="제목" maxlength="120"' + (ro || o.replace ? " disabled" : "") + "><small class=\"mono\">" + esc(f.name) + " · " + fmtBytes(f.size) + "</small></span>" +
              '<button class="ib del" data-a="rm" data-i="' + i + '" aria-label="빼기"' + (ro ? " disabled" : "") + ">" + IC.x + "</button></li>"; }).join("") + "</ul>" : "") + "</div>";
        if (!o.replace) {
          var sl = secs();
          h += '<div class="sec g2"><label><div class="lbl">판</div><select class="sel" name="proj"' + (ro ? " disabled" : "") + ">" + (o.projects || []).map(function (p) {
              return '<option value="' + esc(p.id) + '"' + (p.id === S.project ? " selected" : "") + ">" + esc(p.name) + "</option>"; }).join("") + "</select></label>" +
            '<label><div class="lbl">섹션</div><select class="sel" name="cat"' + (ro || !sl.length ? " disabled" : "") + ">" + (sl.length ? sl.map(function (s) {
              return '<option value="' + esc(s.key) + '"' + (s.key === S.category ? " selected" : "") + ">" + esc(s.label) + "</option>"; }).join("") : "<option>섹션 없음</option>") + "</select></label></div>" +
            (sl.length ? "" : '<div class="note warn">이 판에는 섹션이 없습니다. 판 화면의 ‘판 편집’에서 섹션을 먼저 만드세요.</div>');
        }
        h += '<div class="note">다른 사람이 만든 HTML도 <b>격리된 창</b>에서 열립니다. 그 안의 스크립트는 허브의 키·다른 페이지·이 브라우저 저장소에 닿지 못합니다. 같은 폴더의 다른 파일(그림 등)을 따로 부르는 HTML은 그 부분이 안 보일 수 있습니다.</div>';
        if (!S.tok || S.ghOpen) h += ghPanel("올리려면");
      }
      h += '<div class="sec"><div class="err" data-err>' + esc(S.err) + "</div></div>";
      var st = S.busy === "check" ? ["run", "토큰 권한 확인 중…"] : S.busy ? ["run", S.busy] : fin ? ["ok", S.done.length + "개 게시 대기"]
        : !S.tok ? ["bad", "GitHub 연결 필요"] : n ? ["", n + "개 · " + fmtBytes(S.files.reduce(function (a, f) { return a + f.size; }, 0))] : ["", "파일을 고르세요"];
      h += '<div class="ft"><span class="stt"><span class="dot ' + st[0] + '"></span><span>' + esc(st[1]) + '</span></span><span class="acts">' +
        (fin ? '<button class="btn pri" data-a="close">완료</button>' : '<button class="btn" data-a="close">취소</button><button class="btn pri" data-a="go"' + (!n || !S.tok || S.busy || (!o.replace && !S.category) ? " disabled" : "") + ">" + IC.up + (o.replace ? "새 버전 올리기" : "올리기") + "</button>") + "</span></div>";
      var fo = root.activeElement, foName = fo && body.contains(fo) && (fo.name || fo.getAttribute("data-t"));
      body.innerHTML = h;
      if (foName) { var nf = body.querySelector('[name="' + foName + '"],[data-t="' + foName + '"]'); if (nf && !nf.disabled) nf.focus(); }
      var dz = body.querySelector("[data-dz]");
      if (dz) {
        var inp = dz.querySelector("input");
        inp.addEventListener("change", function () { addFiles(inp.files); });
        dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } });
      }
    }
    // drop anywhere on the dialog (the page behind handles drops only while no dialog is open)
    ov.addEventListener("dragover", function (e) { if (S.busy) return; e.preventDefault(); var z = body.querySelector("[data-dz]"); if (z) z.classList.add("on"); });
    ov.addEventListener("dragleave", function (e) { if (e.target === ov) { var z = body.querySelector("[data-dz]"); if (z) z.classList.remove("on"); } });
    ov.addEventListener("drop", function (e) { e.preventDefault(); if (S.busy) return; if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    body.addEventListener("input", function (e) {
      var t = e.target;
      if (t.hasAttribute("data-t")) S.files[+t.getAttribute("data-t")].title = t.value;
    });
    body.addEventListener("change", function (e) { var t = e.target; if (t.name === "proj") { S.project = t.value; pickCat(); draw(); } else if (t.name === "cat") S.category = t.value; });
    ov.addEventListener("click", async function (ev) {
      var b = ev.target.closest("button"); if (!b || b.disabled) return;
      var a = b.getAttribute("data-a");
      if (a === "close") close();
      else if (a === "rm") { S.files.splice(+b.getAttribute("data-i"), 1); draw(); }
      else if (a === "go") {
        S.err = "";
        for (var i = 0; i < S.files.length; i++) {
          var f = S.files[i], title = (f.title || f.name).trim();
          S.busy = "올리는 중 " + (i + 1) + "/" + S.files.length + " · " + f.name; draw();
          try {
            await sendInbox(S.tok, o.replace ? {op: "add", project: o.replace.project, category: o.replace.category, slug: o.replace.slug, title: o.replace.title, name: f.name, html: f.text}
              : {op: "add", project: S.project, category: S.category, title: title, name: f.name, html: f.text});
            var pn = ((o.projects || []).filter(function (p) { return p.id === (o.replace ? o.replace.project : S.project); })[0] || {}).name || "";
            var sn = (((o.stagesBy || {})[o.replace ? o.replace.project : S.project] || []).filter(function (s) { return s.key === (o.replace ? o.replace.category : S.category); })[0] || {}).label || "";
            S.done.push({title: title, where: [String(pn).split(" · ")[0], sn].filter(Boolean).join(" · ")});
          } catch (err) {
            if (err.message === "perm") S.ghOpen = true;
            S.err = f.name + " — " + errText(err);
            S.files = S.files.slice(i); break;   // keep what is left so a retry continues from here
          }
          if (i === S.files.length - 1) S.files = [];
        }
        S.busy = ""; draw();
      }
    });
    body.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target; if (f.getAttribute("data-a") !== "tok") return;
      var tok = f.tok.value.trim(); if (!tok) return f.tok.focus();
      S.busy = "check"; S.err = ""; draw();
      var ck = await checkToken(tok);
      S.busy = "";
      if (ck.why) { S.err = ck.why; S.ghOpen = true; return draw(); }
      await putToken(tok); S.tok = tok; S.ghOpen = false; draw(); toast("GitHub에 연결했습니다 · 읽기·쓰기 권한 확인됨");
    });
    draw();
    if (o.files && o.files.length) await addFiles(o.files);
  }

  // ---- boards (판): a board made in the hub has only its own sections → op board in the same inbox ----------------------
  // o = {ids: [taken board ids]} (new) · {project: {id, name, own, pages}, fixed: [{key, label, n}], stages: [{key, label, n}]}
  // fixed = sections the agents keep in the manifest (shown, not editable) · n = pages in that section (a section with pages stays)
  function slugOf(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, ""); }
  function rnd(n) { var r = crypto.getRandomValues(new Uint8Array(n)); return Array.from(r, function (x) { return "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]; }).join(""); }
  async function board(o) {
    if (!K()) return toast("소유자로 연 허브에서만 판을 만들 수 있습니다");
    var isNew = !o.project, P = o.project || {id: "", name: "", own: true, pages: 0};
    var S = {tok: await getToken(), name: P.name, stages: (o.stages || []).map(function (s) { return {key: s.key, label: s.label, n: s.n || 0}; }),
             busy: "", err: "", ghOpen: false, armed: false};
    var fixed = o.fixed || [];
    var ov = modal('<div class="hd"><div><div class="eb">' + (isNew ? "새 판" : P.own ? "판 편집" : "섹션 추가") + '</div><h2></h2></div><button class="x" data-a="close" aria-label="닫기">' + IC.x + '</button></div><div class="body"></div>', "dlg");
    ov.querySelector("h2").textContent = isNew ? "새 판 만들기" : P.name;
    var body = ov.querySelector(".body");
    function keyFor(label) {
      var taken = {}; fixed.concat(S.stages).forEach(function (s) { taken[s.key] = 1; });
      var k = slugOf(label); if (!/^[a-z0-9]/.test(k)) k = "";
      if (!k) { do { k = "s-" + rnd(4); } while (taken[k]); return k; }
      var b = k, i = 1; while (taken[k]) k = b + "-" + (++i);
      return k;
    }
    function draw() {
      var ro = !!S.busy, h = "";
      if (P.own) h += '<div class="sec"><label><div class="lbl">판 이름</div><input class="in w" name="name" maxlength="80" placeholder="예: CoRL\'27 · 연구 이름" value="' + esc(S.name) + '"' + (ro ? " disabled" : "") + "></label></div>";
      h += '<div class="sec"><div class="lbl">섹션 <span class="n">' + (fixed.length + S.stages.length) + "개 · 위에서부터 순서대로 보입니다</span></div>";
      if (fixed.length + S.stages.length) h += '<ul class="fl sl">' + fixed.map(function (s, i) {
          return '<li class="fx"><span class="no mono">' + String(i + 1).padStart(2, "0") + '</span><span class="t">' + esc(s.label) + '</span><span class="tg">에이전트가 관리</span></li>'; }).join("") +
        S.stages.map(function (s, i) {
          var no = String(fixed.length + i + 1).padStart(2, "0");
          return '<li><span class="no mono">' + no + '</span><input class="in" data-s="' + i + '" value="' + esc(s.label) + '" maxlength="60" aria-label="섹션 ' + no + ' 이름"' + (ro ? " disabled" : "") + ">" +
            '<span class="mv"><button class="ib" data-a="up" data-i="' + i + '" aria-label="위로"' + (ro || !i ? " disabled" : "") + ">" + IC.upar + "</button>" +
            '<button class="ib" data-a="down" data-i="' + i + '" aria-label="아래로"' + (ro || i === S.stages.length - 1 ? " disabled" : "") + ">" + IC.dnar + "</button>" +
            '<button class="ib del" data-a="rm" data-i="' + i + '" aria-label="섹션 지우기"' + (ro || s.n ? " disabled" : "") + (s.n ? ' title="페이지가 ' + s.n + '개 있어 지울 수 없습니다"' : "") + ">" + IC.x + "</button></span></li>"; }).join("") + "</ul>";
      h += '<div class="add" style="margin-top:10px"><input class="in" name="ns" maxlength="60" placeholder="새 섹션 이름 (예: 데이터 · 실험 · 논문 · shared)"' + (ro ? " disabled" : "") + '><button class="btn" data-a="add"' + (ro ? " disabled" : "") + ">" + IC.plus + "추가</button></div></div>";
      if (!P.own) h += '<div class="note">이 판의 이름과 기존 섹션은 에이전트가 관리합니다. 여기서 더한 섹션은 그 뒤에 붙습니다.</div>';
      if (!S.tok || S.ghOpen) h += ghPanel(isNew ? "판을 만들려면" : "판을 바꾸려면");
      h += '<div class="sec"><div class="err" data-err>' + esc(S.err) + "</div></div>";
      var st = S.busy === "check" ? ["run", "토큰 권한 확인 중…"] : S.busy ? ["run", S.busy] : !S.tok ? ["bad", "GitHub 연결 필요"] : ["", "1~2분 안에 반영됩니다"];
      var canDel = !isNew && P.own && !P.pages && !S.stages.some(function (s) { return s.n; });
      h += '<div class="ft"><span class="stt"><span class="dot ' + st[0] + '"></span><span>' + esc(st[1]) + '</span></span><span class="acts">' +
        (canDel ? '<button class="btn ghost dang" data-a="del"' + (ro || !S.tok ? " disabled" : "") + ">" + (S.armed ? "정말 지우기" : "판 지우기") + "</button>" : "") +
        '<button class="btn" data-a="close">취소</button><button class="btn pri" data-a="go"' + (ro || !S.tok ? " disabled" : "") + ">" + (isNew ? "만들기" : "저장") + "</button></span></div>";
      var fo = root.activeElement, foName = fo && body.contains(fo) && (fo.name || (fo.hasAttribute("data-s") ? "s" + fo.getAttribute("data-s") : ""));
      body.innerHTML = h;
      if (foName) { var nf = foName[0] === "s" && foName !== "ns" ? body.querySelector('[data-s="' + foName.slice(1) + '"]') : body.querySelector('[name="' + foName + '"]'); if (nf && !nf.disabled) nf.focus(); }
    }
    function addSection() {
      var inp = body.querySelector('[name="ns"]'), v = inp ? inp.value.replace(/\s+/g, " ").trim() : "";
      if (!v) { if (inp) inp.focus(); return; }
      if (fixed.concat(S.stages).some(function (s) { return s.label === v; })) { S.err = "‘" + v + "’ 섹션이 이미 있습니다."; draw(); return; }
      S.stages.push({key: keyFor(v), label: v, n: 0}); S.err = ""; draw();
      var n2 = body.querySelector('[name="ns"]'); if (n2) n2.focus();
    }
    async function send(del) {
      var name = S.name.replace(/\s+/g, " ").trim(), pid = P.id;
      var labels = S.stages.map(function (s) { return s.label.replace(/\s+/g, " ").trim(); });
      if (!del && P.own && !name) { S.err = "판 이름을 적어 주세요."; draw(); var ni = body.querySelector('[name="name"]'); if (ni) ni.focus(); return; }
      if (!del && labels.some(function (l) { return !l; })) { S.err = "이름이 빈 섹션이 있습니다."; return draw(); }
      if (!del && body.querySelector('[name="ns"]') && body.querySelector('[name="ns"]').value.trim()) addSection();
      if (isNew) {
        var taken = {}; (o.ids || []).forEach(function (x) { taken[x] = 1; });
        pid = slugOf(name); if (!/^[a-z0-9]/.test(pid)) pid = "";
        if (!pid) { do { pid = "b-" + rnd(5); } while (taken[pid]); }
        var b0 = pid, i = 1; while (taken[pid]) pid = b0 + "-" + (++i);
      }
      S.busy = del ? "지우는 중…" : "보내는 중…"; S.err = ""; draw();
      try {
        var msg = {op: "board", project: pid, title: P.own ? name : P.name};
        if (del) msg.del = true; else msg.stages = S.stages.map(function (s) { return {key: s.key, label: s.label.replace(/\s+/g, " ").trim()}; });
        if (isNew) msg.new = true;
        await sendInbox(S.tok, msg);
        close();
        toast(del ? "1~2분 안에 판을 지웁니다" : isNew ? "판을 만들었습니다 · 1~2분 안에 허브에 올라갑니다" : "저장했습니다 · 1~2분 안에 반영됩니다");
        window.dispatchEvent(new CustomEvent("rh-board", {detail: {project: pid, new: isNew, del: !!del}}));
      } catch (err) {
        if (err.message === "perm") S.ghOpen = true;
        S.busy = ""; S.err = errText(err).replace("올리지 못했습니다", "보내지 못했습니다"); draw();
      }
    }
    body.addEventListener("input", function (e) {
      var t = e.target;
      if (t.name === "name") S.name = t.value;
      else if (t.hasAttribute("data-s")) S.stages[+t.getAttribute("data-s")].label = t.value;
    });
    body.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.isComposing) return;
      if (e.target.name === "ns") { e.preventDefault(); addSection(); }
      else if (e.target.name === "name" || e.target.hasAttribute("data-s")) e.preventDefault();
    });
    ov.addEventListener("click", function (ev) {
      var b = ev.target.closest("button"); if (!b || b.disabled) return;
      var a = b.getAttribute("data-a"), i = +b.getAttribute("data-i");
      if (a === "close") close();
      else if (a === "add") addSection();
      else if (a === "rm") { S.stages.splice(i, 1); draw(); }
      else if (a === "up" || a === "down") {
        var j = a === "up" ? i - 1 : i + 1, t = S.stages[i]; S.stages[i] = S.stages[j]; S.stages[j] = t; draw();
        var nb = body.querySelector('[data-a="' + a + '"][data-i="' + j + '"]'); if (nb && nb.disabled) nb = body.querySelector('[data-a="' + (a === "up" ? "down" : "up") + '"][data-i="' + j + '"]'); if (nb) nb.focus();
      }
      else if (a === "del") { if (!S.armed) { S.armed = true; draw(); setTimeout(function () { if (S.armed && !S.busy) { S.armed = false; if (body.isConnected) draw(); } }, 2500); } else send(true); }
      else if (a === "go") send(false);
    });
    body.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target; if (f.getAttribute("data-a") !== "tok") return;
      var tok = f.tok.value.trim(); if (!tok) return f.tok.focus();
      S.busy = "check"; S.err = ""; draw();
      var ck = await checkToken(tok);
      S.busy = "";
      if (ck.why) { S.err = ck.why; S.ghOpen = true; return draw(); }
      await putToken(tok); S.tok = tok; S.ghOpen = false; draw(); toast("GitHub에 연결했습니다 · 읽기·쓰기 권한 확인됨");
    });
    draw();
    var first = body.querySelector(P.own ? '[name="name"]' : '[name="ns"]'); if (first) first.focus();
  }

  // ---- renames: boards · sections · pages · headings inside a page (names op → the cloud step's map) -------------------
  // live map = the deployed u.enc names + what this browser sent that is still waiting (so a rename shows at once)
  async function names() {
    var c = await cloud(), out = Object.assign({}, (c && c.names) || {});
    (await getPending()).forEach(function (x) {
      if (x.op === "names" && x.set) Object.keys(x.set).forEach(function (k) { if (x.set[k]) out[k] = x.set[k]; else delete out[k]; });
    });
    return out;
  }
  // o = {title, fields: [{key, label, cur, orig, group}]} — orig = the text before any rename (offers '원래대로')
  async function rename(o) {
    if (!K()) return toast("소유자로 연 허브에서만 이름을 바꿀 수 있습니다");
    var S = {tok: await getToken(), busy: "", err: "", ghOpen: false, val: {}};
    o.fields.forEach(function (f) { S.val[f.key] = f.cur; });
    var ov = modal('<div class="hd"><div><div class="eb">이름 바꾸기</div><h2></h2></div><button class="x" data-a="close" aria-label="닫기">' + IC.x + '</button></div><div class="body"></div>', "dlg");
    ov.querySelector("h2").textContent = o.title || "제목 바꾸기";
    var body = ov.querySelector(".body");
    function changed() { return o.fields.filter(function (f) { return (S.val[f.key] || "").replace(/\s+/g, " ").trim() !== f.cur; }); }
    function draw() {
      var ro = !!S.busy, h = "", g = null;
      o.fields.forEach(function (f, i) {
        if (f.group !== g) { if (g !== null) h += "</div>"; g = f.group; h += '<div class="sec"><div class="lbl">' + esc(g) + "</div>"; }
        var v = S.val[f.key], back = f.orig && v !== f.orig;
        h += '<div class="rn"><div class="rl">' + esc(f.label) + (f.orig && f.cur !== f.orig ? ' <span class="n">원래: ' + esc(f.orig) + "</span>" : "") + "</div>" +
          '<div class="add"><input class="in" data-k="' + i + '" value="' + esc(v) + '" maxlength="120"' + (ro ? " disabled" : "") + ">" +
          (back ? '<button class="btn ghost" data-a="orig" data-i="' + i + '"' + (ro ? " disabled" : "") + ">원래대로</button>" : "") + "</div></div>";
      });
      if (g !== null) h += "</div>";
      h += '<div class="note">원본 파일은 그대로 두고 보이는 이름만 바꿉니다. 에이전트가 나중에 그 제목 자체를 고치면 새 제목이 보입니다.</div>';
      if (!S.tok || S.ghOpen) h += ghPanel("이름을 바꾸려면");
      h += '<div class="sec"><div class="err" data-err>' + esc(S.err) + "</div></div>";
      var n = changed().length, st = S.busy === "check" ? ["run", "토큰 권한 확인 중…"] : S.busy ? ["run", S.busy] : !S.tok ? ["bad", "GitHub 연결 필요"] : ["", n ? n + "개 바뀜 · 1~2분 안에 반영" : "고칠 이름을 바꾸세요"];
      h += '<div class="ft"><span class="stt"><span class="dot ' + st[0] + '"></span><span>' + esc(st[1]) + '</span></span><span class="acts">' +
        '<button class="btn" data-a="close">취소</button><button class="btn pri" data-a="go"' + (ro || !S.tok || !n ? " disabled" : "") + ">저장</button></span></div>";
      var fo = root.activeElement, fi = fo && body.contains(fo) && fo.getAttribute("data-k");
      body.innerHTML = h;
      if (fi) { var nf = body.querySelector('[data-k="' + fi + '"]'); if (nf) { nf.focus(); nf.setSelectionRange(nf.value.length, nf.value.length); } }
    }
    function status() { var t = ov.querySelector(".stt span:last-child"), b = ov.querySelector('[data-a="go"]'), n = changed().length;
      if (t && !S.busy && S.tok) t.textContent = n ? n + "개 바뀜 · 1~2분 안에 반영" : "고칠 이름을 바꾸세요"; if (b) b.disabled = !!S.busy || !S.tok || !n; }
    body.addEventListener("input", function (e) { var t = e.target; if (t.hasAttribute("data-k")) { S.val[o.fields[+t.getAttribute("data-k")].key] = t.value; status(); } });
    body.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing && e.target.hasAttribute("data-k")) { e.preventDefault(); var b = ov.querySelector('[data-a="go"]'); if (b && !b.disabled) b.click(); } });
    ov.addEventListener("click", async function (ev) {
      var b = ev.target.closest("button"); if (!b || b.disabled) return;
      var a = b.getAttribute("data-a");
      if (a === "close") close();
      else if (a === "orig") { var f = o.fields[+b.getAttribute("data-i")]; S.val[f.key] = f.orig; draw(); }
      else if (a === "go") {
        var set = {};
        changed().forEach(function (f) { var v = (S.val[f.key] || "").replace(/\s+/g, " ").trim(); set[f.key] = !v || (f.orig && v === f.orig) ? "" : v; });
        S.busy = "저장 중…"; S.err = ""; draw();
        try {
          await sendInbox(S.tok, {op: "names", set: set, title: o.title || "이름"});
          close(); toast("저장했습니다 · 1~2분 안에 모든 곳에 반영됩니다");
          window.dispatchEvent(new CustomEvent("rh-names", {detail: {set: set}}));
        } catch (err) {
          if (err.message === "perm") S.ghOpen = true;
          S.busy = ""; S.err = errText(err).replace("올리지 못했습니다", "저장하지 못했습니다"); draw();
        }
      }
    });
    body.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var f = ev.target; if (f.getAttribute("data-a") !== "tok") return;
      var tok = f.tok.value.trim(); if (!tok) return f.tok.focus();
      S.busy = "check"; S.err = ""; draw();
      var ck = await checkToken(tok);
      S.busy = "";
      if (ck.why) { S.err = ck.why; S.ghOpen = true; return draw(); }
      await putToken(tok); S.tok = tok; S.ghOpen = false; draw(); toast("GitHub에 연결했습니다 · 읽기·쓰기 권한 확인됨");
    });
    draw();
    var first = body.querySelector("[data-k]"); if (first) { first.focus(); first.select(); }
  }

  // ---- ⌘K palette ---------------------------------------------------------------------------------------------------
  var ITEMS = [], UPS = [];
  function setTheme(t) {
    try { if (t === "system") localStorage.removeItem("rh-theme"); else localStorage.setItem("rh-theme", t); } catch (e) {}
    if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
    window.dispatchEvent(new CustomEvent("rh-theme", {detail: t}));
  }
  function palette(extra) {
    var acts = [
      {g: "이동", t: "허브 홈", m: "판 목록", ic: IC.bolt, go: function () { location.href = rh().root || "./"; }},
      {g: "보기", t: "테마: 시스템 설정 따르기", ic: IC.bolt, go: function () { setTheme("system"); }},
      {g: "보기", t: "테마: 밝게", ic: IC.bolt, go: function () { setTheme("light"); }},
      {g: "보기", t: "테마: 어둡게", ic: IC.bolt, go: function () { setTheme("dark"); }},
      {g: "보안", t: "잠그기", m: "이 브라우저의 키를 지웁니다", ic: IC.lock, go: function () { if (rh().lock) rh().lock(); }}
    ].concat(extra || []);
    var ov = modal('<div class="pq">' + IC.search + '<input placeholder="페이지 · 섹션 · 판 검색" aria-label="검색" autocomplete="off" spellcheck="false"><span class="kbd">esc</span></div><div class="pl" role="listbox"></div>' +
      '<div class="pf"><span><span class="kbd">↑↓</span> 이동</span><span><span class="kbd">↵</span> 열기</span><span><span class="kbd">' + MODK + '</span> 열기·닫기</span></div>', "pal");
    var q = ov.querySelector("input"), list = ov.querySelector(".pl"), sel = 0, rows = [];
    function match(it, words) { var hay = (it.t + " " + (it.m || "") + " " + (it.d || "")).toLowerCase(); return words.every(function (w) { return hay.indexOf(w) >= 0; }); }
    function drawList() {
      var words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var pages = ITEMS.concat(UPS).map(function (it) { return {g: "페이지", t: it.t, m: [it.pn, it.sl].filter(Boolean).join(" · "), d: it.d, ic: IC.page, href: it.h, x: it.x}; });
      rows = pages.concat(acts).filter(function (it) { return match(it, words); });
      if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
      var g = "", h = "";
      rows.forEach(function (it, i) {
        if (it.g !== g) { g = it.g; h += '<div class="pg">' + esc(g) + "</div>"; }
        h += '<div class="pi" role="option" data-i="' + i + '" aria-selected="' + (i === sel) + '"><span class="gi">' + it.ic + '</span><span class="t">' + esc(it.t) + (it.x ? " ↗" : "") + '</span><span class="m">' + esc(it.m || "") + "</span></div>";
      });
      list.innerHTML = h || '<div class="pe">맞는 항목이 없습니다</div>';
      var s = list.querySelector('[aria-selected="true"]'); if (s) s.scrollIntoView({block: "nearest"});
    }
    function go(i) {
      var it = rows[i]; if (!it) return; close();
      if (it.go) return it.go();
      if (it.x) window.open(it.href, "_blank", "noopener,noreferrer"); else location.href = it.href;
    }
    q.addEventListener("input", function () { sel = 0; drawList(); });
    q.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); drawList(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); drawList(); }
      else if (e.key === "Enter") { e.preventDefault(); go(sel); }
    });
    list.addEventListener("mousemove", function (e) { var r = e.target.closest(".pi"); if (r && +r.getAttribute("data-i") !== sel) { sel = +r.getAttribute("data-i"); list.querySelectorAll(".pi").forEach(function (x) { x.setAttribute("aria-selected", String(+x.getAttribute("data-i") === sel)); }); } });
    list.addEventListener("click", function (e) { var r = e.target.closest(".pi"); if (r) go(+r.getAttribute("data-i")); });
    drawList(); q.focus();
    // every page, wherever the palette opens: the uploaded pages (made in the hub — the page's own list may not know them)
    if (K()) cloud().then(function (c) {
      if (!c || !c.items || !ov.isConnected) return;
      var have = {}, N = c.names || {}, bd = c.boards || [];
      ITEMS.forEach(function (x) { have[x.h] = 1; });
      UPS = c.items.filter(function (it) { return !have[pageUrl(it.pdir)]; }).map(function (it) {
        var own = function (k, cat) { return (bd.filter(function (r) { return r.project === it.project && r.kind === k && (!cat || r.category === cat); })[0] || {}).title; };
        var sib = ITEMS.filter(function (x) { return x.pj === it.project; })[0], sec = ITEMS.filter(function (x) { return x.pj === it.project && x.c === it.category; })[0];
        return {t: it.title, h: pageUrl(it.pdir),
                pn: String(own("project") || N["b:" + it.project] || (sib && sib.pn) || it.project).split(" · ")[0],
                sl: own("stage", it.category) || N["s:" + it.project + "/" + it.category] || (sec && sec.sl) || it.category};
      });
      if (UPS.length) drawList();
    });
  }
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      if (!rh().owner) return;
      e.preventDefault();
      if (root && root.querySelector(".pal")) close(); else palette();
    }
  });
  if (window.matchMedia) try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { if (root) ensureHost(); }); } catch (e) {}
  window.addEventListener("rh-theme", function () { if (root) ensureHost(); });
  window.RHUI = {
    share: share, palette: palette, toast: toast, setTheme: setTheme, copy: copy,
    upload: upload, unlist: unlist, pending: pendingUploads, cancelUpload: cancelUpload, board: board, cloud: cloud, names: names, rename: rename,
    items: function (list) { ITEMS = list || []; },
    // the share level of a page as the dialog sees it (for badges) — needs a token or the public ctl copy
    state: async function () { var r = await loadState(await getToken()); return {st: r.st, live: await liveEpochs()}; }
  };
  window.dispatchEvent(new Event("rh-ui-ready"));
})();
