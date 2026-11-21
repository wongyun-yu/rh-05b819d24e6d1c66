// sw.js 의 ranged() 를 떼어 Node Response 로 잰다 — 200 · 206 · suffix · 열린 끝 · 끝 넘김 · 416.
import fs from "node:fs";
const src = fs.readFileSync(process.argv[2], "utf8");
const i = src.indexOf("function ranged("); const j = src.indexOf("\n}\n", i) + 3;
const ranged = new Function(src.slice(i, j) + "\nreturn ranged;")();
const pt = new Uint8Array(100).map((_, k) => k);
const cases = [[null, 200, null, 100], ["bytes=0-", 206, "bytes 0-99/100", 100], ["bytes=10-19", 206, "bytes 10-19/100", 10],
  ["bytes=-5", 206, "bytes 95-99/100", 5], ["bytes=90-500", 206, "bytes 90-99/100", 10], ["bytes=100-", 416, "bytes */100", 0],
  ["bytes=0-1", 206, "bytes 0-1/100", 2], ["items=0-1", 200, null, 100]];
let bad = 0;
for (const [r, st, cr, len] of cases) {
  const res = ranged(pt, r, "video/mp4");
  const body = new Uint8Array(await res.arrayBuffer());
  const ok = res.status === st && res.headers.get("Content-Range") === cr && body.length === len
    && (st !== 206 || body[0] === parseInt(cr.split(" ")[1]));
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${r} → ${res.status} ${res.headers.get("Content-Range")} len ${body.length} accept=${res.headers.get("Accept-Ranges")}`);
}
console.log(`[SW_RANGE_TEST] ${bad ? "FAIL" : "PASS"} ${cases.length - bad}/${cases.length}`);
process.exit(bad ? 1 : 0);
