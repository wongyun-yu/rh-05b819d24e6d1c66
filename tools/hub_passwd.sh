#!/usr/bin/env bash
# hub_passwd.sh — new password → re-wrap the content key (hub.json "w" + homepage k.json) → push. Pages and assets
#   are NOT re-encrypted (envelope key, 10-15 16:4x) — a password change is a few-KB push.
#   bash hub_passwd.sh                    # generates a random passphrase
#   bash hub_passwd.sh --stdin            # reads the new password from stdin (any non-empty value)
#   bash hub_passwd.sh --rotate-content   # also make a NEW content key → every page/asset re-encrypted (key leak;
#                                         #   devices that chose '이 기기 기억' must unlock again)
#   The value is written only to ~/.config/research_hub/password (0600) — never printed.
#   Note: a password change alone does not log out remembered devices (they hold the content key) — use --rotate-content.
set -euo pipefail
HUB_HOME=${HUB_HOME:-$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)}
PWF=$HOME/.config/research_hub/password
exec 9>"$HUB_HOME/.hub_sync.lock"   # same lock as hub_sync.sh — never overlaps a tick sync
flock -w 600 9 || { echo "[HUB_PASSWD] FAIL 틱 동기화 잠금을 10 분 안에 못 얻음 — 비밀번호는 그대로"; exit 1; }
mkdir -p "$(dirname "$PWF")"; chmod 700 "$(dirname "$PWF")"
umask 077
STDIN=0; ROT=""
for x in "$@"; do case "$x" in --stdin) STDIN=1;; --rotate-content) ROT=--rotate-content;; *) echo "[HUB_PASSWD] FAIL 모르는 인자 $x"; exit 1;; esac; done
if [ "$STDIN" = 1 ]; then IFS= read -r NEW; else
  NEW=$(python3 -c "import secrets; a='abcdefghjkmnpqrstuvwxyz23456789'; print('-'.join(''.join(secrets.choice(a) for _ in range(5)) for _ in range(4)))"); fi
[ -n "$NEW" ] || { echo "[HUB_PASSWD] FAIL 빈 비밀번호"; exit 1; }
[ -f "$PWF" ] && cp -p "$PWF" "$PWF.prev"
printf '%s\n' "$NEW" > "$PWF.tmp" && chmod 600 "$PWF.tmp" && mv "$PWF.tmp" "$PWF"
if timeout 900 python3 "$HUB_HOME/repo/tools/hub_build.py" --manifest "$HUB_HOME/hub_manifest.tsv" --repo "$HUB_HOME/repo" \
     --state "$HUB_HOME/state.json" --report "$HUB_HOME/build_report.tsv" --snapshot-dir "$HUB_HOME/archive" --media-cache "$HUB_HOME/cache/media" --aux-dir "$HUB_HOME/aux" --rekey $ROT --push | tail -n 1; then
  rm -f "$PWF.prev"; echo "[HUB_PASSWD] OK 새 비밀번호 = $PWF (값은 출력하지 않음)"
  # homepage hidden entry (public/k.json) follows the new key — clone kept at $HUB_HOME/homepage
  if [ -d "$HUB_HOME/homepage/.git" ]; then
    git -C "$HUB_HOME/homepage" -c credential.helper= -c 'credential.helper=!gh auth git-credential' pull -q --ff-only origin main \
      && timeout 300 python3 "$HUB_HOME/repo/tools/hub_entry.py" --homepage "$HUB_HOME/homepage" --hub-json "$HUB_HOME/repo/docs/hub.json" \
           --path "/$(cat "$HUB_HOME/repo_name")/" --push | tail -n 1 \
      || echo "[HUB_PASSWD] FAIL 홈페이지 입구 다시 암호화 실패 — 허브는 새 비밀번호 · 입구는 옛 키(수동: tools/hub_entry.py)"
  else
    echo "[HUB_PASSWD] FAIL 홈페이지 clone 없음($HUB_HOME/homepage) — 입구가 옛 키로 남음"
  fi
else
  [ -f "$PWF.prev" ] && mv "$PWF.prev" "$PWF"; echo "[HUB_PASSWD] FAIL 빌드 실패 — 옛 비밀번호로 되돌림(사이트는 옛 키 그대로일 수 있음: hub.json 확인)"; exit 1
fi
