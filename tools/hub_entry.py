#!/usr/bin/env python3
"""Homepage hidden entry blob — encrypts the hub path with the hub key and writes <homepage>/public/k.json.

The homepage component (src/components/HubEntry.astro) derives the wrapping key (PBKDF2-SHA256, the hub's salt and
iteration count), opens the content key from "w" (same envelope as docs/hub.json), decrypts {"u": "/<hub repo>/"}
with it and stores the content key the way the hub's '이 기기 기억' does, so the hub opens without a second prompt. Deterministic (synthetic IV): same password + same
path → same bytes → nothing to commit. Last line: `[HUB_ENTRY] changed=<0|1> commit=<sha|-> pushed=<0|1>`.
"""
import argparse
import base64
import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

from hub_build import derive, seal  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--homepage", required=True, help="local clone of wongyun-yu.github.io")
    ap.add_argument("--hub-json", required=True, help="<hub repo>/docs/hub.json (salt · iterations)")
    ap.add_argument("--path", required=True, help="hub path on the same origin, e.g. /rh-xxxx/")
    ap.add_argument("--password-file", default="~/.config/research_hub/password")
    ap.add_argument("--content-key", default="~/.config/research_hub/content.key")
    ap.add_argument("--push", action="store_true")
    a = ap.parse_args()
    if not a.path.startswith("/"):
        print("[HUB_ENTRY] FAIL --path must start with /")
        sys.exit(1)
    pw = pathlib.Path(os.path.expanduser(a.password_file)).read_text(encoding="utf-8").strip()
    if not pw:
        print("[HUB_ENTRY] FAIL empty password")
        sys.exit(1)
    cfg = json.loads(pathlib.Path(a.hub_json).read_text(encoding="utf-8"))
    if cfg.get("v") != 2:
        print("[HUB_ENTRY] FAIL hub.json is not v2 (envelope) — run hub_build first")
        sys.exit(1)
    key = pathlib.Path(os.path.expanduser(a.content_key)).read_bytes()
    wb = base64.b64decode(cfg["w"])
    try:
        ok = AESGCM(derive(pw, base64.b64decode(cfg["salt"]))).decrypt(wb[:12], wb[12:], None) == key
    except Exception:
        ok = False
    if not ok:
        print("[HUB_ENTRY] FAIL password does not open hub.json w")
        sys.exit(1)
    blob = seal(key, json.dumps({"u": a.path}).encode())
    out = {"s": cfg["salt"], "i": cfg["iter"], "w": cfg["w"], "kid": cfg["kid"], "b": base64.b64encode(blob).decode()}
    hp = pathlib.Path(a.homepage)
    dst = hp / "public" / "k.json"
    new = json.dumps(out, separators=(",", ":")) + "\n"
    changed = int(not dst.is_file() or dst.read_text(encoding="utf-8") != new)
    if changed:
        dst.write_text(new, encoding="utf-8")

    def git(*x, check=True):
        return subprocess.run(["git", "-C", str(hp), *x], capture_output=True, text=True, check=check)

    sha, pushed = "-", 0
    git("add", "public/k.json")
    if git("diff", "--cached", "--quiet", check=False).returncode != 0:
        git("-c", "user.email=yuwongyun@postech.ac.kr", "-c", "user.name=wongyun", "commit", "-q", "-m", "Update k.json")
        sha = git("rev-parse", "--short", "HEAD").stdout.strip()
    ahead = git("rev-list", "--count", "origin/main..HEAD", check=False).stdout.strip()
    if a.push and ahead not in ("", "0"):
        p = subprocess.run(["git", "-C", str(hp), "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
                            "push", "-q", "origin", "HEAD:main"], capture_output=True, text=True)
        if p.returncode != 0:
            print(f"[HUB_ENTRY] FAIL push rc={p.returncode} {p.stderr.strip()[-200:]}")
            sys.exit(1)
        pushed = 1
    print(f"[HUB_ENTRY] changed={changed} commit={sha} pushed={pushed}")


if __name__ == "__main__":
    main()
