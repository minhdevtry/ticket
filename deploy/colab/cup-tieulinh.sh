#!/usr/bin/env bash
# Chạy app hậu cần `apps/tieulinh` (agent tieulinh2, dự án TECH2) trên một máy Colab. Idempotent.
#
#   deploy/colab/cup-tieulinh.sh [-H colab2] [-r <git-ref>] [--model <id>] [--dry-run]
#   deploy/colab/cup-tieulinh.sh [-H colab2] stop|status
#
# - Chỉ đẩy code đã commit của <git-ref> (mặc định HEAD) bằng `git archive`, chung thư mục bản phát
#   hành ~/tl2/releases/<sha12> với cup-openclaw.sh (hai symlink riêng: current và tieulinh-current);
#   chạy lại cùng ref thì không đẩy lại.
# - KHÔNG gửi secret. Itsaplan và LLM đi qua proxy trên máy dev (`ssh -R`, cổng 18998/18999: khoá
#   thật nằm ở proxy); chỉ kênh nhật ký, không có Telegram; server webhook chỉ nghe loopback.
#   Webhook tới app qua relay trên dev (kiểm chữ ký) rồi `ssh -L` (xem deploy/dev/tl2-shadow.sh).
# - Dữ liệu ở ~/tl2/tieulinh/data trên Colab: TẠM THỜI, mất khi Colab bị thu hồi.
# - Cần sẵn trên Colab: bun (cùng điều kiện với cup-openclaw.sh). Máy Colab chưa bật thì thử `cup -H <host>`.
set -euo pipefail

host="${TL2_COLAB_HOST:-colab2}"
ref="HEAD"
model="MiniMax-M3.1-Flash"
dry=0
keep=3
action="up"

while [ $# -gt 0 ]; do
  case "$1" in
    -H) host="$2"; shift 2 ;;
    -r|--ref) ref="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    stop|status) action="$1"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Tham số lạ: $1" >&2; exit 2 ;;
  esac
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
sshc() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$host" "$@"; }

if [ "$action" != "up" ]; then
  # Dùng bản phát hành mà lần `up` gần nhất đã chạy (`~/tl2/tieulinh-current`), không cần git ref.
  sshc "cd \$HOME/tl2/tieulinh-current && bun run tools/tl2-shadow/colab/tieulinh-run.ts ${action}"
  exit $?
fi

sha="$(git rev-parse --verify --quiet "${ref}^{commit}")" || { echo "Không tìm thấy git ref: $ref" >&2; exit 2; }
short="${sha:0:12}"
echo "== ref ${ref} -> ${short} (chỉ code đã commit)"

# Chặn nhầm: bản lưu không được chứa file giống secret/DB (cùng bộ lọc với cup-openclaw.sh).
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

if [ "$dry" = 1 ]; then
  echo "[dry-run] sẽ: ssh ${host}; git archive ${short} | tar -x ~/tl2/releases/${short}; bun install --frozen-lockfile --production; tieulinh-run --model ${model}"
  exit 0
fi

if ! sshc true 2>/dev/null; then
  echo "== ${host} chưa sẵn sàng, thử cup"
  command -v cup >/dev/null && cup -H "$host"
  sshc true
fi

echo "== kiểm tra bun trên ${host}"
sshc 'command -v bun >/dev/null || { echo "thiếu bun" >&2; exit 1; }; bun -v'

echo "== kiểm tra proxy trên dev đã sang Colab (cổng 18998/18999)"
sshc 'for p in 18998 18999; do (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null || { echo "cổng $p chưa mở: chạy deploy/dev/tl2-shadow.sh start trước" >&2; exit 1; }; done'

remote="\$HOME/tl2/releases/${short}"
if sshc "[ -f ${remote}/.ready ]"; then
  echo "== bản ${short} đã có trên ${host}, bỏ qua bước đẩy code"
else
  echo "== đẩy bản ${short}"
  git archive "$sha" | sshc "set -e; rm -rf ${remote}.tmp; mkdir -p ${remote}.tmp; tar -x -C ${remote}.tmp"
  echo "== bun install (production, theo lockfile)"
  sshc "set -e; cd ${remote}.tmp && bun install --frozen-lockfile --production 2>&1 | tail -3; touch .ready; rm -rf ${remote}; mv ${remote}.tmp ${remote}"
fi

echo "== chạy tieulinh"
sshc "set -e; touch ${remote}; mkdir -p \$HOME/tl2; ln -sfn ${remote} \$HOME/tl2/tieulinh-current; cd ${remote} && bun run tools/tl2-shadow/colab/tieulinh-run.ts --release ${remote} --model ${q_model}"

echo "== dọn bản cũ (giữ ${keep})"
# Không xoá bản mà gateway (`current`, cup-openclaw.sh) hoặc app (`tieulinh-current`) đang dùng.
sshc "cd \$HOME/tl2/releases && cur=\$(basename \$(readlink -f \$HOME/tl2/current 2>/dev/null || echo x)) && tcur=\$(basename \$(readlink -f \$HOME/tl2/tieulinh-current)) && ls -1t | grep -v '\.tmp\$' | grep -vx \"\$cur\" | grep -vx \"\$tcur\" | tail -n +${keep} | xargs -r rm -rf"
echo "== xong. Dữ liệu ở ~/tl2/tieulinh/data trên ${host} (tạm thời); nhật ký ~/tl2/tieulinh/tieulinh.out"
