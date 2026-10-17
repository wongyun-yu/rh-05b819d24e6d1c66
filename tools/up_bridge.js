/* Research Hub — bridge inside an uploaded page (added by hub_build.upload_host; the uploaded file itself is never edited).
   The upload runs in an iframe sandboxed without allow-same-origin, so the page bar outside (nav.js) cannot read it.
   This tells the bar what every other page gives it directly — headings (목차), scroll position, the content column and
   the page colours — and takes back: go to heading i · to the top · the hub theme · the owner's renamed headings.
   Messages: to the bar {rh: "up1", y, tops[, heads, hd, box, vw, look]} · from the bar {rh: "go"|"top"|"theme"|"names"}. */
(function () {
  "use strict";
  var P = window.parent;
  if (!P || P === window) return;
  var HS = [], last = "", tick = false, moT = 0, mine = false;   // mine: the data-theme on <html> is the hub's, not the page's
  function norm(t) { return String(t || "").replace(/ /g, " ").replace(/\s+/g, " ").trim().slice(0, 200); }
  // same choice as nav.js heads(): visible h2/h3 outside nav / footer / dialogs
  function heads() {
    return Array.prototype.filter.call(document.querySelectorAll("h2, h3"), function (h) {
      return h.getClientRects().length && norm(h.textContent) && !h.closest("nav, footer, dialog, [aria-hidden='true']");
    }).slice(0, 120);
  }
  // same as nav.js align(): the widest ancestor of the page heading that is still narrower than the window
  function box() {
    var a = document.querySelector("h1") || document.querySelector("main p, article p, .wrap p, p"), el = a, b = null, vw = document.documentElement.clientWidth;
    while (el && el !== document.body && el !== document.documentElement) {
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.width < vw - 8) b = el;
      el = el.parentElement;
    }
    if (!b) return null;
    var br = b.getBoundingClientRect(), cs = getComputedStyle(b);
    return {l: Math.round(br.left + (parseFloat(cs.paddingLeft) || 0)), r: Math.round(br.right - (parseFloat(cs.paddingRight) || 0)), R: Math.round(br.right)};
  }
  function clear(c) { return !c || /rgba\(0, 0, 0, 0\)|transparent/.test(c); }
  function look() {
    var el = document.querySelector("main p, article p, .wrap p, p, h1, h2") || document.body, bs = getComputedStyle(document.body);
    var bg = bs.backgroundColor;
    if (clear(bg)) bg = getComputedStyle(document.documentElement).backgroundColor;
    if (clear(bg)) bg = "";
    var acc = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || bs.getPropertyValue("--accent")).trim();
    if (!acc) { var a = document.querySelector("main a[href], article a[href], p a[href]"); if (a) acc = getComputedStyle(a).color; }
    return {bg: bg, ink: getComputedStyle(el).color || bs.color, acc: acc || ""};
  }
  function y() { return Math.round(window.scrollY || document.documentElement.scrollTop || 0); }
  function tops() { return HS.map(function (h) { return Math.round(h.getBoundingClientRect().top); }); }
  function send(full) {
    try {
      var m = {rh: "up1", y: y()};
      if (full) {
        HS = heads();
        var rest = {
          heads: HS.map(function (h) { return {g: h.tagName === "H3" ? 3 : 2, t: norm(h.textContent).slice(0, 120)}; }),
          hd: Array.prototype.map.call(document.querySelectorAll("h1, h2, h3, h4"), function (h) {
            return {g: h.tagName, o: h.getAttribute("data-rh-o") || norm(h.textContent), t: norm(h.textContent)};
          }).filter(function (x) { return x.o; }).slice(0, 200),
          box: box(), vw: document.documentElement.clientWidth, look: look()};
        var k = JSON.stringify(rest);
        if (k !== last) { last = k; for (var f in rest) m[f] = rest[f]; }
      }
      m.tops = tops();
      P.postMessage(m, "*");
    } catch (e) {}
  }
  function later() { clearTimeout(moT); moT = setTimeout(function () { send(true); }, 400); }
  window.addEventListener("message", function (e) {
    if (e.source !== P || !e.data || typeof e.data !== "object") return;
    var d = e.data, reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      if (d.rh === "go" && HS[d.i]) window.scrollTo({top: HS[d.i].getBoundingClientRect().top + y() - 16, behavior: reduce ? "auto" : "smooth"});
      else if (d.rh === "top") window.scrollTo({top: 0});
      else if (d.rh === "theme") {   // the hub's 밝게 / 어둡게 — takes effect where the page's own CSS reads data-theme
        var de = document.documentElement;
        if (d.t === "dark" || d.t === "light") { if (mine || !de.hasAttribute("data-theme")) { de.setAttribute("data-theme", d.t); mine = true; } }
        else if (mine) { de.removeAttribute("data-theme"); mine = false; }   // a theme the page set itself is left alone
        setTimeout(function () { send(true); }, 60);   // new colours → the bar follows
      } else if (d.rh === "names" && d.m && typeof d.m === "object") {   // owner's renamed headings, before the cloud step bakes them
        Array.prototype.forEach.call(document.querySelectorAll("h1, h2, h3, h4"), function (h) {
          var o = h.getAttribute("data-rh-o") || norm(h.textContent), v = d.m[o];
          if (typeof v === "string" && v && norm(h.textContent) !== v) { h.setAttribute("data-rh-o", o); h.textContent = v; }
          else if (!v && h.hasAttribute("data-rh-o") && norm(h.textContent) !== o) h.textContent = o;
        });
        send(true);
      } else if (d.rh === "hello") { last = ""; send(true); }
    } catch (err) {}
  });
  window.addEventListener("scroll", function () { if (tick) return; tick = true; requestAnimationFrame(function () { tick = false; send(false); }); }, {passive: true});
  window.addEventListener("resize", later);
  window.addEventListener("load", function () { send(true); });
  document.addEventListener("toggle", function () { setTimeout(function () { send(true); }, 30); }, true);
  try { new MutationObserver(later).observe(document.documentElement, {childList: true, subtree: true}); } catch (e) {}
  try { document.fonts.ready.then(function () { send(true); }); } catch (e) {}
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { send(true); }); else send(true);
})();
