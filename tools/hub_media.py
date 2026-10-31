#!/usr/bin/env python3
"""Build-time media re-encoding for the research hub (sources are never touched; results are cached).

Rules (user 10-15 16:4x, D1):
  video .mp4/.mov  → H.264 CRF 28 · width ≤ 1280 · +faststart (yuv420p)
  video .webm      → VP9 CRF 40 · width ≤ 1280 (kept as WebM so <source type="video/webm"> stays true)
  image .jpg/.jpeg/.webp → WebP q80
  image .png       → lossless WebP (no quality loss — PNG figures/diagrams)
  anything else    → unchanged
The published path keeps its extension; the service worker sends the Content-Type sniffed from the bytes.
A result is used only when it is smaller than the original. Cache key = sha256(source bytes) + rule version.

CLI (cache warm-up, run in the background before the first build):
  python3 hub_media.py --cache <dir> --workers 3 <file>...   (prints one line per file and a summary line)
"""
import argparse
import concurrent.futures as cf
import hashlib
import io
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

RULES = {  # extension → (rule id, output suffix)
    ".mp4": ("h264-crf28-w1280-v1", ".mp4"), ".mov": ("h264-crf28-w1280-v1", ".mp4"),
    ".webm": ("vp9-crf40-w1280-v1", ".webm"),
    ".jpg": ("webp-q80-v1", ".webp"), ".jpeg": ("webp-q80-v1", ".webp"), ".webp": ("webp-q80-v1", ".webp"),
    ".png": ("webp-lossless-v1", ".webp"),
}
SCALE = "scale='min(1280,iw)':-2"   # 960 → 1280 (user 10-15 17:0x: small text in 1920-wide composites)


def _ffmpeg(src: pathlib.Path, out: pathlib.Path, rule: str):
    base = ["nice", "-n", "19", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", SCALE,
            "-threads", "4"]
    if rule.startswith("h264"):
        cmd = base + ["-c:v", "libx264", "-crf", "28", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                      "-c:a", "aac", "-b:a", "96k", str(out)]
    else:
        cmd = base + ["-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-row-mt", "1", "-cpu-used", "4", "-deadline", "good",
                      "-c:a", "libopus", "-b:a", "64k", str(out)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=900)


class AnimatedImage(Exception):
    pass


def _image(src: pathlib.Path, out: pathlib.Path, rule: str):
    from PIL import Image
    with Image.open(src) as im:
        if getattr(im, "n_frames", 1) > 1:
            raise AnimatedImage()
        if im.mode not in ("RGB", "RGBA", "L", "LA"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        buf = io.BytesIO()
        if rule == "webp-lossless-v1":
            im.save(buf, format="WEBP", lossless=True, method=4)
        else:
            im.save(buf, format="WEBP", quality=80, method=4)
        out.write_bytes(buf.getvalue())


def cache_path(cache: pathlib.Path, data_sha: str, rule: str, suffix: str) -> pathlib.Path:
    return cache / f"{data_sha}.{rule}{suffix}"


def optimize(src: pathlib.Path, cache: pathlib.Path, allow_encode: bool = True):
    """→ (bytes to publish, status) · status ∈ {cached, encoded, kept, skipped, pending, failed:<why>}."""
    rule_sfx = RULES.get(src.suffix.lower())
    data = src.read_bytes()
    if not rule_sfx:
        return data, "skipped"
    rule, sfx = rule_sfx
    sha = hashlib.sha256(data).hexdigest()
    cp = cache_path(cache, sha, rule, sfx)
    keep = cp.with_suffix(cp.suffix + ".keep")   # marker: re-encode was not smaller (or failed) → publish original
    if cp.is_file():
        return cp.read_bytes(), "cached"
    if keep.is_file():
        return data, "kept"
    if not allow_encode:
        return data, "pending"
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as td:
        out = pathlib.Path(td) / ("o" + sfx)
        try:
            (_ffmpeg if rule.startswith(("h264", "vp9")) else _image)(src, out, rule)
        except AnimatedImage:
            keep.write_text("animated — re-encoding at q80 made it larger (measured 10-15)\n")
            return data, "kept"
        except Exception as e:  # noqa: BLE001 — any failure keeps the original bytes (reported, not silent)
            keep.write_text(f"failed: {type(e).__name__}: {str(e)[:200]}\n")
            return data, f"failed:{type(e).__name__}"
        if out.stat().st_size >= len(data):
            keep.write_text("not smaller\n")
            return data, "kept"
        tmp = cp.with_name(cp.name + ".tmp")
        shutil.move(str(out), tmp)
        os.replace(tmp, cp)
    return cp.read_bytes(), "encoded"


def transcode(src: pathlib.Path, cache_dir: pathlib.Path) -> pathlib.Path:
    """Fixed interface (coordinator 10-15 16:5x): the path whose bytes should be published — the cached re-encode
    when one exists and is smaller, else `src` itself. Same source bytes → cache hit (no re-encode)."""
    rule_sfx = RULES.get(src.suffix.lower())
    if not rule_sfx:
        return src
    optimize(src, cache_dir)                      # fills the cache or writes a .keep marker
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    cp = cache_path(cache_dir, sha, *rule_sfx)
    return cp if cp.is_file() else src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("files", nargs="*")
    a = ap.parse_args()
    files = [pathlib.Path(f) for f in a.files] or [pathlib.Path(x.rstrip("\n")) for x in sys.stdin if x.strip()]
    cache = pathlib.Path(a.cache)
    t0, before, after, st = time.time(), 0, 0, {}

    def one(f):
        b, s = optimize(f, cache)
        return f, f.stat().st_size, len(b), s

    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for f, b0, b1, s in ex.map(one, files):
            before += b0
            after += b1
            k = s.split(":")[0]
            st[k] = st.get(k, 0) + 1
            print(f"{s}\t{b0}\t{b1}\t{f}", flush=True)
    print(f"[HUB_MEDIA] files={len(files)} before_MB={before / 1e6:.1f} after_MB={after / 1e6:.1f} "
          f"{' '.join(f'{k}={v}' for k, v in sorted(st.items()))} secs={time.time() - t0:.0f}", flush=True)


if __name__ == "__main__":
    main()
