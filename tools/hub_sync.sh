#!/usr/bin/env bash
# hub_sync.sh — tick entry point: manifest → encrypted site → commit → push. Never fails the caller (always exit 0).
#   Last line: `[HUB] OK <commit|-> 바뀜 <n>` or `[HUB] FAIL <reason>`. Full log: $HUB_HOME/hub_sync.log
#   HUB_HOME = folder holding hub_manifest.tsv · state.json · repo/ (default: this script's ../..)
HUB_HOME=${HUB_HOME:-$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)}
LOG=$HUB_HOME/hub_sync.log
exec 9>"$HUB_HOME/.hub_sync.lock"
if ! flock -n 9; then echo "[HUB] FAIL 이전 동기화가 아직 돈다(잠금)"; exit 0; fi
{ echo "=== $(date '+%F %T')"; timeout 300 python3 "$HUB_HOME/repo/tools/hub_build.py" --manifest "$HUB_HOME/hub_manifest.tsv" \
    --repo "$HUB_HOME/repo" --state "$HUB_HOME/state.json" --report "$HUB_HOME/build_report.tsv" \
    --snapshot-dir "$HUB_HOME/archive" --media-cache "$HUB_HOME/cache/media" --aux-dir "$HUB_HOME/aux" --push; echo "rc=$?"; } >> "$LOG" 2>&1
last=$(grep -a '^\[HUB_BUILD\]' "$LOG" | tail -n 1)
rc=$(tail -n 1 "$LOG")
al=$(sed -nE 's/.* alert=([^ ]+).*/\1/p' <<< "$last")
if [ -n "$al" ] && [ "$al" != "-" ]; then
  echo "[HUB] FAIL 페이지 급감 — 옛 판 유지: $al (로그 $LOG)"
elif [ "$rc" = "rc=0" ] && [[ "$last" == "[HUB_BUILD] changed="* ]]; then
  c=$(sed -E 's/.*commit=([^ ]+).*/\1/' <<< "$last"); n=$(sed -E 's/.*changed=([0-9]+).*/\1/' <<< "$last")
  hd=$(sed -E "s/.*held=([0-9]+).*/\1/" <<< "$last"); echo "[HUB] OK $c 바뀜 $n 보류 ${hd:-0}"
else
  why=${last#\[HUB_BUILD\] FAIL }; [ "$rc" = "rc=124" ] && why="timeout 300s"
  echo "[HUB] FAIL ${why:-$rc} (로그 $LOG)"
fi
# 페이지 꼴 검사(PAGE_RULES.md · 게시는 막지 않음 — 결과는 hub_lint.tsv · 1 시간 아티팩트 틱이 보고)
[ -f "$HUB_HOME/hub_lint.py" ] && { timeout 60 python3 "$HUB_HOME/hub_lint.py" | tail -n 1; } >> "$LOG" 2>&1
exit 0
