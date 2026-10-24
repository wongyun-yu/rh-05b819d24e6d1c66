/* Research Hub page bar — injected by hub_build.py at the top of every page (sources are never edited).
   Data: #rh-nav-data. The page itself carries only {min, root, ct} (this page's title); for the owner the shell swaps in
   the full data (stage rows + every page — sealed with HKDF(K, "meta") in the page config), so a shared viewer never
   sees the titles of pages they were not given. Shadow DOM keeps the page CSS and the bar CSS apart; the bar borrows the
   page's colours so it sits well on it, but always uses the hub's type (Pretendard · Geist Mono) — the same on every page.
   Owner   — row 1: ← 뒤로 · Research Hub / <project> / <page> · 검색(⌘K) · 공유   row 2: stage tabs   row 3: sibling pages (≥ 2)
   Viewer  — one row: Research Hub · <page> · '공유받은 페이지' */
(function () {
  "use strict";
  var host = document.getElementById("rh-nav"), dEl = document.getElementById("rh-nav-data");
  if (!host || !dEl || host.shadowRoot) return;
  try { var th = localStorage.getItem("rh-theme"); if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th); } catch (e) {}
  var N = JSON.parse(dEl.textContent);
  var R = window.__rh || {};
  var OWNER = !N.min && !!R.owner;
  // An uploaded page runs in a sandboxed frame (#rh-up) that this script cannot read: up_bridge.js inside it reports its
  // headings · scroll · content column · colours (RM), and takes 'go to heading' · 'top' · theme · renamed headings back.
  var UP = document.documentElement.hasAttribute("data-rh-up"), RM = {y: 0, tops: [], heads: [], hd: null, box: null, vw: 0, look: null, seen: false}, NM = null;
  function toUp(m) { var f = document.getElementById("rh-up"); if (f && f.contentWindow) try { f.contentWindow.postMessage(m, "*"); } catch (e) {} }
  var ROOT = new URL(N.root, location.href);
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]; }); }
  function href(p) { return p.x ? p.h : new URL(p.h, ROOT).href; }
  function ext(p) { return p.x ? ' target="_blank" rel="noopener noreferrer"' : ""; }
  var I = {
    pen: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
    back: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    logo: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 17 10 9l5 5 4-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    users: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };
  var SM = {"private": [I.lock, "공유"], invite: [I.users, "초대 공유 중"], link: [I.globe, "링크 공유 중"]};
  var html = "", curStage = null;
  if (OWNER) {
    var HOME = new URL("#p-" + encodeURIComponent(N.proj), ROOT).href;
    var PSHORT = String(N.pname).split(" · ")[0];
    var tabs = N.st.map(function (s) {
      if (s.k === N.cs) curStage = s;
      var lab = '<span data-k="' + esc("s:" + N.proj + "/" + s.k) + '" data-o="' + esc(s.l) + '">' + esc(s.l) + "</span>";
      if (!s.p.length) return '<span class="tab off" aria-disabled="true">' + lab + "</span>";
      var on = s.k === N.cs;
      return '<a class="tab' + (on ? " on" : "") + '"' + (on ? ' aria-current="true"' : "") + ' href="' + esc(href(s.p[0])) + '"' + ext(s.p[0]) + ">" + lab +
        (s.p.length > 1 ? '<span class="cnt">' + s.p.length + "</span>" : "") + "</a>";
    }).join("");
    var subs = "";
    if (curStage && curStage.p.length > 1) {
      subs = '<div class="row subs" role="list">' + curStage.p.map(function (p) {
        var on = p.s === N.cp;
        return '<a role="listitem" class="sub' + (on ? " on" : "") + '"' + (on ? ' aria-current="page"' : "") + ' href="' + esc(href(p)) + '"' + ext(p) + '><span data-k="' +
          esc("p:" + N.proj + "/" + N.cs + "/" + p.s) + '" data-o="' + esc(p.t) + '">' + esc(p.t) + "</span></a>";
      }).join("") + "</div>";
    }
    var sm = SM[N.sm] || SM["private"];
    html =
      '<nav class="bar" aria-label="Research Hub">' +
      '<div class="row top"><button type="button" class="back" id="back" aria-label="뒤로">' + I.back + '<span class="wide">뒤로</span></button>' +
      '<div class="crumbs"><a class="wide brand" href="' + esc(ROOT.href) + '"><span class="logo">' + I.logo + '</span>Research Hub</a><span class="sl wide">/</span>' +
      '<a class="wide" href="' + esc(HOME) + '" title="' + esc(N.pname) + '" data-k="' + esc("b:" + N.proj) + '" data-o="' + esc(N.pname) + '" data-f="short">' + esc(PSHORT) + '</a><span class="sl wide">/</span>' +
      '<span class="here" title="' + esc(N.ct) + '" data-k="' + esc("p:" + N.proj + "/" + N.cs + "/" + N.cp) + '" data-o="' + esc(N.ct) + '">' + esc(N.ct) + "</span></div>" +
      '<div class="acts"><button type="button" class="act ic" id="theme"></button>' +
      '<button type="button" class="act" id="ren" aria-label="제목 바꾸기" title="판 · 섹션 · 페이지 · 소제목 이름 바꾸기">' + I.pen + '<span class="wide">제목</span></button>' +
      '<button type="button" class="act" id="find" aria-label="검색 (Ctrl+K)">' + I.search + '<span class="wide">검색</span><kbd class="wide">' + (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ") + "K</kbd></button>" +
      (R.own ? "" : '<button type="button" class="act share' + (N.sm && N.sm !== "private" ? " live" : "") + '" id="share">' + sm[0] + '<span class="wide">' + sm[1] + "</span></button>") +
      "</div></div>" +
      '<div class="tabsw"><div class="row tabs" id="tabs">' + tabs + '</div><span class="fade l" id="fl"></span><span class="fade r" id="fr"></span></div>' +
      subs + "</nav>";
  } else {
    var role = R.role === "invite" ? [I.users, "초대받은 페이지"] : [I.globe, "공유받은 페이지"];
    html = '<nav class="bar" aria-label="Research Hub"><div class="row top">' +
      '<div class="crumbs"><span class="brand wide"><span class="logo">' + I.logo + '</span>Research Hub</span><span class="sl wide">/</span>' +
      '<span class="here" title="' + esc(N.ct) + '">' + esc(N.ct) + "</span></div>" +
      '<div class="acts"><button type="button" class="act ic" id="theme"></button><span class="chip">' + role[0] + '<span class="wide">' + role[1] + "</span></span></div></div></nav>";
  }
  // The bar and the outline carry the hub's own type (Pretendard · Geist Mono) on every page — before 10-16 they inherited
  // the page's body font, so an uploaded page (whose host has none) showed them in the browser's default serif.
  // @font-face must live in the document (a shadow root's own @font-face is ignored by some browsers).
  [["https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css", "pretendardvariable"],
   ["https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap", "Geist+Mono"]].forEach(function (f) {
    if (document.querySelector('link[href*="' + f[1] + '"]')) return;
    var l = document.createElement("link"); l.rel = "stylesheet"; l.href = f[0]; (document.head || document.documentElement).appendChild(l);
  });
  var root = host.attachShadow({mode: "open"});
  root.innerHTML =
    "<style>" +
    ":host{display:block;position:relative;z-index:2147483000;font-family:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;font-size:13.5px;font-weight:400;font-style:normal;line-height:1.35;letter-spacing:-.005em;word-break:keep-all;text-transform:none;-webkit-font-smoothing:antialiased;" +
    "--ink:#18181b;--bg:#ffffff;--acc:#3e63dd;" +
    "--mut:color-mix(in srgb,var(--ink) 60%,var(--bg));--faint:color-mix(in srgb,var(--ink) 32%,var(--bg));" +
    "--line:color-mix(in srgb,var(--ink) 12%,var(--bg));--hov:color-mix(in srgb,var(--ink) 6%,var(--bg))}" +
    "*{box-sizing:border-box}[hidden]{display:none!important}" +
    ".bar{background:color-mix(in srgb,var(--bg) 92%,transparent);color:var(--ink);border-bottom:1px solid var(--line)}" +
    ".row{display:flex;align-items:center;gap:4px;padding:0 var(--pr,16px) 0 var(--pl,16px);min-width:0}" +
    ".top{height:46px;gap:10px}" +
    "a,button{font:inherit;color:inherit;text-decoration:none}" +
    ".back{display:inline-flex;align-items:center;gap:4px;flex:none;height:28px;padding:0 8px 0 4px;margin-left:-4px;border:0;border-radius:7px;background:none;color:var(--mut);cursor:pointer;white-space:nowrap}" +
    ".back:hover{color:var(--ink);background:var(--hov)}" +
    ".crumbs{display:flex;align-items:center;gap:7px;min-width:0;flex:1;white-space:nowrap;overflow:hidden}" +
    ".crumbs a{color:var(--mut);flex:none;border-radius:5px} .crumbs a:hover{color:var(--ink)}" +
    ".brand{display:inline-flex;align-items:center;gap:7px;color:var(--ink)!important;font-weight:600;flex:none}" +
    ".logo{width:20px;height:20px;border-radius:6px;background:var(--ink);color:var(--bg);display:grid;place-items:center;flex:none}" +
    ".crumbs .sl{color:var(--faint);flex:none}" +
    ".crumbs .here{font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;min-width:0}" +
    ".acts{display:flex;align-items:center;gap:6px;flex:none}" +
    ".act{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--mut);cursor:pointer;white-space:nowrap;font-size:13px}" +
    ".act:hover{color:var(--ink);border-color:var(--faint)}" +
    ".act kbd{font:11px 'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:2px}" +
    ".act.share{color:var(--ink);font-weight:550}" +
    ".act.ic{width:30px;padding:0;justify-content:center}" +
    ".act.share.live{background:var(--ink);color:var(--bg);border-color:var(--ink)}.act.share.live:hover{opacity:.88}" +
    ".chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;background:var(--hov);color:var(--mut);font-size:12.5px;white-space:nowrap}" +
    "a.chip:hover{color:var(--ink)}" +
    ".tabsw{position:relative}" +
    ".tabs{gap:22px;height:38px;overflow-x:auto;scrollbar-width:none;white-space:nowrap}" +
    ".tabs::-webkit-scrollbar{display:none}" +
    ".tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:100%;flex:none;color:var(--mut)}" +
    "a.tab:hover{color:var(--ink)}" +
    ".tab.on{color:var(--ink);font-weight:600}" +
    ".tab.on::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--ink)}" +
    ".tab.off{color:var(--faint);cursor:default}" +
    ".cnt{font:500 11px 'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);background:var(--hov);border-radius:999px;padding:0 6px;line-height:17px}" +
    ".subs{gap:6px;padding-top:8px;padding-bottom:9px;border-top:1px solid var(--line);overflow-x:auto;scrollbar-width:none;white-space:nowrap}" +
    ".subs::-webkit-scrollbar{display:none}" +
    ".sub{flex:none;font-size:12.5px;padding:4px 11px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}" +
    ".sub:hover{color:var(--ink);border-color:var(--faint)}" +
    ".sub.on{color:var(--bg);border-color:var(--ink);background:var(--ink);font-weight:600}" +
    ":focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}" +
    ".fade{position:absolute;top:0;bottom:1px;width:28px;pointer-events:none;opacity:0;transition:opacity .15s}" +
    ".fade.l{left:0;background:linear-gradient(90deg,var(--bg),transparent)} .fade.r{right:0;background:linear-gradient(270deg,var(--bg),transparent)}" +
    ".fade.show{opacity:1}" +
    "@media (max-width:560px){.wide{display:none!important}.tabs{gap:18px}.row{padding:0 16px}.act{padding:0 8px}}" +
    /* page outline (목차) */
    ".toc{position:fixed;top:24px;z-index:2147483001;max-height:calc(100vh - 48px);overflow:auto;padding:4px 0 4px 2px;font-size:12.5px;line-height:1.4;color:var(--mut);scrollbar-width:thin}" +
    ".toc-h{font-weight:600;color:var(--ink);padding:0 10px 8px;font-size:12px;display:flex;align-items:center;gap:6px}" +
    ".toc ol,.sheet ol{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}" +
    ".toc a,.sheet a{display:block;padding:4px 10px;margin-left:-1px;border-left:2px solid transparent;color:var(--mut);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".toc a:hover,.sheet a:hover{color:var(--ink)}" +
    ".toc a.on,.sheet a.on{color:var(--ink);font-weight:600;border-left-color:var(--ink)}" +
    ".toc a.l3,.sheet a.l3{padding-left:22px}" +
    ".fab{position:fixed;right:18px;bottom:18px;z-index:2147483001;width:44px;height:44px;border-radius:50%;border:0;background:var(--ink);color:var(--bg);display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 20px -6px rgba(0,0,0,.35)}" +
    ".sheet{position:fixed;right:16px;bottom:72px;z-index:2147483001;width:min(320px,calc(100vw - 32px));max-height:60vh;overflow:auto;padding:12px 6px 10px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 48px -12px rgba(0,0,0,.35);font-size:13.5px;line-height:1.4}" +
    ".sheet .top2{display:flex;justify-content:space-between;align-items:center;padding:0 8px 8px;font-weight:600;font-size:12.5px}" +
    ".sheet .up{border:0;background:none;color:var(--mut);cursor:pointer;font-size:12.5px;padding:2px 4px}.sheet .up:hover{color:var(--ink)}" +
    "@media print{.toc,.fab,.sheet{display:none!important}}" +
    "@media (prefers-reduced-motion:reduce){.fade{transition:none}}" +
    "</style>" + html +
    '<aside class="toc" id="toc" hidden aria-label="목차"><div class="toc-h">' + I.list + '목차</div><ol id="tocl"></ol></aside>' +
    '<button class="fab" id="fab" type="button" hidden aria-label="목차 열기" aria-expanded="false">' + I.list + "</button>" +
    '<div class="sheet" id="sheet" hidden role="dialog" aria-label="목차"><div class="top2"><span>목차</span><button class="up" type="button" id="up">맨 위로 ↑</button></div><ol id="sheetl"></ol></div>';
  if (OWNER) {
    // Back = the browser's back while we are inside the hub in this tab (the shell sends no referrer, so a session flag
    // marks that); a page opened fresh (new tab, bookmark) goes to the project screen instead.
    var inHub = false;
    try { inHub = sessionStorage.getItem("rh-in") === "1"; sessionStorage.setItem("rh-in", "1"); } catch (e) {}
    root.getElementById("back").addEventListener("click", function () {
      if (history.length > 1 && inHub) history.back(); else location.href = new URL("#p-" + encodeURIComponent(N.proj), ROOT).href;
    });
    // owner tools (share dialog · ⌘K) live in one public script shared with the hub screen
    var ui = null;
    function withUI(fn) {
      if (window.RHUI) return fn(window.RHUI);
      if (!ui) {
        ui = document.createElement("script"); ui.src = new URL("rh-ui.js?v=" + (N.uv || ""), ROOT).href; document.head.appendChild(ui);
        window.addEventListener("rh-ui-ready", function () {
          window.RHUI.items((N.all || []).map(function (p) { return {t: p.t, sl: p.sl, pn: p.pn, pj: p.pj, c: p.c, h: href(p), x: p.x}; }));
        }, {once: true});
      }
      window.addEventListener("rh-ui-ready", function () { fn(window.RHUI); }, {once: true});
    }
    withUI(function () {});
    // renames (the owner's map from the cloud step): the bar, and this page's headings (an uploaded page's headings are
    // baked by the cloud step — its frame cannot be reached from here)
    var PID = N.proj + "/" + N.cs + "/" + N.cp;
    function norm(t) { return String(t || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().slice(0, 200); }
    function pageHeads() {
      return UP ? [] : Array.prototype.filter.call(document.querySelectorAll("h1, h2, h3, h4"), function (h) { return !host.contains(h) && norm(h.textContent); });
    }
    function applyNames(M) {
      Array.prototype.forEach.call(root.querySelectorAll("[data-k]"), function (el) {
        var v = M[el.getAttribute("data-k")] || el.getAttribute("data-o");
        el.textContent = el.getAttribute("data-f") === "short" ? String(v).split(" · ")[0] : v;
        if (el.title !== undefined && el.hasAttribute("title")) el.title = v;
      });
      if (UP) {   // the frame applies them (the cloud step bakes them for everyone a minute later)
        var pre = "h:" + PID + "#"; NM = {};
        Object.keys(M).forEach(function (k) { if (k.indexOf(pre) === 0) NM[k.slice(pre.length)] = M[k]; });
        toUp({rh: "names", m: NM});
      }
      pageHeads().forEach(function (h) {
        var o = h.getAttribute("data-rh-o") || norm(h.textContent), v = M["h:" + PID + "#" + o];
        if (v && norm(h.textContent) !== v) { h.setAttribute("data-rh-o", o); h.textContent = v; }
        else if (!v && h.hasAttribute("data-rh-o") && norm(h.textContent) !== o) h.textContent = o;   // reset after a build baked it
      });
    }
    withUI(function (U) { if (U.names) U.names().then(applyNames).catch(function () {}); });
    window.addEventListener("rh-names", function () { withUI(function (U) { U.names().then(applyNames).catch(function () {}); }); });
    root.getElementById("ren").addEventListener("click", function () {
      withUI(function (U) {
        U.names().then(function (M) {
          var cur = function (k, o) { return M[k] || o; }, own = N.own || {};
          var st = (N.st || []).filter(function (x) { return x.k === N.cs; })[0] || {l: N.cs};
          var f = [
            {key: "b:" + N.proj, label: "판 이름", cur: cur("b:" + N.proj, N.pname), orig: own.b ? null : N.pname, group: "판 · 섹션 · 페이지"},
            {key: "s:" + N.proj + "/" + N.cs, label: "섹션 이름", cur: cur("s:" + N.proj + "/" + N.cs, st.l), orig: own.s ? null : st.l, group: "판 · 섹션 · 페이지"},
            {key: "p:" + PID, label: "페이지 제목", cur: cur("p:" + PID, N.ct), orig: N.up ? null : N.ct, group: "판 · 섹션 · 페이지"}];
          var seen = {};
          (UP ? (RM.hd || N.hd || []).map(function (x) { return {o: x.o, t: M["h:" + PID + "#" + x.o] || x.o, tag: x.tag || ""}; })
                : pageHeads().map(function (h) { var o = h.getAttribute("data-rh-o") || norm(h.textContent); return {o: o, t: M["h:" + PID + "#" + o] || o, tag: h.tagName}; }))
            .forEach(function (x) {
              if (seen[x.o]) return; seen[x.o] = 1;
              f.push({key: "h:" + PID + "#" + x.o, label: x.tag ? {H1: "큰 제목 (h1)", H2: "소제목 (h2)", H3: "작은 제목 (h3)", H4: "작은 제목 (h4)"}[x.tag] : "소제목", cur: x.t, orig: x.o, group: "페이지 안 소제목"});
            });
          U.rename({title: N.ct, fields: f});
        }).catch(function () {});
      });
    });
    root.getElementById("find").addEventListener("click", function () { withUI(function (U) { U.palette(); }); });
    var sb = root.getElementById("share");
    if (sb) {
      sb.addEventListener("click", function () { withUI(function (U) { U.share({pdir: R.pdir, title: N.ct}); }); });
      var setShare = function (mode) {
        var x = SM[mode] || SM["private"];
        sb.className = "act share" + (mode && mode !== "private" ? " live" : "");
        sb.innerHTML = x[0] + '<span class="wide">' + x[1] + "</span>";
      };
      window.addEventListener("rh-share", function (e) { if (e.detail && e.detail.pdir === R.pdir) setShare(e.detail.mode); });
      // the build's copy of the share level can be one tick old — ask the live settings once
      withUI(function (U) { U.state().then(function (r) { var e = r.st.pages[R.pdir]; if (e) setShare(e.mode); }).catch(function () {}); });
    }
    var T = root.getElementById("tabs"), FL = root.getElementById("fl"), FR = root.getElementById("fr");
    var fades = function () {
      FL.classList.toggle("show", T.scrollLeft > 2);
      FR.classList.toggle("show", T.scrollLeft + T.clientWidth < T.scrollWidth - 2);
    };
    T.addEventListener("scroll", fades, {passive: true});
    window.addEventListener("resize", fades);
  }
  // light / dark switch (every role): the page CSS follows :root[data-theme]; the choice is kept per browser (rh-theme)
  var TB = root.getElementById("theme");
  function dark() { var t = document.documentElement.getAttribute("data-theme"); return t ? t === "dark" : !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches); }
  function themeIcon() { TB.innerHTML = dark() ? I.sun : I.moon; TB.setAttribute("aria-label", dark() ? "밝은 화면으로" : "어두운 화면으로"); TB.title = TB.getAttribute("aria-label"); }
  TB.addEventListener("click", function () {
    var nx = dark() ? "light" : "dark";
    try { localStorage.setItem("rh-theme", nx); } catch (e) {}
    document.documentElement.setAttribute("data-theme", nx);
    window.dispatchEvent(new CustomEvent("rh-theme", {detail: nx}));
  });
  window.addEventListener("rh-theme", function () { if (UP) toUp({rh: "theme", t: document.documentElement.getAttribute("data-theme") || ""}); });
  window.addEventListener("rh-theme", themeIcon);
  themeIcon();
  // 'Changed since you last looked' on the hub: remember when this browser last opened this page (owner only).
  if (OWNER && R.pdir && !R.own) {
    try { var seen = JSON.parse(localStorage.getItem("rh-seen") || "null") || {_0: new Date().toISOString()}; seen[R.pdir] = new Date().toISOString(); localStorage.setItem("rh-seen", JSON.stringify(seen)); } catch (e) {}
  }
  // ---- page outline (목차): the page's h2/h3, fixed in the right margin when there is room, else a floating button.
  var TOC = root.getElementById("toc"), TOCL = root.getElementById("tocl"), FAB = root.getElementById("fab"), SH = root.getElementById("sheet"), SHL = root.getElementById("sheetl");
  var HS = [], ACT = -1, BOXR = 0, tocMode = "";
  function heads() {
    if (UP) return RM.heads.map(function (h) { return {tagName: h.g === 3 ? "H3" : "H2", textContent: h.t}; });
    return Array.prototype.filter.call(document.querySelectorAll("h2, h3"), function (h) {
      return h.getClientRects().length && (h.textContent || "").trim() && !h.closest("nav, footer, dialog, [aria-hidden='true']");
    }).slice(0, 120);
  }
  function label(h) { var t = (h.textContent || "").replace(/\s+/g, " ").trim(); return t.length > 64 ? t.slice(0, 63) + "…" : t; }
  function items() { return HS.map(function (h, i) { return '<li><a data-i="' + i + '" class="' + (h.tagName === "H3" ? "l3" : "") + '" title="' + esc(label(h)) + '">' + esc(label(h)) + "</a></li>"; }).join(""); }
  function buildToc() {
    var hs = heads();
    var same = hs.length === HS.length && hs.every(function (h, i) { return UP ? h.tagName === HS[i].tagName && h.textContent === HS[i].textContent : h === HS[i]; });
    HS = hs;
    if (!same) { TOCL.innerHTML = items(); SHL.innerHTML = TOCL.innerHTML; ACT = -1; }
    placeToc(); spy();
  }
  function placeToc() {
    var vw = UP && RM.vw ? RM.vw : document.documentElement.clientWidth, gut = vw - BOXR;   // (an upload: the frame's width, past its scrollbar)
    var mode = HS.length < 3 ? "" : gut >= 236 ? "side" : "fab";
    tocMode = mode;
    TOC.hidden = mode !== "side";
    if (mode === "side") { TOC.style.left = (BOXR + 28) + "px"; TOC.style.width = Math.min(248, gut - 48) + "px"; }
    if (mode !== "fab") { FAB.hidden = true; SH.hidden = true; }
    onScroll();
  }
  function onScroll() {
    var hb = host.getBoundingClientRect().bottom;
    if (tocMode === "side") TOC.style.top = Math.max(24, hb + 24) + "px";
    var away = UP ? RM.y > 160 : hb <= 0;   // the bar never scrolls away above an upload — its frame scrolls instead
    if (tocMode === "fab") FAB.hidden = !away;
    if (tocMode === "fab" && !away) SH.hidden = true;
  }
  function spy() {
    var a = -1;
    for (var i = 0; i < HS.length; i++) { if ((UP ? RM.tops[i] : HS[i].getBoundingClientRect().top) < (UP ? 96 : 120)) a = i; else break; }
    if (a === ACT) return; ACT = a;
    [TOCL, SHL].forEach(function (L) {
      Array.prototype.forEach.call(L.querySelectorAll("a"), function (x) { x.classList.toggle("on", +x.getAttribute("data-i") === a); });
      var on = L.querySelector("a.on"), box = L === TOCL ? TOC : SH;
      if (on && !box.hidden) {   // keep the current entry in view inside the outline only (never scroll the page)
        var r = on.getBoundingClientRect(), b = box.getBoundingClientRect();
        if (r.top < b.top + 24 || r.bottom > b.bottom - 24) box.scrollTop += r.top - b.top - box.clientHeight / 2;
      }
    });
  }
  function go(e) {
    var x = e.target.closest("a[data-i]"); if (!x) return;
    e.preventDefault();
    var h = HS[+x.getAttribute("data-i")]; if (!h) return;
    SH.hidden = true; FAB.setAttribute("aria-expanded", "false");
    if (UP) return toUp({rh: "go", i: +x.getAttribute("data-i")});
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({top: h.getBoundingClientRect().top + window.scrollY - 16, behavior: reduce ? "auto" : "smooth"});
    SH.hidden = true; FAB.setAttribute("aria-expanded", "false");
  }
  TOCL.addEventListener("click", go); SHL.addEventListener("click", go);
  FAB.addEventListener("click", function () { SH.hidden = !SH.hidden; FAB.setAttribute("aria-expanded", String(!SH.hidden)); if (!SH.hidden) { ACT = -2; spy(); } });
  root.getElementById("up").addEventListener("click", function () { if (UP) toUp({rh: "top"}); else window.scrollTo({top: 0}); SH.hidden = true; });
  // what the upload's frame reports (untrusted — the uploaded page's own scripts can post too: shape-checked, text only)
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function col(v) { v = typeof v === "string" ? v.trim() : ""; return v.length <= 80 && /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|color)\([0-9a-z.,%\s\/+-]*\))$/i.test(v) ? v : ""; }
  if (UP) window.addEventListener("message", function (e) {
    var f = document.getElementById("rh-up"), d = e.data;
    if (!f || e.source !== f.contentWindow || !d || typeof d !== "object" || d.rh !== "up1") return;
    RM.y = num(d.y);
    if (Array.isArray(d.tops)) RM.tops = d.tops.slice(0, 120).map(num);
    var full = Array.isArray(d.heads);
    if (full) RM.heads = d.heads.slice(0, 120).filter(function (h) { return h && typeof h.t === "string" && h.t; }).map(function (h) { return {g: h.g === 3 ? 3 : 2, t: h.t.slice(0, 120)}; });
    if (Array.isArray(d.hd)) RM.hd = d.hd.slice(0, 200).filter(function (x) { return x && typeof x.o === "string" && x.o && typeof x.t === "string"; })
      .map(function (x) { return {tag: /^H[1-4]$/.test(x.g) ? x.g : "", o: x.o.slice(0, 200), t: x.t.slice(0, 200)}; });
    if ("box" in d) RM.box = d.box && typeof d.box === "object" ? {l: num(d.box.l), r: num(d.box.r), R: num(d.box.R)} : null;
    if ("vw" in d) RM.vw = num(d.vw);
    if (d.look && typeof d.look === "object") RM.look = {bg: col(d.look.bg), ink: col(d.look.ink), acc: col(d.look.acc)};
    if (!RM.seen) {   // the frame is up: hand it the hub theme and any renamed headings sent before it listened
      RM.seen = true;
      toUp({rh: "theme", t: document.documentElement.getAttribute("data-theme") || ""});
      if (NM) toUp({rh: "names", m: NM});
    }
    if (full) adopt(); else { onScroll(); spy(); }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !SH.hidden) { SH.hidden = true; FAB.focus(); } });
  var ticking = false;
  window.addEventListener("scroll", function () { if (ticking) return; ticking = true; requestAnimationFrame(function () { ticking = false; onScroll(); spy(); }); }, {passive: true});
  document.addEventListener("toggle", function () { setTimeout(buildToc, 30); }, true);   // <details> open/close changes what is visible
  var mo = null, moT = 0;
  try { mo = new MutationObserver(function (recs) {
    if (recs.every(function (r) { return host.contains(r.target); })) return;
    clearTimeout(moT); moT = setTimeout(buildToc, 400);
  }); mo.observe(document.body, {childList: true, subtree: true}); } catch (e) {}
  // Borrow the page's colours once its own CSS has applied: body / --accent / links (not its font).
  function adopt() {
    if (UP) {
      var L = RM.look || {};
      ["bg", "ink", "acc"].forEach(function (k) { if (L[k]) host.style.setProperty("--" + k, L[k]); });
      if (L.bg) document.body.style.background = L.bg;
    } else try {
      var el = document.querySelector("main p, article p, .wrap p, p, h1, h2") || document.body;
      var cs = getComputedStyle(el), bs = getComputedStyle(document.body);
      // (the font is not borrowed: the bar keeps the hub's type on every page — 사용자 10-16 "목차·페이지 구분 글꼴이 판마다 다름")
      var bg = bs.backgroundColor;
      if (!bg || /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) bg = getComputedStyle(document.documentElement).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) host.style.setProperty("--bg", bg);
      host.style.setProperty("--ink", cs.color || bs.color);
      var acc = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || getComputedStyle(document.body).getPropertyValue("--accent")).trim();
      if (!acc) { var a = document.querySelector("main a[href], article a[href], p a[href]"); if (a) acc = getComputedStyle(a).color; }
      if (acc) host.style.setProperty("--acc", acc);
      if (host.parentElement === document.body) {   // full-bleed: undo the body's own padding/margin around the bar
        var px = function (v) { return parseFloat(v) || 0; };
        var t = px(bs.paddingTop) + px(bs.marginTop), l = px(bs.paddingLeft) + px(bs.marginLeft), r = px(bs.paddingRight) + px(bs.marginRight);
        host.style.margin = (-t) + "px " + (-r) + "px " + px(bs.paddingTop) + "px " + (-l) + "px";
      }
    } catch (e) {}
    align();
    var T = root.getElementById("tabs"), on = root.querySelector(".tab.on");   // centre the current tab inside the bar only (never scroll the page)
    if (T && on) T.scrollLeft = Math.max(0, on.offsetLeft - T.clientWidth / 2 + on.offsetWidth / 2);
    if (T) T.dispatchEvent(new Event("scroll"));
    buildToc();
  }
  // Line the bar's content up with the page's own content frame: the widest ancestor of the page heading that is
  // still narrower than the window. Background and rule stay full width; nothing found → 16 px (as on phones).
  function align() {
    if (UP) {   // the frame's content column, in this window's coordinates (the frame starts at x = 0)
      var b = RM.box, hr0 = host.getBoundingClientRect();
      if (!b) { host.style.removeProperty("--pl"); host.style.removeProperty("--pr"); BOXR = RM.vw || document.documentElement.clientWidth; return; }
      BOXR = b.R;
      host.style.setProperty("--pl", Math.max(16, Math.round(b.l - hr0.left)) + "px");
      host.style.setProperty("--pr", Math.max(16, Math.round(hr0.right - b.r)) + "px");
      return;
    }
    try {
      var a = document.querySelector("h1") || document.querySelector("main p, article p, .wrap p, p");
      var el = a, box = null, vw = document.documentElement.clientWidth;
      while (el && el !== document.body && el !== document.documentElement) {
        var rr = el.getBoundingClientRect();
        if (rr.width > 0 && rr.width < vw - 8) box = el;
        el = el.parentElement;
      }
      if (!box) { host.style.removeProperty("--pl"); host.style.removeProperty("--pr"); BOXR = vw; return; }
      var br = box.getBoundingClientRect(), bc = getComputedStyle(box), hr = host.getBoundingClientRect();
      BOXR = br.right;
      var L = br.left + (parseFloat(bc.paddingLeft) || 0) - hr.left, Rr = hr.right - (br.right - (parseFloat(bc.paddingRight) || 0));
      host.style.setProperty("--pl", Math.max(16, Math.round(L)) + "px");
      host.style.setProperty("--pr", Math.max(16, Math.round(Rr)) + "px");
    } catch (e) {}
  }
  window.addEventListener("resize", function () { align(); buildToc(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", adopt); else adopt();
  window.addEventListener("load", adopt);
  window.addEventListener("rh-theme", function () { setTimeout(adopt, 30); });
  if (window.matchMedia) { try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", adopt); } catch (e) {} }
})();
