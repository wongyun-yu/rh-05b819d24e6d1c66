#!/usr/bin/env python3
"""Research hub builder — manifest (TSV) → encrypted static site under <repo>/docs → git commit/push.

No secret lives in this repo. The password is read from --password-file (default ~/.config/research_hub/password).
Every page is AES-256-GCM encrypted with a key derived by PBKDF2-SHA256 (one site-wide salt, so one unlock opens
all pages); page assets are encrypted one by one as <published path>.enc and decrypted by docs/sw.js in the browser.

Manifest columns: category project slug title desc source kind claude_url updated
  kind = static  source = <html>[;files=<files.json>]   (files.json = {published path: source path} — else assets are
                                                          discovered from relative references in the html)
       = db      source = <html>;db=<docs.json>          (claude.ai db pages — the generator's local {path: doc} output is
                                                          embedded and window.claude.use("db") becomes a read-only fake)
       = link    source = <url>                          (no page — the hub links out)
       = project category/slug '-' · title = project name · desc = sub-title (one row per project)
       = stage   category = section key · title = label · project = '-' (the axis of every manifest project without
                 its own rows) or <id> (that project's own sections)
       = upload  source = <html>                         (someone else's HTML, uploaded from the hub — shown inside a
                                                          sandboxed iframe: its scripts never reach the key or storage)
Uploads and boards (10-16 01:3x): the owner's browser drops sealed messages on the `ctl` branch (inbox/<id>.enc) and the
cloud step (tools/hub_cloud.py in GitHub Actions — key K_u = HKDF(K, "uploads") only) applies them, keeps the files on
branch `up` and publishes the upload pages under u/<h>/ plus u.enc (the list the hub merges) within about a minute.
This builder never touches the inbox. It writes docs/uc.enc (manifest projects + sections, for the cloud step) and
mirrors the cloud state: each uploaded HTML into its project's folder (hub_upload_dirs.tsv) under its own file name, and
hub_boards.tsv / hub_uploads.tsv as read-only mirrors. Sections: a manifest project uses its own kind=stage rows or else
the '-' rows; a board made in the hub has only its own sections.
Output (no plaintext names in the public tree — every path is a keyed hash):
        docs/index.html (hub) · docs/p/<h(page)>/index.html (latest only — no archive copies since 10-15 21:4x)
        · docs/_a/<h(p/<h>/<asset path>)>.enc (page assets).
Pages are gzip-compressed before encryption (the browser inflates with DecompressionStream).
Sharing (10-15 20:5x): every page has its own key K_p = HKDF(K, "page:<pdir>#<epoch>") for its latest HTML and its assets,
so one page can be handed out without the site key: a share link carries K_p in the URL fragment, an invite code unwraps
K_p from a per-person slot in the page config. The share settings live
on the `ctl` branch as share.enc (sealed with HKDF(K, "share")) — written by the owner's browser through the GitHub API;
raising a page's epoch (revoking) re-encrypts that page and its assets here. The page bar's full data (other pages'
titles) is sealed with HKDF(K, "meta") so a shared viewer only sees the page they were given.
A page whose content changed is rewritten at most once per --min-gap-min (repo growth guard for tick-fed pages).
Last stdout line: `[HUB_BUILD] changed=<n> pages=<n> commit=<sha|-> pushed=<0|1>` (or a `[HUB_BUILD] FAIL …` line, rc 1).
"""
import argparse
import base64
import datetime as dt
import gzip
import hmac
import html as html_mod
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hub_media  # noqa: E402
# GSAI 구성 · 규모 거름 — 단일 소유자는 허브 폴더(레포 밖 · git 에 안 실림)의 hub_redact.py. 없으면 죽는다(fail closed — 거름 없이 올리지 않는다)
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
try:
    import hub_redact  # noqa: E402
except ModuleNotFoundError:
    # 배포 러너(GitHub Actions · hub_cloud)는 PC 에서 이미 거르고 암호화한 사이트만 옮긴다 — 거름 모듈이 없어도 된다.
    # PC 에서는 그대로 죽는다(fail closed). 러너에서 거름 함수를 부르면 None 속성 오류로 크게 죽는다.
    # (10-20 01:13 이 import 가 들어온 뒤 러너가 76 회 연속 실패 — 사이트가 00:41 판에 멈췄다)
    if not os.environ.get("GITHUB_ACTIONS"):
        raise
    hub_redact = None
REDACTED = {"n": 0}

ITER = 310_000
HEAD = ["category", "project", "slug", "title", "desc", "source", "kind", "claude_url", "updated"]
ASSET_EXT = {"jpg", "jpeg", "png", "webp", "gif", "svg", "mp4", "webm", "mov", "json", "tsv", "csv", "txt", "md", "log",
             "js", "css", "glb", "gltf", "obj", "ply", "pdf", "wasm", "bin"}
MAX_ASSET = 95 * 1024 * 1024
TOOLS = pathlib.Path(__file__).resolve().parent
KST = dt.timezone(dt.timedelta(hours=9))
UI_V = hashlib.sha256((TOOLS / "rh-ui.js").read_bytes()).hexdigest()[:10]   # rh-ui.js?v=… — Pages caches scripts 10 min
TPL_SHA = hashlib.sha256((TOOLS / "shell.html").read_bytes() + (TOOLS / "nav.js").read_bytes() + (TOOLS / "up_bridge.js").read_bytes()
                         + UI_V.encode()).hexdigest()


def die(msg):
    print(f"[HUB_BUILD] FAIL {msg}")
    sys.exit(1)


# 10-18 (사내 보안 점검 — 공개 저장소의 평문에 프로젝트 이름): a word list that must never appear in plaintext in a published
# tree. The list is kept outside the repo (this file is published), one word per line, '#' = comment. No list → no publish.
REDACT_FILE = "~/.config/research_hub/redact.txt"
REDACT = None
B64_RUN = re.compile(rb"[A-Za-z0-9+/=]{200,}")   # sealed payloads — skipped so ciphertext cannot match a word by chance


def redact_words(path: str) -> list:
    p = pathlib.Path(path).expanduser()
    try:
        w = [x.strip().lower() for x in p.read_text(encoding="utf-8").splitlines() if x.strip() and not x.lstrip().startswith("#")]
    except OSError:
        w = []
    if not w:
        die(f"plaintext guard: no word list at {p} — refusing to publish (fail closed)")
    return w


def plain_guard(rp: pathlib.Path, words: list):
    """Every path, and every file that is not *.enc, of the tree about to be committed is searched case-insensitively for
    the word list. A hit stops the build before anything is committed or pushed (file:line in the local log only)."""
    hits = []
    for f in git(rp, "ls-files", "-z").stdout.split("\0"):
        if not f:
            continue
        lf = f.lower()
        if any(w in lf for w in words):
            hits.append(f + " (path)")
        if lf.endswith(".enc"):
            continue
        try:
            data = (rp / f).read_bytes()
        except OSError:
            continue
        for n, line in enumerate(B64_RUN.sub(b" ", data).lower().split(b"\n"), 1):
            if any(w.encode("utf-8") in line for w in words):
                hits.append(f"{f}:{n}")
    if hits:
        die(f"plaintext guard: a listed word in {', '.join(hits[:8])}{' …' if len(hits) > 8 else ''} ({rp.name}) — nothing committed")


def derive(pw: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(pw.encode())


def hname(key: bytes, path: str, n: int = 24) -> str:
    """Opaque public name: keyed SHA-256 (the browser computes the same from the unlocked key — sw.js)."""
    return hashlib.sha256(key + path.encode("utf-8")).hexdigest()[:n]


def seal(key: bytes, data: bytes) -> bytes:
    """AES-256-GCM with a synthetic IV = HMAC(key, data)[:12]: same plaintext → same bytes (no churn in git, and an
    archive copy of the latest page is the same blob); different plaintexts never share an IV (2^-96)."""
    iv = hmac.new(key, b"iv" + data, hashlib.sha256).digest()[:12]
    return iv + AESGCM(key).encrypt(iv, data, None)


def hk(key: bytes, info: str) -> bytes:
    """Sub-key of the content key K (HKDF-SHA256, salt 'rh') — shell.html · sw.js · rh-ui.js derive the same."""
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"rh", info=info.encode("utf-8")).derive(key)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def norm_code(code: str) -> str:
    return re.sub(r"[^0-9A-Z]", "", code.upper())


def invite_slot(kp: bytes, pdir: str, iid: str, code: str) -> str:
    """K_p wrapped for one invited person: PBKDF2(code, 'rh-inv:<pdir>:<id>') — rh-ui.js builds the same slot."""
    kek = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=f"rh-inv:{pdir}:{iid}".encode(), iterations=ITER).derive(
        norm_code(code).encode())
    return b64(seal(kek, kp))


SHARE_MODES = ("private", "invite", "link")


def load_share(repo: pathlib.Path, key: bytes, state: dict, push: bool) -> dict:
    """Share settings = origin ctl:share.enc (sealed with hk(K,'share'), random IV — the browser writes it).
    A failed fetch keeps the last good copy (state 'share') so a network blip never drops invite slots."""
    empty = {"v": 1, "pages": {}}
    try:
        f = subprocess.run(["git", "-C", str(repo), *PUSH_CRED, "fetch", "-q", "origin", "+refs/heads/ctl:refs/remotes/origin/ctl"],
                           capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print("[hub] share fetch timed out — keeping last copy", file=sys.stderr)
        return state.get("share", empty)
    if f.returncode != 0:
        if "couldn't find remote ref" in f.stderr and push:
            try:
                make_ctl(repo, key, empty)
            except Exception as e:   # never fail the tick over this — the next build tries again
                print(f"[hub] ctl branch create failed: {e}", file=sys.stderr)
            return state.get("share", empty)
        print(f"[hub] share fetch failed — keeping last copy: {f.stderr.strip()[-160:]}", file=sys.stderr)
        return state.get("share", empty)
    blob = subprocess.run(["git", "-C", str(repo), "show", "refs/remotes/origin/ctl:share.enc"], capture_output=True)
    if blob.returncode != 0:
        return state.get("share", empty)
    try:
        sh = json.loads(open_sealed(hk(key, "share"), base64.b64decode(blob.stdout.strip())))
    except Exception:
        print("[hub] share.enc does not open with this content key — all pages private", file=sys.stderr)
        sh = empty
    sh.setdefault("pages", {})
    state["share"] = sh
    return sh


def make_ctl(repo: pathlib.Path, key: bytes, sh: dict):
    """First run: create the ctl branch (one orphan commit holding share.enc) so the browser can update it."""
    iv = os.urandom(12)
    data = b64(iv + AESGCM(hk(key, "share")).encrypt(iv, json.dumps(sh).encode(), None)).encode()
    blob = subprocess.run(["git", "-C", str(repo), "hash-object", "-w", "--stdin"], input=data, capture_output=True, check=True).stdout.decode().strip()
    tree = subprocess.run(["git", "-C", str(repo), "mktree"], input=f"100644 blob {blob}\tshare.enc\n".encode(),
                          capture_output=True, check=True).stdout.decode().strip()
    c = subprocess.run(["git", "-C", str(repo), "commit-tree", tree, "-m", "ctl"], capture_output=True, text=True, check=True, env=GIT_ENV).stdout.strip()
    p = subprocess.run(["git", "-C", str(repo), *PUSH_CRED, "push", "-q", "origin", f"{c}:refs/heads/ctl"], capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        print(f"[hub] ctl branch create failed: {p.stderr.strip()[-160:]}", file=sys.stderr)
    else:
        git(repo, "update-ref", "refs/remotes/origin/ctl", c)


def _expired(iso, now) -> bool:
    try:
        return bool(iso) and dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00")) <= now
    except ValueError:
        return False


def apply_expiry(repo: pathlib.Path, key: bytes, sh: dict, now, write: bool) -> dict:
    """Expiry (10-15 21:3x): a link past link_exp falls back to the invite list (or private) and an invite past its exp
    is dropped; either way the page gets a new epoch, so this build re-encrypts it and the expired link / code stops
    opening it. The result is committed on top of the fetched ctl head (no force — if the owner's browser saved in
    between, the push is refused and nothing is applied; the next build tries again), so browser and build agree."""
    changed = []
    out = json.loads(json.dumps(sh))
    for pdir, p in out.get("pages", {}).items():
        rot = False
        if p.get("mode") == "link" and _expired(p.get("link_exp"), now):
            p["mode"] = "invite" if any(not _expired(i.get("exp"), now) for i in p.get("invites", [])) else "private"
            p.pop("link_exp", None)
            p["link_expired_at"] = now.isoformat(timespec="seconds")
            rot = True
        gone = [i for i in p.get("invites", []) if _expired(i.get("exp"), now)]
        if gone:
            p["invites"] = [i for i in p["invites"] if i not in gone]
            p.setdefault("expired", []).extend({"name": i.get("name", ""), "at": now.isoformat(timespec="seconds")} for i in gone)
            p["expired"] = p["expired"][-20:]
            rot = rot or p.get("mode") == "invite"   # in link mode the link still opens the page — no new key needed
        if rot:
            p["epoch"] = int(p.get("epoch", 0) or 0) + 1
        if rot or gone:
            changed.append(pdir)
    if not changed or not write:
        return sh
    iv = os.urandom(12)
    data = b64(iv + AESGCM(hk(key, "share")).encrypt(iv, json.dumps(out).encode(), None)).encode()
    puts = {"share.enc": data}
    # upload pages (u/…) are encrypted by the cloud step — tell it the new epoch through the inbox
    ups = [pd for pd in changed if pd.startswith("u/") and out["pages"][pd].get("epoch") != sh.get("pages", {}).get(pd, {}).get("epoch")]
    for pd in ups:
        iid = os.urandom(8).hex()[:12]
        m = {"v": 1, "id": iid, "at": now.isoformat(timespec="seconds"), "op": "epoch", "pdir": pd, "epoch": int(out["pages"][pd]["epoch"])}
        puts[f"inbox/{iid}.enc"] = seal(hk(hk(key, "uploads"), "inbox"), gzip.compress(json.dumps(m).encode(), mtime=0))
    if not ctl_write(repo, puts, [], "expire"):
        print("[hub] expiry not applied this build — the next build tries again", file=sys.stderr)
        return sh
    if ups:
        dispatch_cloud(repo)
    print(f"[hub] expired shares applied: {','.join(changed)}", file=sys.stderr)
    return out


def dispatch_cloud(repo: pathlib.Path):
    """wake the cloud step (GitHub Actions, repository_dispatch 'inbox') — best effort, its schedule catches a miss."""
    try:
        url = git(repo, "remote", "get-url", "origin").stdout.strip()
        m = re.search(r"github\.com[:/]([^/]+/[^/.]+)", url)
        if m:
            subprocess.run(["gh", "api", "-X", "POST", f"repos/{m.group(1)}/dispatches", "-f", "event_type=inbox"], capture_output=True, timeout=30)
    except Exception:
        pass


def ctl_write(repo: pathlib.Path, puts: dict, drops: list, msg: str) -> bool:
    """Write the ctl branch: the fetched tree + puts ({path: bytes}) − drops, as ONE orphan commit (the branch keeps no
    history, so uploaded files do not pile up in the repo), pushed with a lease on the fetched head — if the owner's
    browser wrote in between, the push is refused, nothing is lost, and the next build tries again."""
    base = git(repo, "rev-parse", "-q", "--verify", "refs/remotes/origin/ctl", check=False).stdout.strip()
    if not base:
        return False
    gd = pathlib.Path(git(repo, "rev-parse", "--absolute-git-dir").stdout.strip())
    env = dict(GIT_ENV, GIT_INDEX_FILE=str(gd / "rh-ctl.index"))
    run = lambda *a, inp=None: subprocess.run(["git", "-C", str(repo), *a], input=inp, capture_output=True, check=True, env=env)
    try:
        run("read-tree", base)
        for path, data in puts.items():
            blob = run("hash-object", "-w", "--stdin", inp=data).stdout.decode().strip()
            run("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}")
        for path in drops:
            run("update-index", "--force-remove", path)
        tree = run("write-tree").stdout.decode().strip()
        c = run("commit-tree", tree, "-m", msg).stdout.decode().strip()
        r = subprocess.run(["git", "-C", str(repo), *PUSH_CRED, "push", "-q", f"--force-with-lease=refs/heads/ctl:{base}", "origin",
                            f"{c}:refs/heads/ctl"], capture_output=True, text=True, timeout=180)
    except Exception as e:
        print(f"[hub] ctl write failed: {e}", file=sys.stderr)
        return False
    finally:
        (gd / "rh-ctl.index").unlink(missing_ok=True)
    if r.returncode != 0:
        print(f"[hub] ctl moved — not written this build: {r.stderr.strip()[-120:]}", file=sys.stderr)
        return False
    git(repo, "update-ref", "refs/remotes/origin/ctl", c)
    return True


# ---- uploads (10-15 23:xx) ------------------------------------------------------------------------------------------
INBOX_MAX = 60 * 1024 * 1024


def one_line(s, n):
    return re.sub(r"[\t\r\n]+", " ", str(s or "")).strip()[:n]


ID_RE = r"[a-z0-9][a-z0-9_-]{0,39}"


def manifest_projects(rows):
    return list(dict.fromkeys([r["project"] for r in rows if r["kind"] == "project"] + [r["project"] for r in rows if r["kind"] in PAGE_KINDS]))


def sections_of(rows, boards):
    """project → its sections (stage rows, display order, each with "own" = made in the hub).
    A manifest project takes the manifest stage rows whose project column names it — or, without any, the '-' rows (the
    CVPR'27 axis). A board made in the hub (hub_boards.tsv) has only its own sections. Sections added in the hub to a
    manifest project come after its manifest sections."""
    out = {}
    glob = [r for r in rows if r["kind"] == "stage" and r["project"] == "-"]
    for p in manifest_projects(rows):
        own = [r for r in rows if r["kind"] == "stage" and r["project"] == p]
        out[p] = [dict(r, own=False) for r in (own or glob)]
    for r in boards:
        if r["kind"] == "project":
            out.setdefault(r["project"], [])
    for r in boards:
        if r["kind"] == "stage" and r["project"] in out and r["category"] not in {s["category"] for s in out[r["project"]]}:
            out[r["project"]].append(dict(r, own=True))
    return out


def upload_name(name: str, iid: str) -> str:
    """the file name the sender gave (no folders, no control characters) — the saved file keeps it (10-16 사용자)."""
    n = re.sub(r"[\x00-\x1f\x7f/\\:*?\"<>|]+", " ", pathlib.PurePosixPath(str(name).replace("\\", "/")).name).strip().lstrip(".").strip()
    if not re.search(r"\.html?$", n, flags=re.I):
        n = (n or f"upload-{iid[:6]}") + ".html"
    stem, ext = n.rsplit(".", 1)
    return stem[:100].strip() + "." + ext


def migrate_inbox(repo: pathlib.Path, key: bytes, state: dict, write: bool):
    """An inbox file sealed with the pre-10-16 key HKDF(K, "inbox") (a hub tab opened before the cloud step went live)
    cannot be opened by the cloud step (it holds K_u only). The PC holds K: re-seal it with HKDF(K_u, "inbox") under a new
    id (same message, same 'at') and wake the cloud step — nothing sent from an old tab is lost. A file that opens with
    neither key is dropped after 24 h."""
    ku = hk(key, "uploads")
    names = [n for n in git(repo, "ls-tree", "--name-only", "refs/remotes/origin/ctl", "inbox/", check=False).stdout.split()
             if re.fullmatch(r"inbox/[0-9a-z]{6,32}\.enc", n)]
    bad = state.setdefault("inbox_bad", {})
    now = time.time()
    puts, drops = {}, []
    for n in names:
        b = subprocess.run(["git", "-C", str(repo), "show", f"refs/remotes/origin/ctl:{n}"], capture_output=True).stdout
        try:
            open_sealed(hk(ku, "inbox"), b)
            continue   # the cloud step's own
        except Exception:
            pass
        try:
            m = json.loads(gzip.decompress(open_sealed(hk(key, "inbox"), b)))
        except Exception:
            first = bad.setdefault(n, now)
            if now - first > 86400:
                drops.append(n)
            continue
        nid = os.urandom(8).hex()[:14]
        m["id"] = nid
        puts[f"inbox/{nid}.enc"] = seal(hk(ku, "inbox"), gzip.compress(json.dumps(m).encode(), mtime=0))
        drops.append(n)
    for k in [k for k in bad if k not in names]:
        bad.pop(k)
    if (puts or drops) and write:
        if ctl_write(repo, puts, drops, "inbox"):
            print(f"[hub] inbox: re-sealed {len(puts)} old-key message(s) for the cloud step, dropped {len(drops) - len(puts)} unreadable", file=sys.stderr)
            for d in drops:
                bad.pop(d, None)
            if puts:
                dispatch_cloud(repo)


def cloud_sync(repo: pathlib.Path, key: bytes, rows, hubdir: pathlib.Path, state: dict):
    """Uploads and boards live in the cloud step's state (branch `up`, sealed with K_u = HKDF(K, "uploads")).
    This build only (1) mirrors them: each uploaded HTML into its project's folder under its own file name
    (hub_upload_dirs.tsv · default <hub>/uploads/<project>) — never deleting, so an unlisted file stays —
    and hub_boards.tsv / hub_uploads.tsv as read-only mirrors; (2) leaves the catalog the cloud step needs:
    docs/uc.enc = the manifest projects, their sections and which sections hold pages (no page titles).
    Never fatal: a failed fetch keeps the last mirror. Returns the owner's renames (state "names" — the last good copy
    when the cloud state cannot be read), which this build bakes into what a shared viewer sees."""
    ku = hk(key, "uploads")
    secs = sections_of(rows, [])
    names = {r["project"]: r["title"] for r in rows if r["kind"] == "project"}
    cat = {"projects": [{"id": p, "name": names.get(p, p),
                         "sections": [{"key": s["category"], "label": s["title"]} for s in ss],
                         "used": sorted({r["category"] for r in rows if r["kind"] in PAGE_KINDS and r["project"] == p})}
                        for p, ss in secs.items()]}
    write_atomic(repo / "docs" / "uc.enc", seal(hk(ku, "catalog"), gzip.compress(json.dumps(cat, ensure_ascii=False, sort_keys=True).encode(), mtime=0)))
    try:
        f = subprocess.run(["git", "-C", str(repo), *PUSH_CRED, "fetch", "-q", "origin", "+refs/heads/up:refs/remotes/origin/up"],
                           capture_output=True, text=True, timeout=120)
        if f.returncode != 0:
            print("[hub] cloud state not fetched — mirror unchanged", file=sys.stderr)
            return state.get("cloud_names", {})
        sb = subprocess.run(["git", "-C", str(repo), "show", "refs/remotes/origin/up:state.enc"], capture_output=True, check=True).stdout
        st = json.loads(gzip.decompress(open_sealed(hk(ku, "state"), sb)))
    except Exception as e:
        print(f"[hub] cloud state unreadable ({type(e).__name__}) — mirror unchanged", file=sys.stderr)
        return state.get("cloud_names", {})
    dirs = {}
    dp = hubdir / "hub_upload_dirs.tsv"
    for ln in (dp.read_text(encoding="utf-8").splitlines() if dp.is_file() else []):
        if "\t" in ln and not ln.startswith("#"):
            k, v = ln.split("\t", 1)
            dirs[k.strip()] = pathlib.Path(os.path.expanduser(v.strip()))
    ups = []
    for u in st.get("uploads", []):
        d = dirs.get(u["project"]) or (hubdir / "uploads" / u["project"])
        dest = d / upload_name(u.get("name", ""), u["sid"][:6])
        try:
            raw = subprocess.run(["git", "-C", str(repo), "show", f'refs/remotes/origin/up:store/{u["sid"]}.enc'], capture_output=True, check=True).stdout
            html_b = json.loads(gzip.decompress(open_sealed(hk(ku, "store"), raw)))["html"].encode("utf-8")
            if not dest.is_file() or dest.read_bytes() != html_b:
                write_atomic(dest, html_b)
                print(f"[hub] upload mirrored: {dest}", file=sys.stderr)
        except Exception as e:
            print(f"[hub] upload not mirrored ({type(e).__name__}): {dest}", file=sys.stderr)
        ups.append({"category": u["category"], "project": u["project"], "slug": u["slug"], "title": u["title"], "desc": "",
                    "source": str(dest), "kind": "upload", "claude_url": "-", "updated": u.get("updated", "")})
    head = "# 거울(읽기 전용) — 원본은 GitHub 의 클라우드 단계(브랜치 up). 바꾸려면 허브에서 판 편집 · 올리기 · 내리기를 쓴다. hub_build.py 가 빌드마다 다시 쓴다.\n"
    for fn, rws in (("hub_boards.tsv", st.get("boards", [])), ("hub_uploads.tsv", ups)):
        body = head + "\t".join(HEAD) + "\n" + "".join("\t".join(str(r.get(k, "")) for k in HEAD) + "\n" for r in rws)
        fp = hubdir / fn
        if not fp.is_file() or fp.read_text(encoding="utf-8") != body:
            write_atomic(fp, body.encode("utf-8"))
    state["cloud_names"] = st.get("names", {})
    return state["cloud_names"]


# ---- names (10-16 13:xx): the owner renames boards / sections / pages / headings in the hub — a map kept by the cloud step
# (state "names", key → text): b:<project> · s:<project>/<section> · p:<project>/<section>/<slug> · h:<project>/<section>/<slug>#<heading>
# Sources are never edited: overrides are applied when a page is built (headings keep the original in data-rh-o).
HEAD_RE = re.compile(r"<(h[1-4])(\s[^>]*)?>(.*?)</\1\s*>", re.I | re.S)
SCRIPT_RE = re.compile(r"(<script\b.*?</script\s*>|<style\b.*?</style\s*>|<template\b.*?</template\s*>|<!--.*?-->)", re.I | re.S)


def head_norm(inner_html: str) -> str:
    """a heading's text as the browser's textContent gives it: tags out, entities decoded, nbsp → space, spaces collapsed."""
    t = html_mod.unescape(re.sub(r"<[^>]+>", "", inner_html)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", t).strip()[:200]


def headings_of(raw: str):
    """h1–h4 texts outside scripts / styles / templates / comments, in order, once each."""
    out = []
    for part in SCRIPT_RE.split(raw):
        if SCRIPT_RE.fullmatch(part or ""):
            continue
        for m in HEAD_RE.finditer(part):
            t = head_norm(m.group(3))
            if t and t not in out:
                out.append(t)
    return out


def apply_headings(raw: str, pid: str, names: dict) -> str:
    """renamed headings of page <pid> → the new text, the original kept in data-rh-o (so a reset can find it)."""
    if not any(k.startswith(f"h:{pid}#") for k in names):
        return raw

    def one(m):
        o = head_norm(m.group(3))
        new = names.get(f"h:{pid}#{o}")
        if not new:
            return m.group(0)
        attrs = re.sub(r'\sdata-rh-o="[^"]*"', "", m.group(2) or "")
        return f'<{m.group(1)}{attrs} data-rh-o="{html_mod.escape(o, quote=True)}">{html_mod.escape(new)}</{m.group(1)}>'
    return "".join(part if SCRIPT_RE.fullmatch(part or "") else HEAD_RE.sub(one, part) for part in SCRIPT_RE.split(raw))


# the host page's own script: open the frame on the Blob the shell made of body.enc (window.__rhUp — a Promise<Blob>).
# A browser that will not show a blob: document in a sandboxed frame falls back to srcdoc (the pre-10-16 path).
UP_HOST_JS = r"""(function () {
  var f = document.getElementById("rh-up"), w = document.getElementById("rh-up-wait"), ok = false, fell = false, B = null, url = "";
  function msg(t) { if (w) w.textContent = t; }
  window.addEventListener("message", function (e) {
    if (!ok && e.source === f.contentWindow && e.data && e.data.rh === "up1") { ok = true; if (w) { w.remove(); w = null; } }
  });
  f.addEventListener("load", function () {
    if (!url) return;
    setTimeout(function () {
      if (ok) { if (url) { URL.revokeObjectURL(url); url = ""; B = null; window.__rhUp = null; } return; }   // shown: let the Blob go
      if (fell || !B) return;
      fell = true;
      B.text().then(function (t) { if (!ok) { f.removeAttribute("src"); f.srcdoc = t; } B = null; });
    }, 1500);
  });
  if (!window.__rhUp) return msg("페이지를 열지 못했습니다.");
  Promise.resolve(window.__rhUp).then(function (b) { B = b; url = URL.createObjectURL(b); f.src = url; },
    function () { msg("페이지 본문을 불러오지 못했습니다. 새로고침해 주세요."); });
})();"""


def upload_host(title: str) -> str:
    """Host page of an uploaded HTML: the file runs inside an iframe sandboxed WITHOUT allow-same-origin (an opaque
    origin), so its scripts cannot read this page's key (window.__rh), storage, cookies or service worker, nor navigate
    the hub. Self-contained files only — relative links have no base inside the frame.
    10-16 18:xx (사용자: "램을 크게 잡아먹는다"): the upload is no longer inside this document. It is a separate sealed
    file beside it (body.enc — upload_body(), same page key); the shell opens it straight into a Blob and the frame
    loads that Blob's URL. Before, a 42 MB upload was held as a JSON text node + its parsed string + the srcdoc
    attribute (2-byte strings, Korean text) + the retained payload — ~1.1 GB for a 42 MB upload.
    data-rh-up on <html> tells nav.js to read the page through up_bridge.js."""
    t = html_mod.escape(title)
    return ('<!doctype html><html lang="ko" data-rh-up><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>{t}</title><style>html,body{{margin:0;height:100%}}body{{display:flex;flex-direction:column;background:#fff}}'
            ':root[data-theme=dark] body{background:#0c0c0e}@media (prefers-color-scheme:dark){:root:not([data-theme=light]) body{background:#0c0c0e}}'
            '#rh-up{flex:1 1 auto;display:block;width:100%;min-height:0;border:0}'
            '#rh-up-wait{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font:13px system-ui,sans-serif;color:#888}</style></head><body>'
            # allow="fullscreen" (10-16, asked by a peer session): a video's full-screen button inside the frame — Chromium/Safari honour it with
            # the sandbox kept; Firefox still refuses it without allow-same-origin (which stays off)
            f'<iframe id="rh-up" title="{t}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"'
            ' allow="fullscreen" allowfullscreen></iframe>'
            '<div id="rh-up-wait" role="status">불러오는 중…</div>'
            f"<script>{UP_HOST_JS}</script></body></html>")


def upload_body(raw: str) -> str:
    """what the frame shows: the uploaded file as is + up_bridge.js after its own markup (the file itself is not edited)."""
    return raw + "\n<script>" + (TOOLS / "up_bridge.js").read_text(encoding="utf-8") + "</script>\n"


def seal_body(key: bytes, html: str) -> bytes:
    """body.enc: gzip + AES-GCM with the page key (the shell opens it into a Blob — never into a string)."""
    return seal(key, gzip.compress(html.encode("utf-8"), mtime=0))


def open_sealed(key: bytes, blob: bytes) -> bytes:
    return AESGCM(key).decrypt(blob[:12], blob[12:], None)


def write_atomic(path: pathlib.Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


PAGE_KINDS = ("static", "db", "link", "upload")


def read_manifest(p: pathlib.Path):
    rows = []
    lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines or lines[0].split("\t") != HEAD:
        die(f"manifest header must be: {' '.join(HEAD)}")
    for n, ln in enumerate(lines[1:], 2):
        f = ln.split("\t")
        if len(f) != len(HEAD):
            die(f"manifest line {n}: {len(f)} fields (want {len(HEAD)})")
        r = dict(zip(HEAD, f))
        if r["kind"] not in ("static", "db", "link", "upload", "project", "stage"):
            die(f"manifest line {n}: unknown kind {r['kind']!r}")
        if r["kind"] in PAGE_KINDS and not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", r["slug"]):
            die(f"manifest line {n}: bad slug {r['slug']!r}")
        r["_line"] = n
        rows.append(r)
    # sections = kind=stage rows, in file order (project column '-' = the axis of every manifest project without its own
    # rows · <id> = that project's own) — single owner: the dashboard and the page nav read them from here
    stage_ids = [(r["project"], r["category"]) for r in rows if r["kind"] == "stage"]
    if not stage_ids or len(stage_ids) != len(set(stage_ids)):
        die("manifest: kind=stage rows missing or duplicated")
    secs = sections_of(rows, [])
    for r in rows:
        keys = [s["category"] for s in secs.get(r["project"], [])]
        if r["kind"] in PAGE_KINDS and r["category"] not in keys:
            die(f"manifest line {r['_line']}: unknown category {r['category']!r} for {r['project']} (sections: {','.join(keys)})")
    ids = [(r["project"], r["category"], r["slug"]) for r in rows if r["kind"] in PAGE_KINDS]
    if len(ids) != len(set(ids)):
        die("manifest: duplicate project/category/slug")
    return rows


def parse_source(src: str):
    parts = src.split(";")
    opts = dict(x.split("=", 1) for x in parts[1:] if "=" in x)
    return pathlib.Path(os.path.expanduser(parts[0])), opts


def wrap_document(s: str) -> str:
    """claude.ai pages are fragments (the platform adds the skeleton) — add the same skeleton here."""
    if re.search(r"<html[\s>]", s[:4000], re.I):
        return s
    return ('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}'
            'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
            '</head><body>' + s + '</body></html>')


# 허브 공통 그림 폭 CSS — 모든 페이지 <head> 맨 앞에 한 번(조정자 10-20 14:4x · 사용자 "그림이 페이지 가로를 넘어가").
# 페이지 CSS 보다 앞에 들어가므로 페이지가 max-width 를 따로 풀지 않는 한 모든 그림은 칸 폭 안이다(hub_lint img_maxw 가 잰다).
# 가로 2,000 px 넘는 띠 그림은 생성기가 <div class="figscroll"> 로 감싼다 — 감싸개 안에서만 원래 크기로 옆으로 민다(글씨 13 px 이상 유지).
BASE_CSS = ('<style id="rh-base">img,video{max-width:100%;height:auto}svg,canvas{max-width:100%}'
            'pre{max-width:100%;overflow-x:auto}code,kbd,samp{overflow-wrap:anywhere}'
            '.figscroll{max-width:100%;overflow-x:auto}.figscroll img{max-width:none!important;width:auto!important}'
            # 좁은 화면(400 px) 가로 넘침(조정자 10-20 14:5x): 제목 · 판 줄은 아무 데서나 줄바꿈, 격자 칸(.card · 판 줄 summary)의 자식은
            # 최소 폭 0 — 넓은 표가 격자 칸을 표 폭으로 늘리던 것(prep 979 px)을 막는다. :where = 특이도 0(페이지 CSS 가 이긴다).
            ':where(h1,h2,h3,h4,.pb-t,.pb-span){overflow-wrap:anywhere}:where(.card,.plan,.pb-item>summary)>*{min-width:0}'
            # 긴 경로 · 이름(공백 없는 낱말)은 넘칠 때만 끊는다(상속) · 옛 생성기의 표 감싸개 .tw 도 .tbl 처럼 표만 옆으로 민다
            ':where(body){overflow-wrap:break-word}:where(.tw){max-width:100%;overflow-x:auto}</style>')


# 허브 공통 낡음 칩 — 생성기가 한눈에 상자에 둔 .rh-gen[data-gen](소유자 research_hub/hub_stamp.py)이 보는 순간 60 분 넘었으면
# '낡음 · N 분 전' 칩을 단다(조정자 10-20 17:0x — 세 페이지 같은 꼴 · 한 페이지만 다른 표시 금지 · 문턱은 이 한 곳).
BASE_JS = ('<style id="rh-stale-css">.rh-stale{font-size:13px;padding:1px 8px;border-radius:999px;background:#fde8e8;color:#9b1c1c;'
           'white-space:nowrap;margin-left:6px}</style><script id="rh-stale">document.addEventListener("DOMContentLoaded",function(){'
           'document.querySelectorAll(".rh-gen[data-gen]").forEach(function(el){var t=Date.parse(el.getAttribute("data-gen"));'
           'if(isNaN(t))return;var m=Math.round((Date.now()-t)/60000);if(m<=60)return;var c=document.createElement("span");'
           'c.className="rh-stale";c.textContent="낡음 · "+(m>=120?Math.round(m/60)+" 시간":m+" 분")+" 전";el.appendChild(c);});});</script>')


def inject_head(doc: str, snippet: str) -> str:
    m = re.search(r"<head[^>]*>", doc, re.I)
    if m:
        return doc[:m.end()] + snippet + doc[m.end():]
    return snippet + doc


def inject_body_top(doc: str, snippet: str) -> str:
    m = re.search(r"<body[^>]*>", doc, re.I)
    if m:
        return doc[:m.end()] + snippet + doc[m.end():]
    m = re.search(r"</head\s*>", doc, re.I)
    return (doc[:m.end()] + snippet + doc[m.end():]) if m else snippet + doc


def nav_snippet(cur, pages, secs, pdir_of, proj_name, mini_title=None):
    """Thin top bar (10-15 20:1x): back · Research Hub · project · stage chips (sub-chips when a stage has several
    pages). Built from the manifest (stages + pages), rendered in a shadow root so page CSS and the bar never mix.
    Links are relative to the site root (every page and archive sits at p/<h>/ → root '../../')."""
    proj = cur["project"]
    st = []
    for sg in secs.get(proj, []):
        ps = [r for r in pages if r["project"] == proj and r["category"] == sg["category"]]
        st.append({"k": sg["category"], "l": sg["title"],
                   "p": [{"s": r["slug"], "t": r["title"],
                          "h": r["source"] if r["kind"] == "link" else pdir_of[f'{proj}/{r["category"]}/{r["slug"]}'] + "/",
                          "x": r["kind"] == "link"} for r in ps]})
    lab = {(p, sg["category"]): sg["title"] for p, ss in secs.items() for sg in ss}
    alls = [{"t": r["title"], "sl": lab.get((r["project"], r["category"]), r["category"]), "pn": proj_name.get(r["project"], r["project"]).split(" · ")[0],
             "pj": r["project"], "c": r["category"],
             "h": r["source"] if r["kind"] == "link" else pdir_of[f'{r["project"]}/{r["category"]}/{r["slug"]}'] + "/",
             "x": r["kind"] == "link"} for r in pages]
    data = {"root": "../../", "proj": proj, "pname": proj_name.get(proj, proj), "cs": cur["category"], "cp": cur["slug"],
            "ct": cur["title"], "st": st, "all": alls, "uv": UI_V}
    js = (TOOLS / "nav.js").read_text(encoding="utf-8")
    mini = json.dumps({"min": 1, "root": "../../", "ct": mini_title or cur["title"]}, ensure_ascii=False).replace("</", "<\\/")
    return (f'<div id="rh-nav" style="display:block;margin:0;padding:0;border:0;width:auto;max-width:none;float:none;position:relative"></div>'
            f'<script type="application/json" id="rh-nav-data">{mini}</script><script>{js}</script>'), json.dumps(data, ensure_ascii=False)


def discover_assets(doc: str, srcdir: pathlib.Path):
    out = {}
    for m in re.finditer(r"""["'(]([^"'()\s<>\\]{1,300})["')]""", doc):
        s = m.group(1).split("#")[0].split("?")[0]
        if not s or re.match(r"^[a-z][a-z0-9+.-]*:", s, re.I) or s.startswith("/") or ".." in s.split("/"):
            continue
        if s.startswith("./"):
            s = s[2:]
        p = srcdir / s
        try:
            if s.endswith("/") and p.is_dir():
                for q in p.rglob("*"):
                    if q.is_file() and q.suffix.lower().lstrip(".") in ASSET_EXT:
                        out[str(q.relative_to(srcdir))] = q
            elif p.is_file() and p.suffix.lower().lstrip(".") in ASSET_EXT:
                out[s] = p
        except OSError:
            continue
    return out


def load_files_map(fm: pathlib.Path):
    m = json.loads(fm.read_text(encoding="utf-8"))
    out = {}
    for k, v in m.items():
        src = v if isinstance(v, str) else (v or {}).get("from")
        if src:
            sp = pathlib.Path(src) if os.path.isabs(src) else fm.parent / src
            if sp.is_file():
                out[k.lstrip("/")] = sp
    return out


FAKE_DB = r"""<script>(function(){var S=JSON.parse(document.getElementById("rh-db").textContent);var D=S.docs;
function snap(p){var o=D[p];return{id:p.split("/").pop(),exists:o!==undefined,data:function(){return o===undefined?undefined:JSON.parse(JSON.stringify(o));}};}
function coll(p,ord){var pre=p.replace(/\/$/,"")+"/";var ds=Object.keys(D).filter(function(k){return k.indexOf(pre)===0&&k.slice(pre.length).indexOf("/")<0;}).map(snap);
if(ord){ds.sort(function(a,b){var x=a.data()[ord.f],y=b.data()[ord.f];var c=x<y?-1:x>y?1:0;return ord.d==="desc"?-c:c;});}
return{docs:ds,size:ds.length,empty:!ds.length,forEach:function(f){ds.forEach(f);}};}
function C(p,ord){return{orderBy:function(f,d){return C(p,{f:f,d:d});},where:function(){return C(p,ord);},limit:function(){return C(p,ord);},
onSnapshot:function(cb){setTimeout(function(){cb(coll(p,ord));},0);return function(){};},get:function(){return Promise.resolve(coll(p,ord));},
doc:function(id){return Doc(p.replace(/\/$/,"")+"/"+id);}};}
function Doc(p){return{onSnapshot:function(cb){setTimeout(function(){cb(snap(p));},0);return function(){};},get:function(){return Promise.resolve(snap(p));},
collection:function(c){return C(p+"/"+c);}};}
var ro=function(){return Promise.reject(new Error("read-only snapshot"));};
var db={doc:Doc,collection:function(p){return C(p);},set:ro,update:ro,delete:ro,batch:function(){return{set:ro,update:ro,delete:ro,commit:ro};}};
window.claude={use:function(n){return Promise.resolve(n==="db"?db:null);},__hubSnapshot:S.at};})();</script>"""


def build_db_snippet(docs_json: pathlib.Path):
    """docs_json = the generator's local output {"<collection>/<doc_id>": data} (the RL tick writes it every run —
    l40s_20261007/dash/docs.json). No claude.ai copy is read: the hub works under any account."""
    try:
        docs = json.loads(docs_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        die(f"db docs {docs_json}: {e}")
    if not isinstance(docs, dict) or not docs:
        die(f"db docs {docs_json}: want a non-empty {{path: doc}} object")
    docs, k = hub_redact.redact_db(docs)   # 올리기 직전 한 곳 — 클러스터 칸 합치기 · GSAI 식별자 · 옆 수 · 노드 · 경로
    REDACTED["n"] += k
    newest = docs_json.stat().st_mtime
    at = dt.datetime.fromtimestamp(newest, KST).isoformat(timespec="seconds")
    blob = json.dumps({"at": at, "docs": docs}, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return f'<script type="application/json" id="rh-db">{blob}</script>' + FAKE_DB, newest, len(docs)


def shell_page(key, kid, root, kind, plaintext: str, has_assets: bool, extra=None) -> bytes:
    cfg = json.dumps({"root": root, "kid": kid, "kind": kind, "assets": has_assets, "z": 1, **(extra or {})})
    payload = base64.b64encode(seal(key, gzip.compress(plaintext.encode("utf-8"), mtime=0))).decode()
    tpl = (TOOLS / "shell.html").read_text(encoding="utf-8")
    return tpl.replace("{{CFG}}", cfg).replace("{{PAYLOAD}}", payload).encode("utf-8")


def git(repo, *a, check=True):
    return subprocess.run(["git", "-C", str(repo), *a], check=check, capture_output=True, text=True)


GIT_ENV = dict(os.environ, GIT_AUTHOR_NAME="wongyun", GIT_AUTHOR_EMAIL="yuwongyun@postech.ac.kr",
               GIT_COMMITTER_NAME="wongyun", GIT_COMMITTER_EMAIL="yuwongyun@postech.ac.kr")
PUSH_CRED = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]


def publish(rp: pathlib.Path, push: bool):
    """One orphan commit of the working tree → force-push (lease on the last known remote) → drop old objects.
    Returns (head, committed, pushed)."""
    git(rp, "add", "-A")
    plain_guard(rp, REDACT if REDACT is not None else redact_words(REDACT_FILE))
    tree = git(rp, "write-tree").stdout.strip()
    head_tree = git(rp, "rev-parse", "-q", "--verify", "HEAD^{tree}", check=False).stdout.strip()
    remote = git(rp, "rev-parse", "-q", "--verify", "refs/remotes/origin/main", check=False).stdout.strip()
    head = git(rp, "rev-parse", "-q", "--verify", "HEAD", check=False).stdout.strip()
    committed = 0
    if tree != head_tree:
        head = subprocess.run(["git", "-C", str(rp), "commit-tree", tree, "-m", "update"],
                              capture_output=True, text=True, check=True, env=GIT_ENV).stdout.strip()
        git(rp, "update-ref", "refs/heads/main", head)
        committed = 1
    pushed = 0
    if push and head and head != remote:
        lease = f"--force-with-lease=main:{remote}" if remote else "--force"
        p = subprocess.run(["git", "-C", str(rp), *PUSH_CRED, "push", "-q", lease, "origin", "main"], capture_output=True, text=True)
        if p.returncode != 0:
            die(f"push rc={p.returncode} {p.stderr.strip()[-200:]} (local commit {head[:7]})")
        pushed = 1
        git(rp, "reflog", "expire", "--expire=now", "--all")
        git(rp, "gc", "-q", "--prune=now")
    return head, committed, pushed


def create_aux(auxd: pathlib.Path) -> str:
    """New auxiliary asset repo: unguessable name, empty description, Pages from main:/docs. Name → <aux-dir>/repos.txt."""
    owner = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True, check=True).stdout.strip()
    nm = "rh-" + os.urandom(8).hex()
    rp = auxd / nm
    (rp / "docs" / "_a").mkdir(parents=True)
    (rp / "docs" / ".nojekyll").touch()
    (rp / "docs" / "robots.txt").write_text("User-agent: *\nDisallow: /\n")
    subprocess.run(["gh", "repo", "create", f"{owner}/{nm}", "--public", "--description", "", "--disable-wiki", "--disable-issues"],
                   capture_output=True, text=True, check=True)
    git(rp.parent, "init", "-q", "-b", "main", nm)
    git(rp, "remote", "add", "origin", f"https://github.com/{owner}/{nm}.git")
    publish(rp, True)
    r = subprocess.run(["gh", "api", "-X", "POST", f"repos/{owner}/{nm}/pages", "-f", "source[branch]=main", "-f", "source[path]=/docs"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        die(f"aux repo {nm}: Pages enable failed {r.stderr.strip()[-160:]}")
    with open(auxd / "repos.txt", "a") as f:
        f.write(nm + "\n")
    return nm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--state", required=True, help="local build state json (outside the repo — holds plaintext hashes)")
    ap.add_argument("--password-file", default="~/.config/research_hub/password")
    ap.add_argument("--report", default="", help="per-page size report TSV (local)")
    ap.add_argument("--rekey", action="store_true", help="password changed: new salt, re-wrap the content key (pages untouched)")
    ap.add_argument("--rotate-content", action="store_true", help="new content key → re-encrypt every page and asset (key leak)")
    ap.add_argument("--content-key", default="~/.config/research_hub/content.key", help="32-byte content key (0600, local only)")
    ap.add_argument("--media-cache", default="", help="re-encode media at build time (tools/hub_media.py rules) with this cache")
    ap.add_argument("--aux-dir", default="", help="folder of auxiliary asset repos (clones + repos.txt) — empty = no split")
    ap.add_argument("--aux-heavy-mb", type=float, default=20.0, help="a page whose published assets reach this goes to an aux repo")
    ap.add_argument("--repo-cap-mb", type=float, default=700.0, help="max published bytes per aux repo (GitHub Pages limit 1 GB)")
    ap.add_argument("--guard-slugs", default="rl,prep", help="pages under the shrink guard (10-15 17:0x: RL pages only — "
                    "collect/augment sources are edited by the collection-design agent and must pass through)")
    ap.add_argument("--allow-shrink", default="", help="comma slugs allowed to shrink >50 % this build (explicit, logged)")
    ap.add_argument("--snapshot-dir", default="", help="local daily snapshot dir (manifest + source hashes) — no heavy copies")
    ap.add_argument("--redact-file", default=REDACT_FILE, help="words never published in plaintext (local, outside the repo)")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--share-write", action="store_true", help="write expiry results to the ctl branch without --push (local tests)")
    ap.add_argument("--min-gap-min", type=float, default=0.0, help="rewrite a changed page at most this often (0 = every build)")
    a = ap.parse_args()
    global REDACT
    REDACT = redact_words(a.redact_file)
    media_st = {}

    repo = pathlib.Path(a.repo).resolve()
    site = repo / "docs"
    pwf = pathlib.Path(os.path.expanduser(a.password_file))
    if not pwf.is_file():
        die(f"password file missing: {pwf}")
    pw = pwf.read_text(encoding="utf-8").strip()
    if not pw:
        die("password file is empty")
    statep = pathlib.Path(a.state)
    state = json.loads(statep.read_text(encoding="utf-8")) if statep.is_file() else {}
    hubj = site / "hub.json"
    cfg = json.loads(hubj.read_text(encoding="utf-8")) if hubj.is_file() else {}
    # Envelope: pages/assets are sealed with a fixed random content key K; the password only wraps K (hub.json "w").
    # A password change re-wraps K (tiny hub.json + homepage k.json); --rotate-content makes a new K (full re-encryption).
    ckf = pathlib.Path(os.path.expanduser(a.content_key))
    if a.rotate_content or not ckf.is_file():
        if not ckf.is_file() and cfg.get("v", 1) == 1 and cfg.get("salt"):
            # one-time migration from v1 (key = PBKDF2(password)) — keep that key as K so nothing is re-encrypted
            k_old = derive(pw, base64.b64decode(cfg["salt"]))
            try:
                ck = base64.b64decode(cfg["check"])
                AESGCM(k_old).decrypt(ck[:12], ck[12:], None)
            except Exception:
                die("v1 migration: password does not match the current site key")
            newk = k_old
        else:
            newk = os.urandom(32)
            state = {}
        ckf.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(ckf) + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, newk)
        os.close(fd)
        os.replace(str(ckf) + ".tmp", ckf)
    key = ckf.read_bytes()
    if len(key) != 32:
        die(f"content key {ckf} is not 32 bytes")
    kid = hashlib.sha256(b"kid" + key).hexdigest()[:16]
    if a.rekey or a.rotate_content or cfg.get("v") != 2 or cfg.get("kid") != kid:
        salt = os.urandom(16) if (a.rekey or not cfg.get("salt")) else base64.b64decode(cfg["salt"])
        kek = derive(pw, salt)
        iv = os.urandom(12)
        cfg = {"v": 2, "kdf": "PBKDF2-SHA256", "iter": ITER, "cipher": "AES-256-GCM", "kid": kid,
               "salt": base64.b64encode(salt).decode(), "w": base64.b64encode(iv + AESGCM(kek).encrypt(iv, key, None)).decode()}
    else:
        try:
            wb = base64.b64decode(cfg["w"])
            ok = AESGCM(derive(pw, base64.b64decode(cfg["salt"]))).decrypt(wb[:12], wb[12:], None) == key
        except Exception:
            ok = False
        if not ok:
            die("password does not unwrap the content key (changed password? run hub_passwd.sh)")
    write_atomic(hubj, (json.dumps(cfg, indent=1) + "\n").encode())
    shutil.copyfile(TOOLS / "sw.js", site / "sw.js")
    shutil.copyfile(TOOLS / "rh-ui.js", site / "rh-ui.js")
    share = load_share(repo, key, state, a.push)
    share = apply_expiry(repo, key, share, dt.datetime.now(dt.timezone.utc), a.push or a.share_write)
    state["share"] = share
    kmeta = hk(key, "meta")
    slot_cache = state.setdefault("slots", {})
    page_keys = {}   # pdir → K_p (assets are sealed with their page's key)
    used_slots = set()
    (site / ".nojekyll").touch()
    write_atomic(site / "robots.txt", b"User-agent: *\nDisallow: /\n")

    rows = read_manifest(pathlib.Path(a.manifest))
    hubdir = pathlib.Path(a.manifest).resolve().parent
    migrate_inbox(repo, key, state, a.push or a.share_write)
    names = cloud_sync(repo, key, rows, hubdir, state)
    secs = sections_of(rows, [])
    projects = [dict(r, own=False) for r in rows if r["kind"] == "project"]   # boards made in the hub come from u.enc (cloud step)
    stages = [{"key": s["category"], "label": s["title"], "hint": s["desc"], "project": p, "own": s["own"]} for p, ss in secs.items() for s in ss]
    pages = [r for r in rows if r["kind"] in PAGE_KINDS]
    pdir_of = {f'{r["project"]}/{r["category"]}/{r["slug"]}': "p/" + hname(key, f'page:{r["project"]}/{r["category"]}/{r["slug"]}', 16)
               for r in pages}
    proj_name = {r["project"]: r["title"] for r in projects}
    pst = state.setdefault("pages", {})
    ast = state.setdefault("assets", {})
    now = dt.datetime.now(KST)
    changed, held, items, report, alerts = 0, 0, [], [], []
    keep_dirs = set()
    live = set()
    page_assets = {}   # pdir → [(asset name, published bytes)] — written after repo assignment
    (site / "_a").mkdir(parents=True, exist_ok=True)
    for r in pages:
        pid = f'{r["project"]}/{r["category"]}/{r["slug"]}'
        item = {k: r[k] for k in ("project", "category", "slug", "title", "desc", "kind")}   # claude_url is not published (10-15 16:4x)
        if r["kind"] == "link":
            item.update(href=r["source"], updated=r["updated"] or "", size=0)
            items.append(item)
            continue
        src, opts = parse_source(r["source"])
        if not src.is_file():
            die(f"{pid}: source missing {src}")
        raw = src.read_text(encoding="utf-8", errors="replace")
        # a shared viewer sees the owner's renamed headings (the owner's own view re-applies the live map in nav.js)
        body = upload_body(apply_headings(raw, pid, names)) if r["kind"] == "upload" else None
        doc = upload_host(r["title"]) if body is not None else wrap_document(apply_headings(raw, pid, names))
        mtime = src.stat().st_mtime
        ndocs = 0
        if r["kind"] == "db":
            if "db" not in opts:
                die(f"{pid}: kind=db needs source '<html>;db=<docs.json>'")
            dj = pathlib.Path(os.path.expanduser(opts["db"]))
            if not dj.is_file():
                die(f"{pid}: db docs file missing {dj}")
            snip, newest, ndocs = build_db_snippet(dj)
            doc = inject_head(doc, snip)
            mtime = max(mtime, newest)
        doc = inject_head(doc, '<meta name="robots" content="noindex, nofollow">')
        doc = inject_head(doc, BASE_CSS)
        doc = inject_head(doc, BASE_JS)
        nav_html, nav_full = nav_snippet(r, pages, secs, pdir_of, proj_name, names.get(f"p:{pid}"))
        doc = inject_body_top(doc, nav_html)
        doc, k = hub_redact.redact_text(doc)
        REDACTED["n"] += k
        # 거른 뒤에도 db 자료(rh-db)가 JSON 으로 읽혀야 한다 — 깨지면 페이지가 '진행 기록(db)을 읽지 못했습니다' 로 멈춘다(10-20 16:5x 사고).
        # 깨진 판을 올리지 않는다(fail closed).
        if r["kind"] == "db":
            mdb = re.search(r'<script type="application/json" id="rh-db">(.*?)</script>', doc, re.S)
            try:
                json.loads(mdb.group(1) if mdb else "")
            except ValueError as ex:
                die(f"{pid}: 거른 뒤 rh-db JSON 깨짐 — {ex}")
        if body is not None:
            body, k = hub_redact.redact_text(body)
            REDACTED["n"] += k
        gsai_leak = hub_redact.leaks(doc + (body or ""))
        if r["kind"] == "upload":
            assets = {}   # the sandboxed frame has no base URL for relative files
        elif "files" in opts:
            assets = load_files_map(pathlib.Path(os.path.expanduser(opts["files"])))
        else:
            assets = discover_assets(raw, src.parent)
        pdir = pdir_of[pid]
        outdir = site / pdir
        sh = share["pages"].get(pdir, {})
        mode = sh.get("mode") if sh.get("mode") in SHARE_MODES else "private"
        epoch = int(sh.get("epoch", 0) or 0)
        kp = hk(key, f"page:{pdir}#{epoch}")
        page_keys[pdir] = kp
        slots = {}
        if mode != "private":
            for inv in sh.get("invites", []):   # (expired invites were dropped by apply_expiry)
                iid, code = str(inv.get("id", "")), str(inv.get("code", ""))
                if not re.fullmatch(r"[0-9a-z]{4,16}", iid) or len(norm_code(code)) < 8:
                    continue
                ck = hashlib.sha256(f"{pdir}|{epoch}|{iid}|{norm_code(code)}".encode() + key).hexdigest()[:24]
                if ck not in slot_cache:
                    slot_cache[ck] = invite_slot(kp, pdir, iid, code)
                used_slots.add(ck)
                slots[iid] = slot_cache[ck]
        nav_full = json.dumps({**json.loads(nav_full), "sm": mode}, ensure_ascii=False)
        nav_sealed = b64(seal(kmeta, nav_full.encode("utf-8")))
        extra = {"p": pdir, "e": epoch, "n": nav_sealed, **({"sl": slots} if slots else {}), **({"b": "body.enc"} if body is not None else {})}
        keep_dirs.add(outdir)
        n_assets, a_bytes, p_bytes, skipped = 0, 0, 0, []
        for pub, sp in sorted(assets.items()):
            sz = sp.stat().st_size
            if sz > MAX_ASSET:
                skipped.append(f"{pub}({sz >> 20}MB)")
                continue
            if a.media_cache:   # D1 — interface hub_media.transcode(src, cache_dir) -> Path (original when not smaller)
                tp = hub_media.transcode(sp, pathlib.Path(a.media_cache))
                mst = "reencoded" if tp != sp else "original"
                media_st[mst] = media_st.get(mst, 0) + 1
                data = tp.read_bytes()
            else:
                data = sp.read_bytes()
            if sp.suffix.lower() in hub_redact.TEXT_EXT:   # 글 파일 자산(로그 · 표)도 같은 거름 · 남으면 그 자산을 싣지 않는다
                txt, k = hub_redact.redact_text(data.decode("utf-8", "replace"))
                REDACTED["n"] += k
                if hub_redact.leaks(txt):
                    skipped.append(f"{pub}(gsai)")
                    gsai_leak.append(pub)
                    continue
                data = txt.encode("utf-8")
            p_bytes += len(data)
            page_assets.setdefault(pdir, []).append((hname(kp, f"{pdir}/{pub}"), data))
            n_assets += 1
            a_bytes += sz
        hc = hashlib.sha256(doc.encode("utf-8") + (body or "").encode("utf-8")).hexdigest()   # content only — a new archive when this changes
        h = hashlib.sha256(doc.encode("utf-8") + (body or "").encode("utf-8") + TPL_SHA.encode() + json.dumps(extra, sort_keys=True).encode()).hexdigest()   # shell / key / slots change → rewrite
        latest = outdir / "index.html"
        depth = 2
        updated = dt.datetime.fromtimestamp(mtime, KST).isoformat(timespec="seconds")
        if (outdir / "archive").is_dir():   # layout before 10-15 15:5x (archive/<stamp>.html) — superseded by archive-<stamp>.html
            shutil.rmtree(outdir / "archive")
        prev = pst.get(pid, {})
        recent = now.timestamp() - prev.get("written", 0) < a.min_gap_min * 60
        # Shrink guard (10-15 17:0x — rl/prep must never break): a page whose plaintext, db documents or assets fall
        # below half of the last published build is NOT published (the previous version stays) and is named on the
        # [HUB_BUILD] line as alert=… → hub_sync prints [HUB] FAIL → the tick raises ALERT. --allow-shrink overrides.
        metr = {"len": len(doc) + len(body or ""), "docs": ndocs, "assets": n_assets, "src": r["source"]}
        # compare only against the last build of the SAME source (a manifest source change resets the baseline)
        shrunk = [k for k in ("len", "docs", "assets") if prev.get("src") == r["source"]
                  and prev.get(k, 0) > 0 and metr[k] < prev.get(k, 0) * 0.5]
        if shrunk and latest.is_file() and r["slug"] in a.guard_slugs.split(",") and r["slug"] not in a.allow_shrink.split(","):
            alerts.append(f'{r["slug"]}:{"+".join(shrunk)}')
            h, hc = prev.get("sha"), prev.get("csha", hc)
        if gsai_leak:   # 거른 뒤에도 GSAI 규모 꼴이 남음 — 이 판은 올리지 않는다(옛 판 유지) · 까닭은 로컬 로그에만
            print(f"[HUB_REDACT] {pid}: 남은 꼴 {len(gsai_leak)} — 올리지 않음 · 예 {str(gsai_leak[0])[:80]!r}", file=sys.stderr)
            alerts.append(f'{r["slug"]}:gsai')
            h, hc = prev.get("sha"), prev.get("csha", hc)
            if not latest.is_file():
                continue
        if (prev.get("sha") != h and not (recent and latest.is_file())) or not latest.is_file():
            if body is not None:
                write_atomic(outdir / "body.enc", seal_body(kp, body))
            write_atomic(latest, shell_page(kp, kid, "../" * depth, "page", doc, bool(n_assets), extra))
            pst[pid] = {"sha": h, "csha": hc, "updated": updated, "written": now.timestamp(), **metr}
            changed += 1
        elif prev.get("sha") != h:
            held += 1
        for old in outdir.glob("archive-*.html"):   # latest only (10-15 21:4x user: no archive copies on the site)
            old.unlink()
        item.update(pdir=pdir, epoch=epoch,
                    href=f"{pdir}/", updated=r["updated"] or pst[pid].get("updated", updated),
                    size=latest.stat().st_size + p_bytes + ((outdir / "body.enc").stat().st_size if body is not None and (outdir / "body.enc").is_file() else 0))
        item["share"] = {"mode": mode, "n": len(sh.get("invites", []))}   # last: hub_read.py pairs "slug" … "href" without braces between
        items.append(item)
        report.append([pid + " → " + pdir, r["kind"], str(latest.stat().st_size), str(n_assets), str(a_bytes), str(p_bytes), str(ndocs), ",".join(skipped) or "-"])

    # ---- asset repos (D2, 10-15 16:4x): light pages keep assets in this repo; a page whose published assets reach
    # --aux-heavy-mb goes whole to an auxiliary repo (same origin wongyun-yu.github.io → the service worker fetches
    # it with the same key). Assignment = this rule + sticky first-fit under --repo-cap-mb; the page→repo map is
    # published only encrypted (hub.json "x"). Aux repo names live in <aux-dir>/repos.txt (local).
    roots = {"": site}
    aux_names = []
    if a.aux_dir:
        auxd = pathlib.Path(a.aux_dir)
        rl = auxd / "repos.txt"
        aux_names = [x.strip() for x in rl.read_text().splitlines() if x.strip()] if rl.is_file() else []
        for nm in aux_names:
            if not (auxd / nm / ".git").is_dir():
                die(f"aux repo clone missing: {auxd / nm}")
            roots[nm] = auxd / nm / "docs"
    sizes = {pd: sum(len(d) for _, d in lst) for pd, lst in page_assets.items()}
    cap = a.repo_cap_mb * 1e6
    repo_of_prev = state.get("repo_of", {})
    repo_of, used = {}, {nm: 0 for nm in aux_names}
    for pd in sorted(sizes, key=lambda x: -sizes[x]):
        if not a.aux_dir or sizes[pd] < a.aux_heavy_mb * 1e6:
            repo_of[pd] = ""
            continue
        if sizes[pd] > cap:
            die(f"page {pd} publishes {sizes[pd] / 1e6:.0f} MB > repo cap {a.repo_cap_mb:.0f} MB")
        want = repo_of_prev.get(pd)
        if want in used and used[want] + sizes[pd] <= cap:
            pick = want
        else:
            pick = next((nm for nm in aux_names if used[nm] + sizes[pd] <= cap), None)
        if pick is None:
            if not a.push:
                die("aux repos full — rerun with --push to create one")
            pick = create_aux(pathlib.Path(a.aux_dir))
            aux_names.append(pick)
            used[pick] = 0
            roots[pick] = pathlib.Path(a.aux_dir) / pick / "docs"
        repo_of[pd] = pick
        used[pick] += sizes[pd]
    state["repo_of"] = repo_of
    for nm, root in roots.items():
        (root / "_a").mkdir(parents=True, exist_ok=True)
    for pd, lst in page_assets.items():
        root = roots[repo_of[pd]]
        for akey, data in lst:
            dst = root / "_a" / (akey + ".enc")
            live.add(dst)
            kp = page_keys[pd]
            tag = hashlib.sha256(data).hexdigest() + "@" + repo_of[pd] + "#" + hashlib.sha256(kp).hexdigest()[:8]
            if ast.get(akey) != tag or not dst.is_file():
                write_atomic(dst, seal(kp, data))
                ast[akey] = tag
    # hub.json pm = {pdir: epoch} for the owner (archives find the live asset key) · pb = aux repo base of a heavy page,
    # looked up by sha256(K_p||'base') and sealed with K_p so a shared viewer finds its assets without the site key.
    pm = b64(seal(kmeta, json.dumps({pd: int(share["pages"].get(pd, {}).get("epoch", 0) or 0) for pd in page_keys}, sort_keys=True).encode()))
    pb = {hashlib.sha256(page_keys[pd] + b"base").hexdigest()[:16]: b64(seal(page_keys[pd], f"/{nm}/".encode()))
          for pd, nm in sorted(repo_of.items()) if nm and pd in page_keys}
    if cfg.get("pm") != pm or cfg.get("pb") != pb or "x" in cfg:
        cfg.pop("x", None)
        cfg["pm"], cfg["pb"] = pm, pb
        write_atomic(hubj, (json.dumps(cfg, indent=1) + "\n").encode())
    for ck in [ck for ck in slot_cache if ck not in used_slots]:
        slot_cache.pop(ck)

    # pages / assets no longer in the manifest: remove their output (git keeps history)
    for d in (site / "p").iterdir() if (site / "p").is_dir() else []:
        if d not in keep_dirs:
            shutil.rmtree(d)
            changed += 1
    for root in roots.values():
        for f in (root / "_a").glob("*.enc"):
            if f not in live:
                f.unlink()
    for k in [k for k in ast if not any((root / "_a" / (k + ".enc")) in live for root in roots.values())]:
        ast.pop(k)
    for k in [k for k in pst if k not in {f'{r["project"]}/{r["category"]}/{r["slug"]}' for r in pages}]:
        pst.pop(k)

    proj = [{"id": p["project"], "name": p["title"], "sub": p["desc"], "tag": p["category"] if p["category"] != "-" else "", "own": p["own"]}
            for p in projects]
    known = {p["id"] for p in proj}
    for it in items:
        if it["project"] not in known:
            proj.append({"id": it["project"], "name": it["project"], "sub": "", "tag": "", "own": False})
            known.add(it["project"])
    data = {"built": now.isoformat(timespec="seconds"), "stages": stages, "projects": proj, "items": items, "uv": UI_V,
            "rej": state.get("inbox_rejected", [])[-10:]}
    dash = (TOOLS / "dashboard.html").read_text(encoding="utf-8").replace(
        "{{DATA}}", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    hh = hashlib.sha256(json.dumps({"stages": stages, "projects": proj, "items": items, "rej": data["rej"], "tpl": TPL_SHA}, sort_keys=True).encode()
                        + (TOOLS / "dashboard.html").read_bytes()).hexdigest()
    if state.get("hub_sha") != hh or not (site / "index.html").is_file():
        write_atomic(site / "index.html", shell_page(key, kid, "./", "hub", dash, False))
        state["hub_sha"] = hh
    write_atomic(statep, (json.dumps(state, indent=1) + "\n").encode())
    if a.report:
        write_atomic(pathlib.Path(a.report), ("\t".join(["page", "kind", "html_bytes", "n_assets", "asset_bytes", "published_asset_bytes", "db_docs", "skipped"])
                                             + "\n" + "\n".join("\t".join(x) for x in report) + "\n").encode())

    # Git keeps ONE commit per repo (orphan, force-pushed): Pages only needs the latest tree, and ciphertext does not
    # delta-compress, so a history would grow by every changed page (10-15 16:4x — 17 commits = 2.5 GB).
    # Commit messages carry no names or sizes.
    pushed, sha, head = 0, "-", ""
    for nm in aux_names + [""]:   # aux first: assets must be live before the main repo's map points at them
        rp = repo if nm == "" else pathlib.Path(a.aux_dir) / nm
        h_, c_, p_ = publish(rp, a.push)
        if nm == "":
            head, sha = h_, (h_[:7] if (c_ or p_) else "-")
        pushed += p_
    if a.snapshot_dir:   # local daily archive: what was published and from which bytes (no copies of the pages)
        snap = {"built": now.isoformat(timespec="seconds"), "commit": head[:7] if head else "-", "pages": [
            {**{k: r[k] for k in ("category", "project", "slug", "title", "source", "kind")},
             "sha256": pst.get(f'{r["project"]}/{r["category"]}/{r["slug"]}', {}).get("sha", "")} for r in pages]}
        write_atomic(pathlib.Path(a.snapshot_dir) / f"{now.strftime('%Y%m%d')}.json",
                     (json.dumps(snap, ensure_ascii=False, indent=1) + "\n").encode())
    print(f"[HUB_BUILD] changed={changed} pages={len(items)} held={held} commit={sha} pushed={pushed} aux={len(aux_names)} "
          f"media={','.join(f'{k}:{v}' for k, v in sorted(media_st.items())) or '-'} alert={','.join(alerts) or '-'} redact={REDACTED['n']}")


if __name__ == "__main__":
    main()
