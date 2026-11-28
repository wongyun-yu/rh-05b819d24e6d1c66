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
HR=wongyun-yu/rh-05b819d24e6d1c66
last=$(grep -a '^\[HUB_BUILD\]' "$LOG" | tail -n 1)
rc=$(tail -n 1 "$LOG")   # rc = 로그 끝 줄 — 이 아래에서는 로그에 쓰지 않는다(끝의 [HUB_DEPLOY] 한 줄만)
# 시작 실패(잡 0 개 — GitHub 가 push 실행을 못 띄움 · 11-10 03:1x GitHub Actions 장애 때 연달아 · 같은 판 손 실행은 성공): 방금 푸시했으면
#   그 실행이 대기에서 벗어날 때까지 ≤ 90 s 보고, 잡 0 개로 끝났으면 같은 판을 workflow_dispatch 로 한 번 낸다.
#   배포 단계 실패(잡 있음 · Pages 배포가 멈춤)는 여기서 다루지 않는다 — hub_cloud.deploy 가 취소하고 다시 낸다.
st=""
if [[ "$last" == *" pushed=1 "* ]]; then
  for _ in 1 2 3 4 5 6 7 8 9; do
    read -r ns nc nid <<< "$(timeout 20 gh api "repos/$HR/actions/runs?per_page=1" --jq '.workflow_runs[0] | [.status, (.conclusion // "-"), .id] | @tsv' 2>/dev/null)"
    { [ "$ns" = completed ] || [ "$ns" = in_progress ]; } && break
    sleep 10
  done
  if [ "$ns" = completed ] && [ "$nc" = failure ] && [ "$(timeout 20 gh api "repos/$HR/actions/runs/$nid/jobs" --jq .total_count 2>/dev/null)" = 0 ]; then
    timeout 30 gh workflow run hub -R "$HR" > /dev/null 2>&1 && st="방금 push 실행이 시작 실패(잡 0 · GitHub 쪽) → 같은 판 손 실행 냄" || st="방금 push 실행이 시작 실패(잡 0) · 손 실행도 못 냄"
  fi
fi
# 배포 상태 = 가장 새 실행이 아직 돌면 '배포 중', 아니면 끝난 실행 중 가장 새 것(GitHub 가 같은 concurrency 묶음의 대기 실행을 더 새 실행으로
#   갈아 끼우며 'cancelled' 로 끝낸 것은 건너뜀 — 그것을 '옛 판에 멈춤'으로 보고한 거짓 경보 11-10 07:1x · C1289)
dp=$(timeout 20 gh api "repos/$HR/actions/runs?per_page=10" \
     --jq '.workflow_runs as $r | if ($r[0].status != "completed") then ["running", $r[0].head_sha[0:7], $r[0].created_at] else ([$r[] | select(.status=="completed" and .conclusion!="cancelled")][0] | [.conclusion, .head_sha[0:7], .created_at]) end | @tsv' 2>/dev/null | tr '\t' ' ')
al=$(sed -nE 's/.* alert=([^ ]+).*/\1/p' <<< "$last")
if [ -n "$al" ] && [ "$al" != "-" ]; then
  echo "[HUB] FAIL 페이지 급감 — 옛 판 유지: $al (로그 $LOG)"
elif [ "$rc" = "rc=0" ] && [[ "$last" == "[HUB_BUILD] changed="* ]]; then
  c=$(sed -E 's/.*commit=([^ ]+).*/\1/' <<< "$last"); n=$(sed -E 's/.*changed=([0-9]+).*/\1/' <<< "$last")
  hd=$(sed -E "s/.*held=([0-9]+).*/\1/" <<< "$last")
  case "$dp" in
    success*) echo "[HUB] OK $c 바뀜 $n 보류 ${hd:-0} · 배포 OK" ;;
    running*) echo "[HUB] OK $c 바뀜 $n 보류 ${hd:-0} · 배포 중(${dp#running })" ;;
    "")       echo "[HUB] OK $c 바뀜 $n 보류 ${hd:-0} · 배포 ?(gh api 못 읽음)" ;;
    *)        echo "[HUB] FAIL 배포 ✗ $dp${st:+ · $st} — 사이트가 옛 판에 멈춤(gh run view --log · 로그 $LOG)" ;;
  esac
else
  why=${last#\[HUB_BUILD\] FAIL }; [ "$rc" = "rc=124" ] && why="timeout 300s"
  echo "[HUB] FAIL ${why:-$rc} (로그 $LOG)"
fi
echo "[HUB_DEPLOY] ${dp:-?}${st:+ · $st}" >> "$LOG"
# 페이지 꼴 검사(PAGE_RULES.md · 게시는 막지 않음 — 결과는 hub_lint.tsv · 1 시간 아티팩트 틱이 보고)
[ -f "$HUB_HOME/hub_lint.py" ] && { timeout 60 python3 "$HUB_HOME/hub_lint.py" | tail -n 1; } >> "$LOG" 2>&1
exit 0
