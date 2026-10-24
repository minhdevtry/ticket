#!/usr/bin/env bun
/**
 * Script kiểm tra và chuẩn bị workspace cho OpenClaw.
 *
 * Kiểm tra:
 * - Các file Markdown (IDENTITY, SOUL, SKILL) được khai báo trong openclaw.json có tồn tại không.
 * - Các MCP server có sẵn sàng chạy không.
 * - Biến môi trường quan trọng đã được cấu hình chưa.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT_DIR = path.resolve(__dirname, "../../..");
const OPENCLAW_CONFIG_PATH = path.resolve(__dirname, "openclaw.json");

console.log("==========================================");
console.log("   VUIHOC INTAKE AGENTS - OPENCLAW BOOTSTRAP");
console.log("==========================================");

if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
  console.error(`❌ Không tìm thấy file cấu hình: ${OPENCLAW_CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
console.log(`\n📋 Cấu hình dự án: ${config.name} (version ${config.version})`);

// 1. Kiểm tra MCP Servers
console.log("\n🔌 Kiểm tra MCP Servers:");
let mcpErrors = 0;
for (const [serverName, serverSpec] of Object.entries<any>(config.mcpServers)) {
  const entryScript = path.resolve(ROOT_DIR, serverSpec.args[1]);
  if (fs.existsSync(entryScript)) {
    console.log(`  ✅ [${serverName}] Entrypoint: ${serverSpec.args[1]}`);
  } else {
    console.error(`  ❌ [${serverName}] Thiếu file: ${entryScript}`);
    mcpErrors++;
  }
}

// 2. Kiểm tra Agents & Skills
console.log("\n🤖 Kiểm tra Agents & Markdown Skills:");
let agentErrors = 0;
for (const [agentId, agentSpec] of Object.entries<any>(config.agents)) {
  console.log(`  • Agent "${agentSpec.name}" (${agentId}) - ${agentSpec.role}`);

  // Kiểm tra instructions
  for (const doc of agentSpec.instructions) {
    const fullPath = path.resolve(ROOT_DIR, doc);
    if (fs.existsSync(fullPath)) {
      console.log(`    ✅ Doc: ${doc}`);
    } else {
      console.error(`    ❌ Thiếu doc: ${doc}`);
      agentErrors++;
    }
  }

  // Kiểm tra skills
  for (const skill of agentSpec.skills) {
    const fullPath = path.resolve(ROOT_DIR, skill);
    if (fs.existsSync(fullPath)) {
      console.log(`    ✅ Skill: ${skill}`);
    } else {
      console.error(`    ❌ Thiếu skill: ${skill}`);
      agentErrors++;
    }
  }
}

// 3. Kiểm tra biến môi trường
console.log("\n🔑 Kiểm tra biến môi trường (Environment):");
const REQUIRED_ENV = ["ITSAPLAN_BASE_URL", "ITSAPLAN_API_KEY"];
const OPTIONAL_ENV = [
  "TELEGRAM_BOT_TOKEN_TIEULINH",
  "ONYX_BASE_URL",
  "ONYX_API_KEY",
  "ADMIN_IDS",
];

for (const envKey of REQUIRED_ENV) {
  if (process.env[envKey]) {
    console.log(`  ✅ Bắt buộc: ${envKey} [ĐÃ THIẾT LẬP]`);
  } else {
    console.log(`  ⚠️ Bắt buộc: ${envKey} [CHƯA CÓ - cần điền trong .env]`);
  }
}

for (const envKey of OPTIONAL_ENV) {
  if (process.env[envKey]) {
    console.log(`  ℹ️ Tuỳ chọn: ${envKey} [ĐÃ THIẾT LẬP]`);
  } else {
    console.log(`  ⚪ Tuỳ chọn: ${envKey} [Chưa thiết lập]`);
  }
}

// 4. Đồng bộ nhãn Huly sang Itsaplan
if (process.env.ITSAPLAN_BASE_URL && process.env.ITSAPLAN_API_KEY) {
  console.log("\n🏷️ Đồng bộ nhãn chuẩn Huly sang Itsaplan:");
  try {
    const { ItsaplanClient } = await import("../lib/itsaplan/client");
    const { syncHulyLabelsToItsaplan } = await import("../lib/itsaplan/sync-labels");
    const itsaplan = new ItsaplanClient(process.env.ITSAPLAN_BASE_URL, process.env.ITSAPLAN_API_KEY);
    await syncHulyLabelsToItsaplan(itsaplan, "TECH");
    await syncHulyLabelsToItsaplan(itsaplan, "PO");
    console.log("  ✅ Đã đồng bộ đủ 18 nhãn chuẩn Huly cho cả TECH và PO.");
  } catch (err: any) {
    console.log(`  ⚠️ Lỗi khi đồng bộ nhãn: ${err.message}`);
  }
}

// 5. Tự động kiểm tra và kích hoạt Webhook trên Itsaplan
if (process.env.ITSAPLAN_BASE_URL && process.env.ITSAPLAN_API_KEY && process.env.WEBHOOK_URL) {
  console.log("\n🔗 Kiểm tra & Kích hoạt Webhook trên Itsaplan:");
  try {
    const { ItsaplanClient } = await import("../lib/itsaplan/client");
    const { ensureItsaplanWebhook } = await import("../lib/itsaplan/ensure-webhook");
    const itsaplan = new ItsaplanClient(process.env.ITSAPLAN_BASE_URL, process.env.ITSAPLAN_API_KEY);
    const resTech = await ensureItsaplanWebhook(itsaplan, "TECH", process.env.WEBHOOK_URL);
    console.log(`  ✅ [TECH] ${resTech.message}`);
  } catch (err: any) {
    console.log(`  ⚠️ Lỗi kích hoạt webhook: ${err.message}`);
  }
}

console.log("\n------------------------------------------");
if (mcpErrors === 0 && agentErrors === 0) {
  console.log("🎉 TẤT CẢ FILE CẤU HÌNH, NHÃN & WEBHOOK ĐỀU SẴN SÀNG!");
  console.log("👉 Bạn có thể cắm trực tiếp apps/tieulinh/openclaw/openclaw.json vào OpenClaw để chạy.");
} else {
  console.error(`⚠️ Phát hiện ${mcpErrors + agentErrors} lỗi cần sửa chữa trước khi khởi chạy.`);
  process.exit(1);
}
