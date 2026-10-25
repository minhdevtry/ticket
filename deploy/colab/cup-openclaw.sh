#!/usr/bin/env bash
# Dựng gateway OpenClaw của Tiểu Linh 2 trên một máy Colab. Idempotent.
#
#   deploy/colab/cup-openclaw.sh [-H colab2] [-r <git-ref>] [--api anthropic-messages|openai-completions]
#                                [--model <id>] [--dry-run]
#
# - Chỉ đẩy code đã commit của <git-ref> (mặc định HEAD) bằng `git archive`: việc đang dở trong
#   working tree KHÔNG bao giờ được gửi đi. Bản phát hành nằm ở ~/tl2/releases/<sha12> trên Colab.
# - KHÔNG gửi secret. Khoá MiniMax/itsaplan ở lại máy dev (proxy); token gateway do Colab tự sinh.
# - Cần sẵn trên Colab: node 24 (/opt/node24), openclaw (/opt/oc), bun. Xem README của tools/tl2-shadow.
# - Máy Colab chưa bật thì thử `cup -H <host>` (colab-tools) nếu có.
set -euo pipefail

host="${TL2_COLAB_HOST:-colab2}"
ref="HEAD"
api="anthropic-messages"
model="MiniMax-M3.1-Flash"
dry=0
keep=3

while [ $# -gt 0 ]; do
  case "$1" in
    -H) host="$2"; shift 2 ;;
    -r|--ref) ref="$2"; shift 2 ;;
    --api) api="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Tham số lạ: $1" >&2; exit 2 ;;
  esac
done

case "$api" in anthropic-messages|openai-completions) ;; *) echo "--api không hợp lệ: $api" >&2; exit 2 ;; esac

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
sha="$(git rev-parse --verify --quiet "${ref}^{commit}")" || { echo "Không tìm thấy git ref: $ref" >&2; exit 2; }
short="${sha:0:12}"
echo "== ref ${ref} -> ${short} (chỉ code đã commit)"

# Chặn nhầm: bản lưu không được chứa file giống secret/DB. Lấy danh sách vào biến rồi grep (không
# pipe vào `grep -q`: với pipefail, grep thoát sớm làm đường ống báo lỗi và chốt chặn không bao giờ kích hoạt).
archive_list="$(git archive "$sha" | tar -t)"
secret_re='(^|/)\.env(\..*)?$|\.(pem|key|p12|pfx|jks|keystore|crt|sqlite3?|db|db-wal|db-shm|sql|sql\.gz|dump|tfstate|token)$|(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|/)(\.npmrc|\.netrc|\.scan-denylist)$|(^|/)(secrets?|credentials?)(/|$)'
suspect="$(grep -Ev '(^|/)\.env\.example$' <<<"$archive_list" | grep -E "$secret_re" || true)"
if [ -n "$suspect" ]; then
  echo "Bản lưu của ${ref} chứa file giống secret/DB; dừng:" >&2
  echo "$suspect" | head -5 >&2
  exit 1
fi

case "$model" in *[!A-Za-z0-9._-]*|"") echo "--model không hợp lệ: $model" >&2; exit 2 ;; esac
q_model="$(printf '%q' "$model")"
q_api="$(printf '%q' "$api")"

sshc() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$host" "$@"; }

if [ "$dry" = 1 ]; then
  echo "[dry-run] sẽ: ssh ${host}; git archive ${short} | tar -x ~/tl2/releases/${short}; bun install --frozen-lockfile --production; bootstrap --api ${api} --model ${model}"
  exit 0
fi

if ! sshc true 2>/dev/null; then
  echo "== ${host} chưa sẵn sàng, thử cup"
  command -v cup >/dev/null && cup -H "$host"
  sshc true
fi

echo "== kiểm tra node 24 / openclaw / bun trên ${host}"
sshc 'for p in /opt/node24/bin/node /opt/oc/bin/openclaw; do [ -x "$p" ] || { echo "thiếu $p" >&2; exit 1; }; done; command -v bun >/dev/null || { echo "thiếu bun" >&2; exit 1; }; /opt/node24/bin/node -v; bun -v'

remote="\$HOME/tl2/releases/${short}"
if sshc "[ -f ${remote}/.ready ]"; then
  echo "== bản ${short} đã có trên ${host}, bỏ qua bước đẩy code"
else
  echo "== đẩy bản ${short}"
  git archive "$sha" | sshc "set -e; rm -rf ${remote}.tmp; mkdir -p ${remote}.tmp; tar -x -C ${remote}.tmp"
  echo "== bun install (production, theo lockfile)"
  sshc "set -e; cd ${remote}.tmp && bun install --frozen-lockfile --production 2>&1 | tail -3; touch .ready; rm -rf ${remote}; mv ${remote}.tmp ${remote}"
fi

echo "== bootstrap gateway"
sshc "set -e; touch ${remote}; ln -sfn ${remote} \$HOME/tl2/current; cd ${remote} && bun run tools/tl2-shadow/colab/bootstrap.ts --release ${remote} --api ${q_api} --model ${q_model}"

echo "== dọn bản cũ (giữ ${keep})"
# Không bao giờ xoá bản `current` (và `tieulinh-current` của cup-tieulinh.sh) đang trỏ tới (kể cả khi nó cũ hơn theo mtime vì đã được triển khai lại).
sshc "cd \$HOME/tl2/releases && cur=\$(basename \$(readlink -f \$HOME/tl2/current)) && tcur=\$(basename \$(readlink -f \$HOME/tl2/tieulinh-current 2>/dev/null || echo x)) && ls -1t | grep -v '\.tmp\$' | grep -vx \"\$cur\" | grep -vx \"\$tcur\" | tail -n +${keep} | xargs -r rm -rf"
echo "== xong. Token gateway ở ~/tl2/home/gateway.token trên ${host}; relay lấy qua tunnel.ts."
