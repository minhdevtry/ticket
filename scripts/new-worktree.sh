#!/usr/bin/env bash
# Tạo worktree git riêng cho một nhánh mới, để hai phiên làm việc song song không
# tranh nhau checkout chính.
#
# Dùng: scripts/new-worktree.sh <tên-nhánh> [nhánh-nền] [--allow-dirty]
#
#   scripts/new-worktree.sh feat/chat
#   scripts/new-worktree.sh feat/chat origin/main
#   scripts/new-worktree.sh feat/chat --allow-dirty   # checkout chính đang bẩn
#
# Worktree tạo ở ~/orca/workspaces/<tên-repo>/<tên-nhánh> (thay "/" bằng "-").
# Phần tính toán nằm trong scripts/new-worktree.ts để test được, script này chỉ là
# lối vào.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$here/new-worktree.ts" "$@"
