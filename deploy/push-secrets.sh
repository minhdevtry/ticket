#!/usr/bin/env bash
# Đẩy một file .env cục bộ lên máy chạy qua SSH, không đi qua git.
# Usage: deploy/push-secrets.sh <ssh-host> <local-env-file> <app-name>
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <ssh-host> <local-env-file> <app-name>" >&2
  exit 2
fi
host="$1" src="$2" app="$3"
[[ -f "$src" ]] || { echo "Không thấy $src" >&2; exit 1; }
[[ "$app" =~ ^[a-z0-9-]+$ ]] || { echo "Tên app không hợp lệ: $app" >&2; exit 1; }

ssh "$host" 'umask 077 && mkdir -p ~/.config/ticket'
scp -q "$src" "$host:.config/ticket/$app.env.tmp"
ssh "$host" "chmod 600 ~/.config/ticket/$app.env.tmp && mv ~/.config/ticket/$app.env.tmp ~/.config/ticket/$app.env"
echo "✓ Đã đẩy $src → $host:~/.config/ticket/$app.env"
