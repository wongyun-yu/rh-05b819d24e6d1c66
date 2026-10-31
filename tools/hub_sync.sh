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
# 배포 확인(조정자 10-20 11:4x — 01:13 부터 러너가 76 회 실패했는데 '[HUB] OK pushed=1' 만 보고 11 h 몰랐다. 푸시 ≠ 배포).
#   가장 최근 '끝난' 러너 결과를 본다(방금 푸시분은 다음 동기화가 잰다). 실패면 [HUB] 줄을 FAIL 로 — 틱이 마지막 줄로 ALERT 를 띄운다.
dp=$(timeout 20 gh api "repos/wongyun-yu/rh-05b819d24e6d1c66/actions/runs?per_page=5" \
     --jq '[.workflow_runs[] | select(.status=="completed")][0] | [.conclusion, .head_sha[0:7], .created_at] | @tsv' 2>/dev/null | tr '\t' ' ')
last=$(grep -a '^\[HUB_BUILD\]' "$LOG" | tail -n 1)
rc=$(tail -n 1 "$LOG")
al=$(sed -nE 's/.* alert=([^ ]+).*/\1/p' <<< "$last")
if [ -n "$al" ] && [ "$al" != "-" ]; then
  echo "[HUB] FAIL 페이지 급감 — 옛 판 유지: $al (로그 $LOG)"
elif [ "$rc" = "rc=0" ] && [[ "$last" == "[HUB_BUILD] changed="* ]]; then
  c=$(sed -E 's/.*commit=([^ ]+).*/\1/' <<< "$last"); n=$(sed -E 's/.*changed=([0-9]+).*/\1/' <<< "$last")
  hd=$(sed -E "s/.*held=([0-9]+).*/\1/" <<< "$last")
  case "$dp" in
    success*) echo "[HUB] OK $c 바뀜 $n 보류 ${hd:-0} · 배포 OK" ;;
    "")       echo "[HUB] OK $c 바뀜 $n 보류 ${hd:-0} · 배포 ?(gh api 못 읽음)" ;;
    *)        echo "[HUB] FAIL 배포 ✗ $dp — 사이트가 옛 판에 멈춤(gh run view --log · 로그 $LOG)" ;;
  esac
else
  why=${last#\[HUB_BUILD\] FAIL }; [ "$rc" = "rc=124" ] && why="timeout 300s"
  echo "[HUB] FAIL ${why:-$rc} (로그 $LOG)"
fi
echo "[HUB_DEPLOY] ${dp:-?}" >> "$LOG"
# 페이지 꼴 검사(PAGE_RULES.md · 게시는 막지 않음 — 결과는 hub_lint.tsv · 1 시간 아티팩트 틱이 보고)
[ -f "$HUB_HOME/hub_lint.py" ] && { timeout 60 python3 "$HUB_HOME/hub_lint.py" | tail -n 1; } >> "$LOG" 2>&1
exit 0
