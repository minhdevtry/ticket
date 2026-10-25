#!/usr/bin/env bash
# Khởi động/dừng bộ chạy bóng Tiểu Linh 2 trên MÁY DEV: proxy giữ secret, tunnel tới Colab, relay.
#
#   deploy/dev/tl2-shadow.sh start|stop|restart|status|logs [proxy|relay|tunnel|tieulinh]
#   deploy/dev/tl2-shadow.sh systemd-install     # cài unit systemd --user (tự chạy lại khi sập/đăng nhập)
#
# Ngoài ba dịch vụ trên máy dev, `start`/`stop`/`status` còn chạy/dừng/hỏi app hậu cần `apps/tieulinh`
# trên Colab (deploy/colab/cup-tieulinh.sh; tắt bằng TL2_TIEULINH=off, bản chạy lấy từ TL2_REF, mặc định HEAD).
#
# Chế độ mặc định chạy nền bằng pidfile (dừng bằng PID, không để lại gì). Cấu hình đặt ngoài repo:
#   ~/.config/ticket/tl2-shadow.env   SHADOW_ALLOW_FROM=<IP server>, TL2_COLAB_HOST=colab2, ...
#   ~/.config/ticket/minimax.env      MINIMAX_API_KEY, MINIMAX_BASE_URL
#   ~/.config/ticket/tieulinh2.env    ITSAPLAN_BASE_URL, ITSAPLAN_API_KEY, ITSAPLAN_PROJECT_KEY,
#                                     ITSAPLAN_WEBHOOK_SECRET (relay dùng để kiểm chữ ký webhook TECH2)
# Xem tools/tl2-shadow/README.md.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bun_bin="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
data="${TL2_SHADOW_DIR:-$HOME/.local/share/tl2-shadow}"
logs="$data/logs"
run="$data/run"
services=(proxy tunnel relay)   # thứ tự khởi động; dừng theo thứ tự ngược lại

umask 077
mkdir -p "$logs" "$run"
chmod 700 "$data" "$logs" "$run"

cfg_file="${TL2_SHADOW_ENV:-$HOME/.config/ticket/tl2-shadow.env}"
cfg_get() { grep -E "^$1=" "$cfg_file" 2>/dev/null | head -1 | cut -d= -f2- || true; }
# Cùng máy Colab với tunnel/relay: biến môi trường thắng file cấu hình.
export TL2_COLAB_HOST="${TL2_COLAB_HOST:-$(cfg_get TL2_COLAB_HOST)}"
[ -n "$TL2_COLAB_HOST" ] || export TL2_COLAB_HOST=colab2
tieulinh_on() { [ "${TL2_TIEULINH:-$(cfg_get TL2_TIEULINH)}" != "off" ]; }
cup_tieulinh() { "$repo/deploy/colab/cup-tieulinh.sh" -H "$TL2_COLAB_HOST" "$@"; }

pid_of() {
  local f="$run/$1.pid"
  [ -f "$f" ] || return 1
  local p; p="$(cat "$f")"
  kill -0 "$p" 2>/dev/null && echo "$p"
}

start_one() {
  local s="$1"
  if p="$(pid_of "$s")"; then echo "$s: đang chạy (pid $p)"; return; fi
  nohup "$bun_bin" run "$repo/tools/tl2-shadow/$s.ts" >> "$logs/$s.log" 2>&1 &
  echo $! > "$run/$s.pid"
  sleep 1
  if pid_of "$s" >/dev/null; then echo "$s: đã chạy (pid $(cat "$run/$s.pid"))"
  else echo "$s: THOÁT NGAY, xem $logs/$s.log:" >&2; tail -5 "$logs/$s.log" >&2; return 1; fi
}

stop_one() {
  local s="$1" p
  if ! p="$(pid_of "$s")"; then echo "$s: không chạy"; rm -f "$run/$s.pid"; return; fi
  kill "$p"
  for _ in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.3; done
  kill -0 "$p" 2>/dev/null && kill -9 "$p"
  rm -f "$run/$s.pid"
  echo "$s: đã dừng"
}

cmd="${1:-status}"
case "$cmd" in
  start)
    for s in "${services[@]}"; do start_one "$s"; done
    if tieulinh_on; then
      # Cần proxy + tunnel đã lên (cổng -R); chờ tunnel dựng forward lần đầu rồi mới chạy app.
      sleep 6
      cup_tieulinh -r "${TL2_REF:-HEAD}" || { echo "tieulinh: KHÔNG chạy được (các dịch vụ khác vẫn chạy)" >&2; exit 1; }
    fi ;;
  stop)
    if tieulinh_on; then cup_tieulinh stop || echo "tieulinh: không dừng được (Colab tắt?)"; fi
    for ((i=${#services[@]}-1; i>=0; i--)); do stop_one "${services[$i]}"; done ;;
  restart)
    "$0" stop; "$0" start ;;
  status)
    for s in "${services[@]}"; do
      if p="$(pid_of "$s")"; then echo "$s: chạy (pid $p)"; else echo "$s: dừng"; fi
    done
    cfg="${TL2_SHADOW_ENV:-$HOME/.config/ticket/tl2-shadow.env}"
    port="${SHADOW_PORT:-$(grep -E '^SHADOW_PORT=' "$cfg" 2>/dev/null | cut -d= -f2 || true)}"; port="${port:-3106}"
    bind="${SHADOW_BIND:-$(grep -E '^SHADOW_BIND=' "$cfg" 2>/dev/null | cut -d= -f2 || true)}"; bind="${bind:-127.0.0.1}"
    curl -fsS -m 3 "http://${bind}:${port}/health" 2>/dev/null && echo || echo "relay /health: không trả lời (relay ngoài loopback chỉ trả lời IP trong SHADOW_ALLOW_FROM)"
    if tieulinh_on; then cup_tieulinh status || true; fi ;;
  logs)
    s="${2:-relay}"
    if [ "$s" = tieulinh ]; then ssh -o BatchMode=yes "$TL2_COLAB_HOST" 'tail -n 40 -f $HOME/tl2/tieulinh/tieulinh.out'
    else tail -n 40 -f "$logs/$s.log"; fi ;;
  systemd-install)
    dest="$HOME/.config/systemd/user"; mkdir -p "$dest"
    for s in "${services[@]}"; do
      sed -e "s#@REPO@#$repo#g" -e "s#@BUN@#$bun_bin#g" "$repo/deploy/systemd/tl2-shadow-$s.service" > "$dest/tl2-shadow-$s.service"
    done
    systemctl --user daemon-reload
    echo "Đã cài. Dừng bản pidfile (nếu có): $0 stop"
    echo "Bật:  systemctl --user enable --now tl2-shadow-proxy tl2-shadow-tunnel tl2-shadow-relay"
    echo "Tắt:  systemctl --user disable --now tl2-shadow-relay tl2-shadow-tunnel tl2-shadow-proxy" ;;
  *)
    sed -n '2,16p' "$0"; exit 2 ;;
esac
