#!/usr/bin/env python3
"""Research hub — page lineage (which page of a project came from which) from the PC.

The one owner is ctl:edges.enc on the hub repo (see hub_build.py 'lineage'); the hub's 'connections' editor writes the same
file from the browser. This tool reads it, applies one change, checks the WHOLE result against the manifest with the
builder's own edges_check (unknown page / kind, a self link, a duplicate or a cycle → FAIL, nothing written) and writes it
back with a lease on the fetched ctl head (someone wrote in between → re-read and retry). The mirror <hub>/hub_edges.tsv is
rewritten too; the hub screen follows at the next hub_sync (a browser with a GitHub token sees it at once).

  hub_edges.py list    [<project>]
  hub_edges.py add     <project> <parent> <child> <kind> [note]   parent/child = <section>/<slug> · kind = derived | experiment
  hub_edges.py del     <project> <parent> <child>
  hub_edges.py view    <project> tree|off                         tree = the project screen opens as the lineage tree
  hub_edges.py repoint <project> <old page> <new page>            a page moved or was renamed in the manifest
  hub_edges.py check                                              the current file against the manifest (no write)
  hub_edges.py mirror                                             rewrite hub_edges.tsv from the current file
  hub_edges.py restore                                            put the build's last good copy (state.json) back on ctl
Last line: `[HUB_EDGES] OK …` or `[HUB_EDGES] FAIL …` (rc 1)."""
import argparse
import datetime as dt
import fcntl
import json
import os
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hub_build as HB  # noqa: E402

KINDS = [k for k, _, _ in HB.EDGE_KINDS]


def fail(msg):
    print(f"[HUB_EDGES] FAIL {msg}")
    sys.exit(1)


def fetch_ctl(repo: pathlib.Path):
    f = subprocess.run(["git", "-C", str(repo), *HB.PUSH_CRED, "fetch", "-q", "origin", "+refs/heads/ctl:refs/remotes/origin/ctl"],
                       capture_output=True, text=True, timeout=120)
    if f.returncode != 0:
        fail(f"ctl fetch failed: {f.stderr.strip()[-200:]}")


def load(repo, key):
    fetch_ctl(repo)
    try:
        return HB.edges_load(repo, key, None)
    except ValueError as e:
        fail(str(e))


def change(doc: dict, a) -> str:
    """apply one change in place → a one-line description (or FAIL)."""
    projs = doc.setdefault("projects", {})
    pr = projs.setdefault(a.project, {"edges": []})
    pr.setdefault("edges", [])
    if a.cmd == "add":
        if a.kind not in KINDS:
            fail(f"unknown kind {a.kind!r} (known: {', '.join(KINDS)})")
        if any(e["parent"] == a.parent and e["child"] == a.child for e in pr["edges"]):
            fail(f"{a.parent} → {a.child} already linked — del it first to change the kind or note")
        e = {"parent": a.parent, "child": a.child, "kind": a.kind, "at": dt.datetime.now(HB.KST).isoformat(timespec="seconds")}
        if a.note:
            e["note"] = a.note
        pr["edges"].append(e)
        return f"add {a.project} {a.parent} → {a.child} ({a.kind})"
    if a.cmd == "del":
        n = len(pr["edges"])
        pr["edges"] = [e for e in pr["edges"] if not (e["parent"] == a.parent and e["child"] == a.child)]
        if len(pr["edges"]) == n:
            fail(f"no link {a.parent} → {a.child} in {a.project}")
        return f"del {a.project} {a.parent} → {a.child}"
    if a.cmd == "view":
        if a.mode == "off":
            pr.pop("view", None)
        elif a.mode in HB.EDGE_VIEWS:
            pr["view"] = a.mode
        else:
            fail(f"unknown view {a.mode!r} (known: {', '.join(HB.EDGE_VIEWS)}, off)")
        return f"view {a.project} {a.mode}"
    if a.cmd == "repoint":
        n = 0
        for e in pr["edges"]:
            for side in ("parent", "child"):
                if e[side] == a.old:
                    e[side] = a.new
                    n += 1
        if not n:
            fail(f"no link of {a.project} touches {a.old}")
        return f"repoint {a.project} {a.old} → {a.new} ({n} ends)"
    raise AssertionError(a.cmd)


def tidy(doc):
    """a project left with no view and no edges leaves the file (the hub then shows it exactly as before)."""
    doc["projects"] = {p: pr for p, pr in doc.get("projects", {}).items() if pr.get("view") or pr.get("edges")}


def write(repo, key, hubdir, rows, mutate, what):
    try:   # a hand-edited mirror is refused before anything is written (its edit would be lost quietly otherwise)
        HB.edges_mirror_check(hubdir / HB.EDGE_MIRROR)
    except ValueError as e:
        fail(str(e))
    for _ in range(4):
        doc = load(repo, key)
        base = HB.git(repo, "rev-parse", "-q", "--verify", "refs/remotes/origin/ctl", check=False).stdout.strip()
        if not base:
            fail("no ctl branch on the hub repo")
        desc = mutate(doc)
        tidy(doc)
        try:
            HB.edges_check(doc, rows)
        except ValueError as e:
            fail(f"{e} — nothing written")
        doc["rev"] = int(doc.get("rev", 0)) + 1
        doc["at"] = dt.datetime.now(HB.KST).isoformat(timespec="seconds")
        if HB.ctl_write(repo, {HB.EDGES_FILE: HB.edges_seal(key, doc)}, [], "ctl"):
            HB.write_atomic(hubdir / HB.EDGE_MIRROR, HB.edges_mirror_text(doc).encode("utf-8"))
            n = sum(len(p.get("edges", [])) for p in doc["projects"].values())
            print(f"[HUB_EDGES] OK rev={doc['rev']} {desc} · links {n} — the hub screen follows at the next hub_sync")
            return
        print("[hub_edges] ctl moved — re-reading", file=sys.stderr)
    fail(f"ctl kept moving — {what} not written")


def main():
    here = pathlib.Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--hub", default=str(here.parents[1]), help="hub home (hub_manifest.tsv · state.json · repo/)")
    ap.add_argument("--content-key", default="~/.config/research_hub/content.key")
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("list")
    p.add_argument("project", nargs="?", default="")
    p = sp.add_parser("add")
    for x in ("project", "parent", "child", "kind"):
        p.add_argument(x)
    p.add_argument("note", nargs="?", default="")
    p = sp.add_parser("del")
    for x in ("project", "parent", "child"):
        p.add_argument(x)
    p = sp.add_parser("view")
    p.add_argument("project")
    p.add_argument("mode")
    p = sp.add_parser("repoint")
    for x in ("project", "old", "new"):
        p.add_argument(x)
    sp.add_parser("check")
    sp.add_parser("mirror")
    sp.add_parser("restore")
    a = ap.parse_args()
    hub = pathlib.Path(a.hub).resolve()
    repo = hub / "repo"
    # the hub repo's git (fetch · the ctl index) is shared with hub_sync.sh — take its lock for the whole run (≤ 5 min wait)
    lk = open(hub / ".hub_sync.lock", "a")
    for _ in range(300):
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if _ == 0:
                print("[hub_edges] waiting for a running hub_sync to finish …", file=sys.stderr)
            time.sleep(1)
    else:
        fail("hub_sync kept the lock for 5 min — try again")
    key = pathlib.Path(os.path.expanduser(a.content_key)).read_bytes()
    if len(key) != 32:
        fail("content key is not 32 bytes")
    try:
        rows = HB.read_manifest(hub / "hub_manifest.tsv")
    except SystemExit:
        fail("manifest unreadable (see the line above)")
    if a.cmd == "list":
        doc = load(repo, key)
        print(f"rev {doc.get('rev', 0)} · {doc.get('at', '-')}")
        for pid, pr in sorted(doc.get("projects", {}).items()):
            if a.project and pid != a.project:
                continue
            print(f"{pid}\tview={pr.get('view') or 'off'}\tlinks={len(pr.get('edges', []))}")
            for e in pr.get("edges", []):
                print(f"  {e['parent']} → {e['child']}\t{e['kind']}\t{e.get('note', '')}")
        print("[HUB_EDGES] OK list")
        return
    if a.cmd in ("check", "mirror"):
        doc = load(repo, key)
        try:
            HB.edges_check(doc, rows)
        except ValueError as e:
            fail(str(e))
        if a.cmd == "mirror":
            HB.write_atomic(hub / HB.EDGE_MIRROR, HB.edges_mirror_text(doc).encode("utf-8"))
        print(f"[HUB_EDGES] OK {a.cmd} rev={doc.get('rev', 0)}")
        return
    if a.cmd == "restore":
        st = json.loads((hub / "state.json").read_text(encoding="utf-8")).get("edges")
        if not st:
            fail("state.json holds no lineage copy")

        def put_back(doc):
            if doc.get("projects"):
                fail(f"ctl:{HB.EDGES_FILE} exists with content (rev {doc.get('rev')}) — not overwriting it")
            doc.clear()
            doc.update(json.loads(json.dumps(st)))
            return f"restore rev {st.get('rev')}"
        return write(repo, key, hub, rows, put_back, "restore")
    if a.project not in {r["project"] for r in rows if r["kind"] == "project"}:
        fail(f"unknown project {a.project!r}")
    write(repo, key, hub, rows, lambda doc: change(doc, a), a.cmd)


if __name__ == "__main__":
    main()
