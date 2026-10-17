#!/usr/bin/env python3
"""Research hub — the cloud step (GitHub Actions, .github/workflows/hub.yml): uploads and boards (판) go live in about a
minute, with no build PC and no Claude session (사용자 10-16 01:2x).

It holds ONE secret, K_u = HKDF(K, "uploads") (RH_UP_KEY, base64) — never K, so it cannot open the agents' pages.
  inbox   ctl:inbox/<id>.enc   sealed HKDF(K_u,"inbox")   the owner's browser (and the PC, for share expiry) writes them
  state   up:state.enc         sealed HKDF(K_u,"state")   boards · uploads · epochs · handled inbox ids
  store   up:store/<sid>.enc   sealed HKDF(K_u,"store")   each uploaded HTML as sent: gzip JSON {name, html}
  catalog main:docs/uc.enc     sealed HKDF(K_u,"catalog") written by the PC: manifest projects, their sections, used sections
  site    main docs/ + u/<h>/index.html (K_p = HKDF(K_u, "page:<pdir>#<epoch>"), shell cfg ku=1) + u.enc (HKDF(K_u,"list"))
Ops (applied in the order they were sent):
  add   {project, category, title, name, html[, slug]}   (slug = new version of that upload — same address, same sharing)
  del   {project, category, slug}                       unlist (the stored file stays — the PC mirror keeps its copy)
  board {project, title, stages:[{key,label}], new?, del?}   a board made in the hub / extra sections of a manifest project
  epoch {pdir, epoch}                                   a narrowed share of an upload page → re-encrypt (never lowers)
  names {set: {key: text|""}}                           renames (b: board · s: section · p: page · h: heading — see hub_build);
                                                        a board / section / upload made in the hub takes it into its own row
usage: hub_cloud.py check   --repo <main checkout>                    (schedule: go only when the inbox holds something)
       hub_cloud.py prepare --repo <main checkout> --out <site dir>   (fetch · apply · push up · assemble)
       hub_cloud.py finish  --repo <main checkout>                    (after the deploy: drop handled inbox files)
The run logs are public: they carry counts and op types only."""
import argparse
import base64
import datetime as dt
import gzip
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hub_build as HB  # noqa: E402  (crypto, page shell, nav bar, upload host — the same code the PC runs)

KST = dt.timezone(dt.timedelta(hours=9))
ID_RE = HB.ID_RE
EMPTY = {"v": 1, "boards": [], "uploads": [], "epochs": {}, "done": {}, "rej": [], "names": {}}
NAME_RE = re.compile(r"(b:{i}|s:{i}/{i}|p:{i}/{i}/{i}|h:{i}/{i}/{i}#.{{1,200}})".format(i=r"[a-z0-9][a-z0-9_-]{0,39}"), re.S)
NAMES_MAX = 500


def say(msg):
    print(f"[cloud] {msg}", flush=True)


def git(repo, *a, inp=None, check=True, env=None):
    return subprocess.run(["git", "-C", str(repo), *a], input=inp, capture_output=True, check=check,
                          env={**os.environ, **HB.GIT_ENV, **(env or {})})


def fetch(repo, branch):
    r = git(repo, "fetch", "-q", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}", check=False)
    if r.returncode == 0:
        return git(repo, "rev-parse", f"refs/remotes/origin/{branch}").stdout.decode().strip()
    if b"couldn't find remote ref" in r.stderr:
        return ""
    raise SystemExit(f"[cloud] FAIL fetch {branch}")


def blob(repo, ref, path):
    r = git(repo, "show", f"{ref}:{path}", check=False)
    return r.stdout if r.returncode == 0 else None


def opened(ku, info, data):
    return json.loads(gzip.decompress(HB.open_sealed(HB.hk(ku, info), data)))


def sealed(ku, info, obj):
    return HB.seal(HB.hk(ku, info), gzip.compress(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8"), mtime=0))


def orphan_push(repo, branch, base, files: dict, keep_base: bool, drops=()):
    """One orphan commit (no history — uploaded files never pile up) = (base tree if keep_base) + files − drops,
    pushed with a lease on the fetched head (someone wrote in between → refused, nothing lost)."""
    gd = pathlib.Path(git(repo, "rev-parse", "--absolute-git-dir").stdout.decode().strip())
    env = {"GIT_INDEX_FILE": str(gd / f"rh-{branch}.index")}
    try:
        if keep_base and base:
            git(repo, "read-tree", base, env=env)
        else:
            git(repo, "read-tree", "--empty", env=env)
        for path, data in files.items():
            b = git(repo, "hash-object", "-w", "--stdin", inp=data, env=env).stdout.decode().strip()
            git(repo, "update-index", "--add", "--cacheinfo", f"100644,{b},{path}", env=env)
        for path in drops:
            git(repo, "update-index", "--force-remove", path, env=env)
        tree = git(repo, "write-tree", env=env).stdout.decode().strip()
        c = git(repo, "commit-tree", tree, "-m", branch, env=env).stdout.decode().strip()
    finally:
        (gd / f"rh-{branch}.index").unlink(missing_ok=True)
    r = git(repo, "push", "-q", f"--force-with-lease=refs/heads/{branch}:{base}", "origin", f"{c}:refs/heads/{branch}", check=False)
    return r.returncode == 0


def sections_of(cat, boards):
    """project → [{key, label, own}] — a manifest project: its manifest sections, then sections added in the hub;
    a board made in the hub: only its own (the same rule as hub_build.sections_of)."""
    out = {p["id"]: [{"key": s["key"], "label": s["label"], "own": False} for s in p.get("sections", [])] for p in cat["projects"]}
    for r in boards:
        if r["kind"] == "project" and r["project"] not in out:
            out[r["project"]] = []
    for r in boards:
        if r["kind"] == "stage" and r["project"] in out and r["category"] not in {s["key"] for s in out[r["project"]]}:
            out[r["project"]].append({"key": r["category"], "label": r["title"], "own": True})
    return out


def row(kind, project, category, title, desc="", now=""):
    return {"category": category, "project": project, "slug": "-", "title": title, "desc": desc, "source": "-", "kind": kind,
            "claude_url": "-", "updated": now}


def apply(st, cat, m, files, now):
    """One inbox message → st (and files: sid → sealed store blob). Returns '' or why it was refused (shown to the owner)."""
    op, proj, catg = m.get("op"), str(m.get("project", "")), str(m.get("category", ""))
    mp = {p["id"] for p in cat["projects"]}
    secs = sections_of(cat, st["boards"])
    used = set(next((p.get("used", []) for p in cat["projects"] if p["id"] == proj), [])) | {u["category"] for u in st["uploads"] if u["project"] == proj}
    boards = st["boards"]
    if op == "board":
        is_bd = any(r["kind"] == "project" and r["project"] == proj for r in boards)
        if not re.fullmatch(ID_RE, proj):
            return "판 이름(주소)이 잘못됨"
        if m.get("del"):
            if not is_bd:
                return "허브에서 만든 판만 지울 수 있음"
            if used:
                return "페이지가 있는 판은 지울 수 없음"
            st["boards"] = [r for r in boards if r["project"] != proj]
            return ""
        want, keys = [], set()
        for s in m.get("stages") or []:
            k, lab = str((s or {}).get("key", "")), HB.one_line((s or {}).get("label"), 60)
            if not re.fullmatch(ID_RE, k) or not lab or k in keys:
                return "섹션 이름이 잘못됨"
            keys.add(k)
            want.append((k, lab))
        fixed = {s["key"] for s in secs.get(proj, []) if not s["own"]}
        gone = {s["key"] for s in secs.get(proj, []) if s["own"]} - keys
        title = HB.one_line(m.get("title"), 80)
        if m.get("new") and (proj in mp or is_bd):
            return "같은 주소의 판이 이미 있음"
        if proj not in mp and not is_bd and not m.get("new"):
            return "없는 판"
        if proj not in mp and not title:
            return "판 이름이 비어 있음"
        if keys & fixed:
            return "에이전트가 만든 섹션과 겹침"
        if gone & used:
            return "페이지가 있는 섹션은 지울 수 없음"
        if proj not in mp:
            if is_bd:
                for r in boards:
                    if r["kind"] == "project" and r["project"] == proj:
                        r.update(title=title, updated=now)
            else:
                boards.append(row("project", proj, "-", title, now=now))
        st["boards"] = [r for r in boards if not (r["kind"] == "stage" and r["project"] == proj)] + [
            row("stage", proj, k, lab, now=now) for k, lab in want]
        return ""
    if op == "names":
        sets = m.get("set") if isinstance(m.get("set"), dict) else {}
        if not sets or len(sets) > 200:
            return "바꿀 이름이 없음"
        for k, v in sets.items():
            k, v = str(k), HB.one_line(v, 120)
            if not NAME_RE.fullmatch(k):
                return "잘못된 이름 키"
            kind, _, rest = k.partition(":")
            own = None
            if kind == "b":
                own = next((r for r in st["boards"] if r["kind"] == "project" and r["project"] == rest), None)
            elif kind == "s":
                pj, _, sk = rest.partition("/")
                own = next((r for r in st["boards"] if r["kind"] == "stage" and r["project"] == pj and r["category"] == sk), None)
            elif kind == "p":
                own = next((u for u in st["uploads"] if f'{u["project"]}/{u["category"]}/{u["slug"]}' == rest), None)
            if own is not None:   # made in the hub: the row itself is renamed (an empty text keeps it)
                if v:
                    own["title"] = v
                st["names"].pop(k, None)
            elif v:
                st["names"][k] = v
            else:
                st["names"].pop(k, None)
        if len(st["names"]) > NAMES_MAX:
            return "바꾼 이름이 너무 많음"
        return ""
    if op == "epoch":
        pdir, e = str(m.get("pdir", "")), m.get("epoch")
        if not isinstance(e, int) or e < 0 or not any(u.get("pdir") == pdir for u in st["uploads"]):
            return "모르는 페이지"
        st["epochs"][pdir] = max(int(st["epochs"].get(pdir, 0)), e)
        return ""
    if op not in ("add", "del") or catg not in {s["key"] for s in secs.get(proj, [])}:
        return f"모르는 판·섹션({proj}/{catg})"
    target = str(m.get("slug") or "")
    if op == "del":
        st["uploads"] = [u for u in st["uploads"] if (u["project"], u["category"], u["slug"]) != (proj, catg, target)]
        return ""
    html_s = m.get("html")
    if not isinstance(html_s, str) or not html_s.strip():
        return "빈 파일"
    if len(html_s.encode("utf-8")) > HB.INBOX_MAX:
        return "파일이 너무 큼"
    old = next((u for u in st["uploads"] if (u["project"], u["category"], u["slug"]) == (proj, catg, target)), None) if target else None
    if old:
        sid = old["sid"]
        old.update(updated=now, size=len(html_s.encode("utf-8")))
        name = old["name"]
    else:
        name = HB.upload_name(m.get("name", ""), secrets.token_hex(3))
        stem, ext = name.rsplit(".", 1)
        taken_names = {(u["project"], u["name"]) for u in st["uploads"]}
        n = 1
        while (proj, name) in taken_names:   # the card shows the name the file is kept under
            n += 1
            name = f"{stem} ({n}).{ext}"
        base = re.sub(r"[^a-z0-9_-]+", "-", stem.lower()).strip("-_")[:40] or "u"
        if not base[0].isalnum():
            base = "u-" + base
        taken = {(u["project"], u["category"], u["slug"]) for u in st["uploads"]}
        slug, n = base, 1
        while (proj, catg, slug) in taken:
            n += 1
            slug = f"{base}-{n}"
        sid = secrets.token_hex(8)
        title = HB.one_line(m.get("title"), 120) or name
        if title == HB.upload_name(m.get("name", ""), "x"):
            title = name
        st["uploads"].append({"project": proj, "category": catg, "slug": slug, "title": title, "name": name, "sid": sid,
                              "updated": now, "size": len(html_s.encode("utf-8"))})
    files[sid] = {"name": name, "html": html_s}
    return ""


def page_of(ku, kid, u, st, cat, store):
    """the published upload page (owner: K → K_u → K_p · link / invite: K_p) — same host frame as the PC built before."""
    pid = f'{u["project"]}/{u["category"]}/{u["slug"]}'
    pdir = u["pdir"]
    epoch = int(st["epochs"].get(pdir, 0))
    kp = HB.hk(ku, f"page:{pdir}#{epoch}")
    raw = store["html"]
    doc = HB.upload_host(u["title"])
    body = HB.upload_body(HB.apply_headings(raw, pid, st["names"]))
    doc = HB.inject_head(doc, '<meta name="robots" content="noindex, nofollow">')
    secs = sections_of(cat, st["boards"])
    rows = {p: [{"category": s["key"], "title": s["label"]} for s in ss] for p, ss in secs.items()}
    pages = [{"project": x["project"], "category": x["category"], "slug": x["slug"], "title": x["title"], "kind": "upload", "source": ""}
             for x in st["uploads"]]
    pdir_of = {f'{x["project"]}/{x["category"]}/{x["slug"]}': x["pdir"] for x in st["uploads"]}
    names = {p["id"]: p["name"] for p in cat["projects"]} | {r["project"]: r["title"] for r in st["boards"] if r["kind"] == "project"}
    # the bar of an upload page: a board made in the hub shows all its sections (an empty one greyed, as on every page);
    # a manifest board only the sections that hold uploads (its agents' pages are not known here — K_u cannot read them)
    hub_made = {r["project"] for r in st["boards"] if r["kind"] == "project"}
    rows = {p: [s for s in ss if p in hub_made or any(x["project"] == p and x["category"] == s["category"] for x in st["uploads"])]
            for p, ss in rows.items()}
    nav_html, nav_full = HB.nav_snippet({"project": u["project"], "category": u["category"], "slug": u["slug"], "title": u["title"]},
                                        pages, rows, pdir_of, names)
    doc = HB.inject_body_top(doc, nav_html)
    hd = [{"o": o, "t": st["names"].get(f"h:{pid}#{o}", o)} for o in HB.headings_of(raw)[:200]]
    own = {"b": any(r["kind"] == "project" and r["project"] == u["project"] for r in st["boards"]),
           "s": any(r["kind"] == "stage" and r["project"] == u["project"] and r["category"] == u["category"] for r in st["boards"])}
    nav_full = json.dumps({**json.loads(nav_full), "sm": "private", "hd": hd, "up": 1, "own": own}, ensure_ascii=False)
    extra = {"p": pdir, "e": epoch, "ku": 1, "b": "body.enc", "n": HB.b64(HB.seal(HB.hk(ku, "meta"), nav_full.encode("utf-8")))}
    return HB.shell_page(kp, kid, "../../", "upload", doc, False, extra), HB.seal_body(kp, body), pid


def prepare(a, ku):
    repo = pathlib.Path(a.repo).resolve()
    now = dt.datetime.now(KST).isoformat(timespec="seconds")
    ctl = fetch(repo, "ctl")
    up = fetch(repo, "up")
    st = json.loads(json.dumps(EMPTY))
    if up:
        b = blob(repo, "refs/remotes/origin/up", "state.enc")
        if b is not None:
            st = {**st, **opened(ku, "state", b)}
    catb = (repo / "docs" / "uc.enc")
    cat = opened(ku, "catalog", catb.read_bytes()) if catb.is_file() else {"projects": []}
    kid = json.loads((repo / "docs" / "hub.json").read_text())["kid"]
    names = [n for n in git(repo, "ls-tree", "--name-only", "refs/remotes/origin/ctl", "inbox/", check=False).stdout.decode().split()
             if re.fullmatch(r"inbox/[0-9a-z]{6,32}\.enc", n)] if ctl else []
    msgs, files, ops = [], {}, {}
    for n in names:
        iid = n[6:-4]
        if iid in st["done"]:
            continue
        try:
            m = opened(ku, "inbox", blob(repo, "refs/remotes/origin/ctl", n))
            msgs.append((str(m.get("at", "")), iid, m))
        except Exception:   # sealed for another key (an old hub tab: HKDF(K, "inbox")) — left for the PC, which re-seals it
            ops["left"] = ops.get("left", 0) + 1
    msgs.sort(key=lambda x: (x[0], x[1]))   # a board made a moment before its first upload exists first
    for _, iid, m in msgs:
        try:
            why = apply(st, cat, m, files, now)
        except Exception as e:
            why = f"처리 실패({type(e).__name__})"
        k = str(m.get("op")) + ("-refused" if why else "")
        ops[k] = ops.get(k, 0) + 1
        if why:
            st["rej"].append({"id": iid, "why": why, "at": now, "t": HB.one_line(m.get("title"), 80)})
        st["done"][iid] = now
    del st["rej"][:-20]
    live = {n[6:-4] for n in names}
    st["done"] = {k: v for k, v in st["done"].items() if k in live}   # ids gone from ctl are forgotten
    # rows whose board / section vanished stay stored but are not published
    secs = sections_of(cat, st["boards"])
    for u in st["uploads"]:
        u["pdir"] = "u/" + HB.hname(ku, f'page:{u["project"]}/{u["category"]}/{u["slug"]}', 16)
    st["epochs"] = {k: v for k, v in st["epochs"].items() if any(u["pdir"] == k for u in st["uploads"])}
    # store: what this run received + what is already there
    store_blobs = {f"store/{sid}.enc": sealed(ku, "store", f) for sid, f in files.items()}
    old_store = set()
    if up:
        old_store = {n for n in git(repo, "ls-tree", "--name-only", "-r", "refs/remotes/origin/up", "store/").stdout.decode().split()}
    # every run commits `up` (state.run changes): its commit is the Pages build version of this deploy — a version must
    # be a commit of the repo, and a new one each time, or Pages keeps serving (and caching) the previous artifact
    st["run"] = f'{os.environ.get("GITHUB_RUN_ID", "local")}.{os.environ.get("GITHUB_RUN_ATTEMPT", "1")}.{now}'
    put = {"state.enc": sealed(ku, "state", st), **store_blobs}
    if not orphan_push(repo, "up", up, put, keep_base=True):
        raise SystemExit("[cloud] FAIL up moved (another run?) — nothing deployed")
    ver = fetch(repo, "up")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"ver={ver}\n")
    # assemble the site: the PC's docs + the upload pages + the list the hub merges
    out = pathlib.Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(repo / "docs", out, ignore=shutil.ignore_patterns(".git"))
    items, built = [], 0
    for u in st["uploads"]:
        if u["category"] not in {s["key"] for s in secs.get(u["project"], [])}:
            continue
        sb = store_blobs.get(f'store/{u["sid"]}.enc') or blob(repo, "refs/remotes/origin/up", f'store/{u["sid"]}.enc')
        if sb is None:
            continue
        page, body, _ = page_of(ku, kid, u, st, cat, opened(ku, "store", sb))
        HB.write_atomic(out / u["pdir"] / "body.enc", body)   # the upload itself (page key) — the shell opens it into a Blob
        HB.write_atomic(out / u["pdir"] / "index.html", page)
        built += 1
        items.append({"project": u["project"], "category": u["category"], "slug": u["slug"], "title": u["title"], "desc": "",
                      "kind": "upload", "pdir": u["pdir"], "epoch": int(st["epochs"].get(u["pdir"], 0)), "href": u["pdir"] + "/",
                      "updated": u["updated"], "size": u.get("size", 0), "name": u["name"]})
    lst = {"built": now, "boards": st["boards"], "items": items, "epochs": {u["pdir"]: int(st["epochs"].get(u["pdir"], 0)) for u in st["uploads"]},
           "rej": st["rej"][-10:], "done": sorted(st["done"]), "names": st["names"]}   # handled inbox ids: the hub ends '게시 대기' as soon as this is live
    HB.write_atomic(out / "u.enc", sealed(ku, "list", lst))
    say("ops " + (" ".join(f"{k}={v}" for k, v in sorted(ops.items())) or "none") + f" · pages {built} · boards {sum(r['kind'] == 'project' for r in st['boards'])}")


def finish(a, ku):
    """after the deploy: handled inbox files leave ctl (so the owner's '게시 대기' ends only when the page is live)."""
    repo = pathlib.Path(a.repo).resolve()
    for attempt in range(4):
        ctl = fetch(repo, "ctl")
        up = fetch(repo, "up")
        if not ctl or not up:
            return say("finish: nothing to drop")
        st = opened(ku, "state", blob(repo, "refs/remotes/origin/up", "state.enc"))
        names = git(repo, "ls-tree", "--name-only", "refs/remotes/origin/ctl", "inbox/", check=False).stdout.decode().split()
        drops = [n for n in names if n[6:-4] in st["done"]]
        if not drops:
            return say("finish: inbox clear")
        if orphan_push(repo, "ctl", ctl, {}, keep_base=True, drops=drops):
            return say(f"finish: dropped {len(drops)}")
        say("finish: ctl moved — retrying")
    raise SystemExit("[cloud] FAIL ctl kept moving — the next run drops them")


def deploy(a):
    """Pages deployment with a build version of its own. actions/deploy-pages uses GITHUB_SHA, and an inbox run has the
    same main commit as the last deploy — GitHub then keeps serving (and caching) the first artifact of that version (seen
    10-16 01:4x). Same API call (POST /pages/deployments with the job's OIDC token), version = this run's `up` commit."""
    import time, urllib.error, urllib.request
    env = os.environ
    ver = a.ver or env["GITHUB_SHA"]
    api = env.get("GITHUB_API_URL", "https://api.github.com") + "/repos/" + env["GITHUB_REPOSITORY"]
    tok = env["GH_TOKEN"]

    def req(method, url, body=None, auth=None):
        r = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                   headers={"Accept": "application/vnd.github+json", "Authorization": auth or f"Bearer {tok}",
                                            "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"})
        try:
            with urllib.request.urlopen(r, timeout=60) as f:
                return json.loads(f.read() or b"{}")
        except urllib.error.HTTPError as e:   # GitHub's own message (no secrets in it) — say which call and why
            raise SystemExit(f"[cloud] FAIL deploy {method} {url.split('?')[0].split('/repos/')[-1][-40:]} → {e.code} {e.read()[:300].decode('utf-8', 'replace')}")
    oidc = req("GET", env["ACTIONS_ID_TOKEN_REQUEST_URL"], auth=f'Bearer {env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]}')["value"]
    d = req("POST", api + "/pages/deployments", {"artifact_id": int(a.artifact_id), "pages_build_version": ver, "oidc_token": oidc})
    did = d.get("id") or str(d.get("status_url", "")).rstrip("/").split("/")[-1]
    for _ in range(120):
        time.sleep(5)
        st = req("GET", f"{api}/pages/deployments/{did}").get("status", "")
        if st == "succeed":
            return say("deployed")
        if st in ("deployment_failed", "deployment_content_failed", "deployment_cancelled", "deployment_lost", "deployment_perms_error", "syncing_files_failed"):
            raise SystemExit(f"[cloud] FAIL deploy {st}")
    raise SystemExit("[cloud] FAIL deploy timed out")


def check(a, ku):
    """schedule runs only work when the inbox holds something this step can open; every other trigger deploys."""
    go = True
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
        repo = pathlib.Path(a.repo).resolve()
        go = False
        if fetch(repo, "ctl"):
            for n in git(repo, "ls-tree", "--name-only", "refs/remotes/origin/ctl", "inbox/", check=False).stdout.decode().split():
                try:
                    opened(ku, "inbox", blob(repo, "refs/remotes/origin/ctl", n))
                    go = True
                    break
                except Exception:
                    pass
    say(f"go={str(go).lower()}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"go={str(go).lower()}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=("check", "prepare", "deploy", "finish"))
    ap.add_argument("--artifact-id", default="")
    ap.add_argument("--ver", default="")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    raw = os.environ.get("RH_UP_KEY", "").strip()
    if not raw:
        raise SystemExit("[cloud] FAIL RH_UP_KEY missing")
    ku = base64.b64decode(raw)
    if len(ku) != 32:
        raise SystemExit("[cloud] FAIL RH_UP_KEY is not 32 bytes")
    try:
        if a.step == "check":
            return check(a, ku)
        if a.step == "deploy":
            return deploy(a)
        prepare(a, ku) if a.step == "prepare" else finish(a, ku)
    except SystemExit:
        raise
    except Exception as e:   # public log: the type only
        raise SystemExit(f"[cloud] FAIL {a.step}: {type(e).__name__}")


if __name__ == "__main__":
    main()
