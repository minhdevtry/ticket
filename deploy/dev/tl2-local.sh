#!/usr/bin/env bash
# Khởi động, giám sát và dừng trọn gói Tiểu Linh 2 (Lễ tân + Hậu cần) cục bộ trên máy dev.
#
#   deploy/dev/tl2-local.sh <start|stop|restart|status|logs> [service] [--dry-run]
#   bun run dev:tieulinh2 start|stop|restart|status|logs
#
# Dịch vụ [service]:
#   all            Cả hai dịch vụ (mặc định nếu bỏ trống)
#   receptionist   Lễ tân (OpenClaw Gateway + Pack Receptionist)
#   backoffice     Hậu cần (apps/tieulinh)
#
# Quản lý PID cô lập trong ~/.local/share/tl2-local/run/ (hoặc $TL2_LOCAL_DIR/run/).
# Tự động nạp cấu hình từ ~/.config/ticket/tieulinh2.env và ~/.config/ticket/minimax.env.
# Chặn an toàn: Nếu phát hiện ITSAPLAN_PROJECT_KEY=TECH (production), từ chối khởi động ngay.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bun_bin="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
openclaw_bin="${OPENCLAW_BIN:-$(command -v openclaw || echo "$HOME/.nvm/versions/node/v22.23.2/bin/openclaw")}"
node_dir="${TL2_NODE_DIR:-$(command -v node >/dev/null 2>&1 && dirname "$(command -v node)" || echo "")}"

data="${TL2_LOCAL_DIR:-$HOME/.local/share/tl2-local}"
logs="$data/logs"
run="$data/run"
apps_data="$data/data"
rec_data="$data/receptionist"

umask 077
mkdir -p "$logs" "$run" "$apps_data" "$rec_data"
chmod 700 "$data" "$logs" "$run" "$apps_data" "$rec_data" 2>/dev/null || true

# --- Cấu hình môi trường ---
cfg_file="${TL2_ENV_FILE:-$HOME/.config/ticket/tieulinh2.env}"
minimax_cfg_file="${TL2_MINIMAX_ENV_FILE:-$HOME/.config/ticket/minimax.env}"
telegram_cfg_file="${TL2_TELEGRAM_ENV_FILE:-$HOME/.config/ticket/telegram.env}"

cfg_get() {
  local var="$1"
  local file="${2:-$cfg_file}"
  grep -E "^${var}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^["'\'' ]*//' -e 's/["'\'' ]*$//' || true
}

export ITSAPLAN_BASE_URL="${ITSAPLAN_BASE_URL:-$(cfg_get ITSAPLAN_BASE_URL)}"
export ITSAPLAN_PROJECT_KEY="${ITSAPLAN_PROJECT_KEY:-$(cfg_get ITSAPLAN_PROJECT_KEY)}"
export ITSAPLAN_PROJECT_KEY="${ITSAPLAN_PROJECT_KEY:-TECH2}"
export ITSAPLAN_TEAM="${ITSAPLAN_TEAM:-$(cfg_get ITSAPLAN_TEAM)}"
export ITSAPLAN_TEAM="${ITSAPLAN_TEAM:-tech}"
export ITSAPLAN_API_KEY="${ITSAPLAN_API_KEY:-$(cfg_get ITSAPLAN_API_KEY)}"
export ITSAPLAN_AGENT_KEY="${ITSAPLAN_AGENT_KEY:-$(cfg_get ITSAPLAN_AGENT_KEY)}"
[ -n "$ITSAPLAN_AGENT_KEY" ] || export ITSAPLAN_AGENT_KEY="$ITSAPLAN_API_KEY"
export ITSAPLAN_WEB_URL="${ITSAPLAN_WEB_URL:-$(cfg_get ITSAPLAN_WEB_URL)}"
export ITSAPLAN_WEBHOOK_SECRET="${ITSAPLAN_WEBHOOK_SECRET:-$(cfg_get ITSAPLAN_WEBHOOK_SECRET)}"
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(cfg_get TELEGRAM_BOT_TOKEN "$telegram_cfg_file")}"
export TIEULINH_ONCALL_CHAT_ID="${TIEULINH_ONCALL_CHAT_ID:-$(cfg_get TIEULINH_ONCALL_CHAT_ID)}"
export TIEULINH_ONCALL_CHAT_ID="${TIEULINH_ONCALL_CHAT_ID:--1000000000001}"

export MINIMAX_API_KEY="${MINIMAX_API_KEY:-$(cfg_get MINIMAX_API_KEY "$minimax_cfg_file")}"
export MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-$(cfg_get MINIMAX_BASE_URL "$minimax_cfg_file")}"
export REQUIRE_APPROVAL="${REQUIRE_APPROVAL:-$(cfg_get REQUIRE_APPROVAL)}"
export REQUIRE_APPROVAL="${REQUIRE_APPROVAL:-false}"

export RECEPTIONIST_PORT="${RECEPTIONIST_PORT:-18796}"
export BOT_WEBHOOK_PORT="${BOT_WEBHOOK_PORT:-3120}"
export BOT_HEALTH_PORT="${BOT_HEALTH_PORT:-3121}"

show_help() {
  cat << 'EOF'
Khởi động, giám sát và dừng trọn gói Tiểu Linh 2 (Lễ tân + Hậu cần) cục bộ trên máy dev.

Cách dùng:
  deploy/dev/tl2-local.sh <start|stop|restart|status|logs> [service] [tùy chọn]

Lệnh:
  start          Khởi động các dịch vụ cục bộ
  stop           Dừng các dịch vụ
  restart        Khởi động lại các dịch vụ
  status         Kiểm tra trạng thái hoạt động (mặc định)
  logs           Xem nhật ký hoạt động (mặc định tail 50 dòng)

Dịch vụ [service]:
  all            Cả hai dịch vụ (mặc định nếu bỏ trống)
  receptionist   Lễ tân (OpenClaw Gateway + Pack Receptionist)
  backoffice     Hậu cần (apps/tieulinh)

Tùy chọn:
  --dry-run      Chỉ in các bước thực hiện mà không khởi động tiến trình thật
  -h, --help     Hiển thị hướng dẫn sử dụng

Biến môi trường:
  ITSAPLAN_PROJECT_KEY   Bắt buộc là TECH2 (chặn an toàn nếu là TECH)
  ITSAPLAN_BASE_URL      URL server Itsaplan (mặc định đọc ~/.config/ticket/tieulinh2.env)
  REQUIRE_APPROVAL       Bật duyệt name code người báo (mặc định false)
  TL2_LOCAL_DIR          Thư mục dữ liệu runtime (mặc định ~/.local/share/tl2-local)
EOF
}

cmd=""
service=""
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    start|stop|restart|status|logs)
      cmd="$1"
      shift
      ;;
    receptionist|backoffice|all)
      service="$1"
      shift
      ;;
    gateway|openclaw|le-tan)
      service="receptionist"
      shift
      ;;
    tieulinh|hau-can)
      service="backoffice"
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help|help)
      show_help
      exit 0
      ;;
    *)
      echo "Tham số không hợp lệ: $1" >&2
      echo "Dùng '$0 --help' để xem hướng dẫn sử dụng." >&2
      exit 2
      ;;
  esac
done

cmd="${cmd:-status}"
service="${service:-all}"

# --- CHỐT CHẶN AN TOÀN (SAFETY GUARD) ---
check_safety_guard() {
  local pkey="${ITSAPLAN_PROJECT_KEY:-}"
  local tproj="${TIEULINH_PROJECT:-}"
  if [ "$pkey" = "TECH" ] || [ "$pkey" = "tech" ] || [ "$tproj" = "TECH" ] || [ "$tproj" = "tech" ]; then
    echo "[CẢNH BÁO AN TOÀN] Từ chối khởi động: Phát hiện cấu hình trỏ vào project production 'TECH'. Bộ launcher chỉ cho phép chạy trên TECH2 để bảo vệ dữ liệu thật!" >&2
    exit 1
  fi
  if [ "$pkey" != "TECH2" ]; then
    echo "[LỖI CẤU HÌNH] ITSAPLAN_PROJECT_KEY bắt buộc phải là 'TECH2' (nhận được: '$pkey')." >&2
    exit 1
  fi
}

check_safety_guard

pid_of() {
  local svc="$1"
  local f="$run/$svc.pid"
  [ -f "$f" ] || return 1
  local p
  p="$(cat "$f" 2>/dev/null || true)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null && echo "$p"
}

port_in_use() {
  local port="$1"
  (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null
}

setup_receptionist_config() {
  local workspace="$rec_data/workspace-ticket-intake-2"
  mkdir -p "$rec_data" "$workspace"
  chmod 700 "$rec_data" "$workspace" 2>/dev/null || true

  # Đồng bộ skills từ apps/tieulinh-legacy/skills
  if [ -d "$repo/apps/tieulinh-legacy/skills" ]; then
    "$bun_bin" -e '
      import { syncWorkspace } from "'"$repo"'/tools/tl2-shadow/colab/bootstrap.ts";
      import { join } from "node:path";
      const recDir = process.argv[1];
      const repoDir = process.argv[2];
      const workspace = join(recDir, "workspace-ticket-intake-2");
      try {
        syncWorkspace(join(repoDir, "apps/tieulinh-legacy/skills"), workspace);
      } catch {}
    ' "$rec_data" "$repo" 2>/dev/null || true
  fi

  local token_file="$rec_data/gateway.token"
  if [ ! -f "$token_file" ] || [ ! -s "$token_file" ]; then
    "$bun_bin" -e 'console.log(crypto.randomUUID().replace(/-/g, ""))' > "$token_file" 2>/dev/null || echo "tl2-local-gateway-token" > "$token_file"
    chmod 600 "$token_file" 2>/dev/null || true
  fi
  local token
  token="$(cat "$token_file" 2>/dev/null | tr -d '[:space:]')"

  # Dựng openclaw.json
  "$bun_bin" -e '
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const [recDir, repoDir, portStr, token, itsaUrl, itsaKey, pkey, mmUrl, mmKey, reqApproval, tgToken] = process.argv.slice(1);
    const port = Number(portStr) || 18796;
    const workspace = join(recDir, "workspace-ticket-intake-2");
    const deniedTools = [
      "group:runtime",
      "group:fs",
      "group:web",
      "group:ui",
      "group:automation",
      "group:nodes",
      "group:messaging"
    ];
    const config = {
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        http: { endpoints: { chatCompletions: { enabled: true } } }
      },
      models: {
        mode: "merge",
        providers: mmKey ? {
          minimax: {
            baseUrl: mmUrl || "https://api.minimaxi.chat/v1",
            api: "anthropic-messages",
            apiKey: mmKey,
            models: [{ id: "MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", reasoning: true, contextWindow: 200000, maxTokens: 8192 }]
          }
        } : {}
      },
      agents: {
        defaults: { model: { primary: mmKey ? "minimax/MiniMax-M3.1-Flash" : "tl2/local" } },
        list: [
          {
            id: "ticket-intake-agent-2",
            name: "Ticket Intake 2",
            workspace,
            model: { primary: mmKey ? "minimax/MiniMax-M3.1-Flash" : "tl2/local" },
            tools: { deny: deniedTools }
          }
        ]
      },
      mcp: {
        servers: {
          ticketintake: {
            command: "bun",
            args: ["run", join(repoDir, "apps/tieulinh-legacy/mcp/tieulinh/index.ts")],
            env: {
              ITSAPLAN_BASE_URL: itsaUrl || "http://127.0.0.1:18998",
              ITSAPLAN_API_KEY: itsaKey || "",
              ITSAPLAN_PROJECT_KEY: pkey || "TECH2",
              INTAKE_DB_PATH: join(recDir, "tieulinh.db"),
              ...(mmKey ? {
                OPENAI_BASE_URL: mmUrl || "https://api.minimaxi.chat/v1",
                OPENAI_API_KEY: mmKey,
                OPENAI_MODEL: "MiniMax-M3.1-Flash",
                OPENAI_API_STYLE: "anthropic"
              } : {}),
              ADMIN_IDS: "",
              ALERT_CHAT_ID: "",
              REQUIRE_APPROVAL: reqApproval || "false"
            }
          }
        }
      },
      tools: { deny: deniedTools },
      channels: tgToken ? {
        telegram: {
          botToken: tgToken
        }
      } : {},
      plugins: { entries: {} }
    };
    writeFileSync(join(recDir, "openclaw.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  ' "$rec_data" "$repo" "$RECEPTIONIST_PORT" "$token" "$ITSAPLAN_BASE_URL" "$ITSAPLAN_API_KEY" "$ITSAPLAN_PROJECT_KEY" "$MINIMAX_BASE_URL" "$MINIMAX_API_KEY" "$REQUIRE_APPROVAL" "$TELEGRAM_BOT_TOKEN" 2>/dev/null || true
}

start_receptionist() {
  local svc="receptionist"
  if p="$(pid_of "$svc")"; then
    echo "$svc: đang chạy (pid $p, cổng $RECEPTIONIST_PORT)"
    return 0
  fi

  if [ "$dry_run" = 1 ]; then
    echo "[dry-run] Sẽ khởi động lễ tân (OpenClaw) trên cổng loopback $RECEPTIONIST_PORT"
    return 0
  fi

  if port_in_use "$RECEPTIONIST_PORT"; then
    echo "$svc: LỖI - cổng $RECEPTIONIST_PORT đã bị chiếm dụng" >&2
    return 1
  fi

  if ! command -v "$openclaw_bin" >/dev/null 2>&1 && [ ! -x "$openclaw_bin" ]; then
    echo "$svc: LỖI - không tìm thấy binary openclaw ($openclaw_bin)" >&2
    return 1
  fi

  setup_receptionist_config

  local config_path="$rec_data/openclaw.json"
  local token_file="$rec_data/gateway.token"
  local token=""
  [ -f "$token_file" ] && token="$(cat "$token_file" | tr -d '[:space:]')"

  echo "$svc: đang khởi động OpenClaw gateway trên cổng $RECEPTIONIST_PORT..."
  local node_path_prefix=""
  [ -n "$node_dir" ] && node_path_prefix="$node_dir:"

  PATH="${node_path_prefix}${PATH}" \
  OPENCLAW_STATE_DIR="$rec_data" \
  OPENCLAW_CONFIG_PATH="$config_path" \
  nohup "$openclaw_bin" gateway run --port "$RECEPTIONIST_PORT" --bind loopback >> "$logs/$svc.log" 2>&1 &
  echo $! > "$run/$svc.pid"

  local ready=0
  for _ in $(seq 1 40); do
    if ! pid_of "$svc" >/dev/null; then
      echo "$svc: THOÁT NGAY, xem $logs/$svc.log:" >&2
      tail -n 10 "$logs/$svc.log" >&2
      return 1
    fi
    if [ -n "$token" ] && curl -fsS -m 2 -H "Authorization: Bearer $token" "http://127.0.0.1:$RECEPTIONIST_PORT/v1/models" >/dev/null 2>&1; then
      ready=1
      break
    elif port_in_use "$RECEPTIONIST_PORT"; then
      ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$ready" = 1 ]; then
    echo "$svc: đã chạy (pid $(cat "$run/$svc.pid"), cổng $RECEPTIONIST_PORT)"
  else
    echo "$svc: chưa sẵn sàng sau 20s, xem $logs/$svc.log" >&2
    return 1
  fi
}

start_backoffice() {
  local svc="backoffice"
  if p="$(pid_of "$svc")"; then
    echo "$svc: đang chạy (pid $p, webhook :$BOT_WEBHOOK_PORT, health :$BOT_HEALTH_PORT)"
    return 0
  fi

  if [ "$dry_run" = 1 ]; then
    echo "[dry-run] Sẽ khởi động hậu cần (apps/tieulinh) trên cổng webhook $BOT_WEBHOOK_PORT, health $BOT_HEALTH_PORT, dự án $ITSAPLAN_PROJECT_KEY"
    return 0
  fi

  if port_in_use "$BOT_WEBHOOK_PORT"; then
    echo "$svc: LỖI - cổng webhook $BOT_WEBHOOK_PORT đã bị chiếm dụng" >&2
    return 1
  fi
  if port_in_use "$BOT_HEALTH_PORT"; then
    echo "$svc: LỖI - cổng health $BOT_HEALTH_PORT đã bị chiếm dụng" >&2
    return 1
  fi

  local bot_data="$apps_data/tieulinh"
  mkdir -p "$bot_data"
  chmod 700 "$bot_data" 2>/dev/null || true

  echo "$svc: đang khởi động apps/tieulinh..."
  export BOT_DATA_DIR="$bot_data"
  export BOT_WEBHOOK_HOST="127.0.0.1"
  export BOT_WEBHOOK_PORT="$BOT_WEBHOOK_PORT"
  export BOT_HEALTH_HOST="127.0.0.1"
  export BOT_HEALTH_PORT="$BOT_HEALTH_PORT"
  export ITSAPLAN_BASE_URL="$ITSAPLAN_BASE_URL"
  export ITSAPLAN_AGENT_KEY="$ITSAPLAN_AGENT_KEY"
  export ITSAPLAN_PROJECT_KEY="$ITSAPLAN_PROJECT_KEY"
  export TIEULINH_PROJECT="$ITSAPLAN_PROJECT_KEY"
  export TIEULINH_TEAM="$ITSAPLAN_TEAM"
  export TIEULINH_AGENT="tieulinh2"
  export TIEULINH_SANDBOX_CHAT="-1000000000001"
  export TIEULINH_ONCALL_CHAT_ID="$TIEULINH_ONCALL_CHAT_ID"
  export REQUIRE_APPROVAL="$REQUIRE_APPROVAL"
  [ -n "${ITSAPLAN_WEB_URL:-}" ] && export ITSAPLAN_WEB_URL="$ITSAPLAN_WEB_URL"
  [ -n "${ITSAPLAN_WEBHOOK_SECRET:-}" ] && export ITSAPLAN_WEBHOOK_SECRET="$ITSAPLAN_WEBHOOK_SECRET"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
  if [ -n "${MINIMAX_API_KEY:-}" ]; then
    export LLM_API_KEY="$MINIMAX_API_KEY"
    export LLM_BASE_URL="${MINIMAX_BASE_URL:-https://api.minimaxi.chat/v1}"
    export LLM_MODEL="MiniMax-M3.1-Flash"
    export LLM_API="anthropic-messages"
  fi
  nohup "$bun_bin" run "$repo/apps/tieulinh/main.ts" >> "$logs/$svc.log" 2>&1 &
  echo $! > "$run/$svc.pid"

  local ready=0
  for _ in $(seq 1 40); do
    if ! pid_of "$svc" >/dev/null; then
      echo "$svc: THOÁT NGAY, xem $logs/$svc.log:" >&2
      tail -n 10 "$logs/$svc.log" >&2
      return 1
    fi
    if curl -fsS -m 2 "http://127.0.0.1:$BOT_HEALTH_PORT/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$ready" = 1 ]; then
    echo "$svc: đã chạy (pid $(cat "$run/$svc.pid"), webhook :$BOT_WEBHOOK_PORT, health :$BOT_HEALTH_PORT)"
  else
    echo "$svc: chưa sẵn sàng sau 20s, xem $logs/$svc.log" >&2
    return 1
  fi
}

stop_one() {
  local svc="$1"
  if [ "$dry_run" = 1 ]; then
    echo "[dry-run] Sẽ dừng dịch vụ $svc"
    return 0
  fi
  local p
  if ! p="$(pid_of "$svc")"; then
    echo "$svc: không chạy"
    rm -f "$run/$svc.pid"
    return 0
  fi
  kill "$p" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.3
  done
  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
  rm -f "$run/$svc.pid"
  echo "$svc: đã dừng"
}

status_one() {
  local svc="$1"
  local p
  if p="$(pid_of "$svc")"; then
    if [ "$svc" = "backoffice" ]; then
      local h="không phản hồi"
      if curl -fsS -m 2 "http://127.0.0.1:$BOT_HEALTH_PORT/healthz" >/dev/null 2>&1; then
        h="ok"
      fi
      echo "$svc: chạy (pid $p, webhook :$BOT_WEBHOOK_PORT, health :$BOT_HEALTH_PORT [$h])"
    else
      local h="không phản hồi"
      if port_in_use "$RECEPTIONIST_PORT"; then
        h="cổng mở"
      fi
      echo "$svc: chạy (pid $p, cổng :$RECEPTIONIST_PORT [$h])"
    fi
  else
    echo "$svc: chưa chạy"
  fi
}

show_logs() {
  local svc="$1"
  case "$svc" in
    receptionist)
      [ -f "$logs/receptionist.log" ] && tail -n 50 "$logs/receptionist.log" || echo "receptionist: chưa có log"
      ;;
    backoffice)
      [ -f "$logs/backoffice.log" ] && tail -n 50 "$logs/backoffice.log" || echo "backoffice: chưa có log"
      ;;
    all)
      echo "=== backoffice ($logs/backoffice.log) ==="
      [ -f "$logs/backoffice.log" ] && tail -n 25 "$logs/backoffice.log" || echo "(chưa có log)"
      echo "=== receptionist ($logs/receptionist.log) ==="
      [ -f "$logs/receptionist.log" ] && tail -n 25 "$logs/receptionist.log" || echo "(chưa có log)"
      ;;
  esac
}

case "$cmd" in
  start)
    if [ "$dry_run" = 1 ]; then
      echo "[dry-run] Kiểm tra cấu hình: ITSAPLAN_PROJECT_KEY=$ITSAPLAN_PROJECT_KEY, ITSAPLAN_TEAM=$ITSAPLAN_TEAM"
    fi
    case "$service" in
      all)
        start_receptionist
        start_backoffice
        ;;
      receptionist)
        start_receptionist
        ;;
      backoffice)
        start_backoffice
        ;;
    esac
    ;;
  stop)
    case "$service" in
      all)
        stop_one "backoffice"
        stop_one "receptionist"
        ;;
      backoffice)
        stop_one "backoffice"
        ;;
      receptionist)
        stop_one "receptionist"
        ;;
    esac
    ;;
  restart)
    "$0" stop "$service"
    "$0" start "$service"
    ;;
  status)
    case "$service" in
      all)
        status_one "receptionist"
        status_one "backoffice"
        ;;
      receptionist)
        status_one "receptionist"
        ;;
      backoffice)
        status_one "backoffice"
        ;;
    esac
    ;;
  logs)
    show_logs "$service"
    ;;
esac
