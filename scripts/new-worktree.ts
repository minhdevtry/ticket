#!/usr/bin/env bun
/**
 * Tạo worktree git riêng cho một nhánh mới.
 *
 * Vì sao: hai phiên agent làm cùng một repo thì tranh nhau checkout chính. Đổi nhánh
 * của phiên này làm phiên kia mất nhánh, và `git add -A` của phiên này có thể nuốt
 * thay đổi chưa commit của phiên kia. Mỗi nhánh nên nằm trong worktree riêng.
 *
 * Dùng: scripts/new-worktree.sh <tên-nhánh> [nhánh-nền] [--allow-dirty]
 *
 * Phần thuần (tính đường dẫn, đọc trạng thái checkout) nằm trong hàm export để test
 * được không cần chạy git thật, xem scripts/new-worktree.test.ts.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_BASE = "origin/main";

export interface Args {
  /** Tên nhánh mới. */
  branch: string;
  /** Nhánh nền để tạo nhánh mới. */
  base: string;
  /** Cho phép tạo worktree khi checkout chính đang bẩn. */
  allowDirty: boolean;
}

/** Thư mục gốc chứa worktree: ~/orca/workspaces. */
export function workspacesRoot(home = homedir()): string {
  return join(home, "orca", "workspaces");
}

/** Tên thư mục của nhánh: `feat/foo` thành `feat-foo`. */
export function branchDirName(branch: string): string {
  return branch.trim().replaceAll("/", "-");
}

/** Đường dẫn worktree của một nhánh: <root>/<tên-repo>/<tên-nhánh>. */
export function worktreePath(root: string, repoName: string, branch: string): string {
  return join(root, repoName, branchDirName(branch));
}

/** Checkout bẩn khi `git status --porcelain` có dòng nào khác rỗng. */
export function isDirtyPorcelain(status: string): boolean {
  return status.trim().length > 0;
}

/**
 * Đường dẫn checkout chính từ output `git worktree list --porcelain`.
 * Worktree đầu tiên trong danh sách luôn là checkout chính.
 */
export function mainWorktreePath(worktreeList: string): string | null {
  for (const line of worktreeList.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
  }
  return null;
}

/** Đọc tham số dòng lệnh. Ném lỗi khi thiếu tên nhánh. */
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let allowDirty = false;
  for (const arg of argv) {
    if (arg === "--allow-dirty") allowDirty = true;
    else if (arg === "--help" || arg === "-h") throw new Error("HELP");
    else if (arg.startsWith("-")) throw new Error(`Không hiểu tham số: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length === 0) throw new Error("Thiếu tên nhánh.");
  if (positional.length > 2) throw new Error("Thừa tham số.");
  return {
    branch: positional[0],
    base: positional[1] ?? DEFAULT_BASE,
    allowDirty,
  };
}

function git(args: string[], cwd: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "HELP") {
      console.log("Dùng: scripts/new-worktree.sh <tên-nhánh> [nhánh-nền] [--allow-dirty]");
      return 0;
    }
    console.error(`new-worktree: ${message}`);
    console.error("Dùng: scripts/new-worktree.sh <tên-nhánh> [nhánh-nền] [--allow-dirty]");
    return 2;
  }

  const here = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (here.code !== 0) {
    console.error("new-worktree: không nằm trong repo git nào. Chạy từ trong repo.");
    return 1;
  }
  const currentRoot = here.out.trim();

  const list = git(["worktree", "list", "--porcelain"], currentRoot);
  const mainCheckout = mainWorktreePath(list.out) ?? currentRoot;
  const repoName = basename(mainCheckout);

  const status = git(["status", "--porcelain"], mainCheckout);
  if (status.code !== 0) {
    console.error(`new-worktree: không đọc được trạng thái checkout chính: ${status.err.trim()}`);
    return 1;
  }
  if (isDirtyPorcelain(status.out)) {
    if (!args.allowDirty) {
      console.error("new-worktree: checkout chính đang bẩn, từ chối tạo worktree.");
      console.error(`  checkout chính: ${mainCheckout}`);
      for (const line of status.out.trim().split("\n").slice(0, 10)) console.error(`  ${line}`);
      console.error("  Có thể đang có phiên khác làm dở trong checkout này.");
      console.error("  Dọn sạch hoặc dùng --allow-dirty để vẫn tạo (sẽ in cảnh báo).");
      return 1;
    }
    console.warn("new-worktree: CẢNH BÁO: checkout chính đang bẩn.");
    console.warn(`  checkout chính: ${mainCheckout}`);
    for (const line of status.out.trim().split("\n").slice(0, 10)) console.warn(`  ${line}`);
    console.warn("  Bạn đang chia sẻ checkout này với phiên khác. Đừng `git add -A`.");
  }

  // Cập nhật ref trước khi tạo: `origin/main` trong clone có thể cũ, và worktree tạo
  // trên base cũ thì mọi thay đổi sau đó phải giải quyết xung đột khi merge lại.
  const fetch = git(["fetch", "--quiet", "origin"], currentRoot);
  if (fetch.code !== 0) {
    console.warn(
      `new-worktree: không fetch được origin (tiếp tục với ref đang có): ${(fetch.err || fetch.out).trim()}`,
    );
  }

  const target = worktreePath(workspacesRoot(), repoName, args.branch);
  if (existsSync(target)) {
    console.error(`new-worktree: đường dẫn đã tồn tại: ${target}`);
    return 1;
  }

  const branchExists =
    git(["show-ref", "--verify", "--quiet", `refs/heads/${args.branch}`], currentRoot).code === 0;
  const addArgs = branchExists
    ? ["worktree", "add", target, args.branch]
    : ["worktree", "add", "-b", args.branch, target, args.base];
  const add = git(addArgs, currentRoot);
  if (add.code !== 0) {
    console.error(`new-worktree: git worktree add thất bại: ${(add.err || add.out).trim()}`);
    return 1;
  }

  console.log(`Worktree: ${target}`);
  console.log(`Nhánh:    ${args.branch}`);
  console.log(`Vào:      cd ${target}`);

  // Cài deps để worktree mới chạy được ngay. Worktree đã tạo xong nên lỗi ở bước
  // này không phải lỗi của lệnh tạo: báo rõ rồi trả mã khác 0 để người gọi biết
  // là còn việc phải làm.
  if (!existsSync(join(target, "node_modules"))) {
    console.log("new-worktree: chạy `bun install` trong worktree mới...");
    const install = Bun.spawnSync(["bun", "install"], {
      cwd: target,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (install.exitCode !== 0) {
      console.error("new-worktree: `bun install` thất bại. Chạy lại trong worktree mới:");
      console.error(`  cd ${target} && bun install`);
      console.error(install.stderr.toString().trim());
      return 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
