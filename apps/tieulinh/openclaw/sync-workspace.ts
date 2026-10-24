#!/usr/bin/env bun
/**
 * Chép prompt của bot từ repo sang workspace OpenClaw đang chạy thật.
 *
 * OpenClaw đọc `AGENTS.md`, `SOUL.md`, `skills/**` từ thư mục workspace của
 * agent, **không** đọc từ repo. Hai nơi không tự đồng bộ, nên sửa prompt trong
 * repo rồi tưởng là xong là một cái bẫy im lặng: bot vẫn chạy bản cũ, test
 * trong repo vẫn xanh, và không có gì báo cho biết hai bên đã lệch.
 *
 * Đo thật 14/09/2026: bản sửa prompt lúc 10:34 không bao giờ tới bot. Tới
 * 10:58 bot vẫn chạy bản 09:59 và nuốt mất bản tóm tắt của cả một lượt tiếp
 * nhận đã thu thập xong.
 *
 *   bun run openclaw:sync           # chép repo -> workspace
 *   bun run openclaw:sync --check   # chỉ báo lệch, không chép (thoát 1 nếu lệch)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_SKILLS = path.resolve(__dirname, "../skills");
const OPENCLAW_HOME = process.env.OPENCLAW_CONFIG_DIR ?? path.join(os.homedir(), ".openclaw");

/**
 * Thư mục repo -> thư mục workspace. Tên hai bên KHÔNG trùng nhau (`tieulinh`
 * ở repo là `workspace-ticket-intake` khi chạy), nên bảng này phải khai tay.
 */
const AGENTS: Array<{ repoDir: string; workspace: string }> = [
  { repoDir: "tieulinh", workspace: "workspace-ticket-intake" },
];

/**
 * Chỉ những thứ repo là nguồn sự thật. Workspace còn giữ dữ liệu chạy
 * (`media/`, `messages/`, `openclaw-workspace-state.json`) — chép đè lên đó
 * là xoá mất trạng thái thật của bot.
 */
const OWNED = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md", "bot.json", "skills", "references"];

const checkOnly = process.argv.includes("--check");

/** Mọi file dưới `root`, đường dẫn tương đối, để so từng file một. */
function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  if (!fs.statSync(root).isDirectory()) return [""];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(root, rel)).map((f) => path.join(rel, f)));
    else out.push(rel);
  }
  return out;
}

function sameContent(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

let drifted = 0;
let copied = 0;
let missingWorkspace = 0;

for (const agent of AGENTS) {
  const from = path.join(REPO_SKILLS, agent.repoDir);
  const to = path.join(OPENCLAW_HOME, agent.workspace);
  console.log(`\n${agent.repoDir} -> ${to}`);

  if (!fs.existsSync(to)) {
    console.log(`  ⚠️  Workspace chưa tồn tại, bỏ qua (bot này chưa chạy trên máy đây).`);
    missingWorkspace += 1;
    continue;
  }

  for (const owned of OWNED) {
    const src = path.join(from, owned);
    if (!fs.existsSync(src)) continue;

    for (const rel of filesUnder(src)) {
      const srcFile = rel ? path.join(src, rel) : src;
      const dstFile = rel ? path.join(to, owned, rel) : path.join(to, owned);
      if (sameContent(srcFile, dstFile)) continue;

      drifted += 1;
      const label = path.relative(to, dstFile);
      if (checkOnly) {
        console.log(`  ✗ LỆCH  ${label}`);
        continue;
      }
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      fs.copyFileSync(srcFile, dstFile);
      copied += 1;
      console.log(`  ✓ chép  ${label}`);
    }
  }

  if (drifted === 0) console.log(`  (khớp)`);
}

console.log();
if (checkOnly) {
  if (drifted > 0) {
    console.error(`❌ ${drifted} file lệch giữa repo và workspace — bot đang chạy bản khác với bản trong repo.`);
    console.error(`   Chạy: bun run openclaw:sync`);
    process.exit(1);
  }
  console.log("✅ Repo và workspace khớp nhau.");
} else {
  console.log(copied > 0 ? `✅ Đã chép ${copied} file.` : "✅ Không có gì phải chép.");
  if (copied > 0) {
    console.log("   Prompt mới chỉ áp dụng cho phiên chat MỚI — phiên đang mở vẫn giữ bản cũ.");
  }
}
if (missingWorkspace === AGENTS.length) {
  console.log("⚠️  Không tìm thấy workspace nào. Đặt OPENCLAW_CONFIG_DIR nếu OpenClaw nằm chỗ khác.");
}
