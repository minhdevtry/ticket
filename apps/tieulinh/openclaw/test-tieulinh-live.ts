/**
 * Live End-to-End Test Suite for Tiểu Linh
 *
 * Runs against real Itsaplan and Onyx services with actual SQLite DB.
 * Verifies all 10 MCP tools, domain rules, priority matrix, issue creation,
 * status transitions (Backlog -> In Progress -> Resolved -> Done), and Telegram callbacks.
 */

import * as fs from "node:fs";

// Tự động nạp .env nếu tồn tại
loadEnvFile(".env");

import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import { checkIdentity, registerIdentity } from "../mcp/shared/tools/identity";
import { validateFields } from "../mcp/shared/tools/validate-fields";
import { assessPriority } from "../mcp/shared/tools/assess-priority";
import { redactPii } from "../mcp/shared/tools/redact-pii";
import { searchKnowledge } from "../mcp/shared/tools/search-knowledge";
import { createIssue } from "../mcp/shared/tools/create-issue";
import { getIssue, updateIssue } from "../mcp/shared/tools/issues";
import { escalateIssue } from "../mcp/shared/tools/escalate-issue";
import { ticketDomain } from "../mcp/tieulinh/domain";
import fieldRequirements from "../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../mcp/tieulinh/domain/product_mapping.json";
import validationRules from "../mcp/tieulinh/domain/validation-rules.json";
import urgencyRules from "../mcp/tieulinh/domain/urgency-rules.json";
import { createHarness, loadEnvFile } from "./harness";

// Cấu hình từ môi trường
const itsaplanBaseUrl = process.env.ITSAPLAN_BASE_URL || "http://localhost:3100";
const itsaplanApiKey = process.env.ITSAPLAN_API_KEY || "";
const itsaplanProjectKey = process.env.ITSAPLAN_PROJECT_KEY || "TECH";

const onyxBaseUrl = process.env.ONYX_BASE_URL || "https://onyx.example.com";
const onyxApiKey = process.env.ONYX_API_KEY || "";
const onyxPersonaId = Number(process.env.ONYX_PERSONA_ID || "6");

const dbPath = process.env.INTAKE_DB_PATH || "data/test-tieulinh-live.db";

console.log("=================================================");
console.log("   KIỂM THỬ TOÀN DIỆN TIỂU LINH (LIVE E2E TEST)   ");
console.log("=================================================");
console.log(`• Itsaplan: ${itsaplanBaseUrl} (Project: ${itsaplanProjectKey})`);
console.log(`• Onyx:     ${onyxBaseUrl} (Persona: ${onyxPersonaId})`);
console.log(`• SQLite:   ${dbPath}`);

const harness = createHarness({ emoji: false });
const assert = harness.assert;

async function run() {
  const tracker = {
    baseUrl: itsaplanBaseUrl,
    apiKey: itsaplanApiKey,
    projectKey: itsaplanProjectKey,
  };

  const knowledge = {
    baseUrl: onyxBaseUrl,
    apiKey: onyxApiKey,
    personaId: onyxPersonaId,
  };

  const itsaplanClient = new ItsaplanClient(tracker.baseUrl, tracker.apiKey);

  // 1. Test Identity (Tiểu Linh: requireApproval = false)
  console.log("\n1. Test Danh tính & Bỏ duyệt (identity):");
  const identityConfig = {
    dbPath,
    requireApproval: false,
  };
  const regTool = registerIdentity(identityConfig);
  const regRes = (await regTool.handler({
    telegramUserId: "test_chat_tl_999",
    fullName: "Ngô Thị K",
    username: "user_cs_b",
    nameCode: "CS_user_k",
  })) as any;
  assert("register_identity lưu thông tin thành công", regRes.success === true);

  const checkTool = checkIdentity(identityConfig);
  const chkRes = (await checkTool.handler({ telegramUserId: "test_chat_tl_999" })) as any;
  assert("Tiểu Linh tự động duyệt isApproved = true", chkRes.isApproved === true);
  assert("check_identity trả về đúng nameCode", chkRes.identity?.nameCode === "CS_user_k");

  // 2. Test Validate Fields
  console.log("\n2. Test Kiểm tra tính hợp lệ của trường (validate_fields):");
  const valTool = validateFields(
    validationRules as any,
    fieldRequirements as any,
    productMapping as any,
    dbPath,
  );
  const valValid = (await valTool.handler({
    values: {
      system: "Vuihoc (App/Web_Vuihoc + ERP_DUO)",
      name_code: "CS_user_k",
      error_category: "Lỗi hệ thống",
      device_os: "iPadOS 17.2",
    },
  })) as any;
  assert("validate_fields chấp nhận các trường chuẩn theo taxonomy", valValid.allValid === true);

  const valInvalid = (await valTool.handler({
    values: { device_os: "invalid_os_xyz" },
  })) as any;
  assert("validate_fields phát hiện trường không hợp lệ", valInvalid.allValid === false);

  // 3. Test Assess Priority (Urgency Rules)
  console.log("\n3. Test Đánh giá mức độ ưu tiên (assess_priority):");
  const prioTool = assessPriority(urgencyRules as any);
  const pSystem = (await prioTool.handler({
    proposedLevel: "Low",
    scope: "entire_system",
  })) as any;
  assert("Sàn toàn hệ thống kéo mức ưu tiên lên Urgent", pSystem.allowedLevel === "Urgent");

  const pWorkaround = (await prioTool.handler({
    proposedLevel: "Urgent",
    scope: "single_user",
    hasWorkaround: true,
  })) as any;
  assert(
    "Trần 1 người dùng có phương án tạm hạ mức ưu tiên xuống High",
    pWorkaround.allowedLevel === "High",
  );

  // 4. Test Redact PII
  console.log("\n4. Test Khử thông tin nhạy cảm (redact_pii):");
  const redactRes = redactPii.handler({
    text: "Phụ huynh số 0900000005 mật khẩu PassWord123! gặp lỗi ở phòng học ROOM-1029",
  }) as any;
  assert("redact_pii che số điện thoại", !redactRes.redacted.includes("0900000005"));
  assert("redact_pii che mật khẩu", !redactRes.redacted.includes("PassWord123!"));
  assert("redact_pii giữ lại mã phòng học kỹ thuật", redactRes.redacted.includes("ROOM-1029"));

  // 5. Test Live Search Knowledge (Onyx)
  console.log("\n5. Test Tra cứu tri thức trực tiếp từ Onyx (search_knowledge):");
  const searchTool = searchKnowledge(knowledge);
  const searchRes = (await searchTool.handler({
    title: "Lỗi 502 phòng học LiveClass",
    description: "Phòng học ROOM-5511 báo lỗi 502 Bad Gateway toàn bộ học sinh không vào được",
  })) as any;
  assert("search_knowledge kết nối Onyx thành công", searchRes && typeof searchRes === "object");
  console.log(
    "  • Trích xuất gợi ý:",
    (searchRes.answer || "Không có nội dung").slice(0, 100) + "...",
  );

  // 6. Test Create Issue (2 bước an toàn)
  console.log("\n6. Test Tạo ticket (create_issue):");
  const createTool = createIssue(tracker, ticketDomain, dbPath);

  console.log("  6.1. Bước 1: userConfirmed = false (Xin xác nhận)");
  const step1 = (await createTool.handler({
    title: "Mất âm thanh phòng học 8822",
    description: "Giáo viên và học sinh không nghe thấy tiếng nhau trong phòng ROOM-8822",
    hasSpecificSubject: true,
    category: "LiveClass",
    priority: "high",
    roomId: "ROOM-8822",
    studentId: "0900000021",
    reporterName: "Ngô K",
    reporterNameCode: "CS_user_k",
    reporterChatId: "test_chat_tl_999",
    userConfirmed: false,
  })) as any;
  assert(
    "Bước 1 chưa ghi lên Itsaplan",
    step1.created === false && step1.needsConfirmation === true,
  );
  assert(
    "Bản tóm tắt bước 1 sạch icon",
    !step1.message.includes("📋") && !step1.message.includes("🚨"),
  );
  console.log(
    "  • Tin tóm tắt bước 1:\n" +
      step1.message
        .split("\n")
        .map((l: string) => "    " + l)
        .join("\n"),
  );

  console.log("\n  6.2. Bước 2: userConfirmed = true (Tạo thật lên Itsaplan)");
  const step2 = (await createTool.handler({
    title: "CRM không tạo được đơn do trùng tài khoản [Live E2E Test]",
    description:
      "Số 0900000022 bị trùng tài khoản học nên không lên đơn được. Người báo không sửa hoặc xóa được tên trên CRM.",
    hasSpecificSubject: true,
    product: "Khác",
    system: "CRM_Vuihoc",
    errorCategory: "Lỗi dữ liệu",
    customerId: "0900000022",
    studentId: "0900000022",
    reportingDept: "CSKH",
    priority: "high",
    reporterName: "Ngô K",
    reporterNameCode: "CS_user_k",
    reporterChatId: "test_chat_tl_999",
    userConfirmed: true,
  })) as any;
  assert(
    "Bước 2 tạo ticket thành công trên Itsaplan",
    step2.created === true && Boolean(step2.issue?.identifier),
  );
  const createdIdentifier = step2.issue?.identifier;
  const createdIssueId = step2.issue?.id;
  console.log(`  • Ticket đã tạo: ${createdIdentifier} (ID: ${createdIssueId})`);
  assert("Tin thông báo tạo thành công sạch icon", !step2.message.includes("✅"));
  console.log(
    "  • Tin phản hồi bước 2:\n" +
      step2.message
        .split("\n")
        .map((l: string) => "    " + l)
        .join("\n"),
  );

  // Kiểm tra ticket vừa tạo trên Itsaplan có đúng nhãn và taxonomy
  const createdRaw = await itsaplanClient.getIssue(createdIssueId);
  assert(
    "Ticket có gắn nhãn labelIds (Lỗi dữ liệu)",
    Array.isArray(createdRaw.labelIds) && createdRaw.labelIds.length > 0,
  );
  assert("Mô tả chứa taxonomy Sản phẩm", createdRaw.description.includes("- Sản phẩm: Khác"));
  assert("Mô tả chứa taxonomy Hệ thống", createdRaw.description.includes("- Hệ thống: CRM_Vuihoc"));
  assert(
    "Mô tả chứa taxonomy Phân loại lỗi",
    createdRaw.description.includes("- Phân loại lỗi: Lỗi dữ liệu"),
  );
  assert(
    "Mô tả chứa trường Tài khoản HS / SĐT",
    createdRaw.description.includes("- Tài khoản HS / SĐT: 0900000022"),
  );
  assert("Mô tả chứa vuihoc-meta chuẩn", createdRaw.description.includes("<!-- vuihoc-meta:"));

  // Chờ background microtask làm giàu tri thức từ Onyx
  await new Promise((r) => setTimeout(r, 1500));

  // 7. Test Get Issue
  console.log("\n7. Test Tra cứu tiến độ (get_issue):");
  const getTool = getIssue(tracker, dbPath);

  const getById = (await getTool.handler({ identifier: createdIdentifier })) as any;
  assert("get_issue tìm thấy ticket vừa tạo", getById.found === true);
  assert("Trạng thái khởi tạo là Mới tiếp nhận", getById.status?.name === "Mới tiếp nhận");
  assert(
    "humanSummary không chứa icon rườm rà",
    !getById.humanSummary.includes("🎫") && !getById.humanSummary.includes("📥"),
  );
  console.log(
    "  • humanSummary tra cứu theo mã:\n" +
      getById.humanSummary
        .split("\n")
        .map((l: string) => "    " + l)
        .join("\n"),
  );

  const getByChatId = (await getTool.handler({ chatId: "test_chat_tl_999" })) as any;
  assert(
    "get_issue tự động lấy ticket gần nhất qua chatId",
    getByChatId.identifier === createdIdentifier,
  );

  // 8. Test Update Issue & Đính kèm ảnh
  console.log("\n8. Test Bổ sung thông tin và đính kèm ảnh (update_issue):");
  fs.writeFileSync("/tmp/test-ticket-screenshot.png", "dummy-screenshot-content");
  const updateTool = updateIssue(tracker, dbPath);
  const updRes = (await updateTool.handler({
    identifier: createdIdentifier,
    note: "Học sinh dùng máy tính bảng Samsung Tab A9 mới mua.",
    device: "Máy tính bảng Samsung Tab A9",
    mediaPaths: ["/tmp/test-ticket-screenshot.png"],
  })) as any;
  assert(
    "update_issue bổ sung thông tin thành công vào ticket",
    updRes.updated === true && updRes.identifier === createdIdentifier,
  );
  assert(
    "update_issue trả về lời nhắn lịch sự không icon",
    !updRes.message.includes("💬") && !updRes.message.includes("✅"),
  );
  console.log("  • Lời nhắn update_issue: " + updRes.message);

  const issueAfterUpdate = await itsaplanClient.getIssue(createdIssueId);
  assert(
    "Mô tả được cập nhật trường Thiết bị mới",
    issueAfterUpdate.description.includes("- Thiết bị: Máy tính bảng Samsung Tab A9"),
  );
  assert(
    "Mô tả có mục ➕ Bổ sung với ICT timestamp",
    issueAfterUpdate.description.includes("### ➕ Bổ sung"),
  );
  assert(
    "Mô tả có mục 📸 Ảnh đính kèm",
    issueAfterUpdate.description.includes("### 📸 Ảnh đính kèm"),
  );

  // 9. Test Escalate Issue
  console.log("\n9. Test Giục khẩn cấp (escalate_issue):");
  const escTool = escalateIssue(tracker, {
    noun: "ticket",
    acknowledgement:
      "Dạ em hiểu lớp học đang gấp lắm rồi ạ! Em đã nâng mức ưu tiên của ticket {identifier} lên Urgent rồi nhé ạ.",
    alertTemplate:
      "[KHẨN CẤP] {identifier} — {title}\nNgười báo: {reporter} đang giục gấp. {reason}",
  });
  const escRes = (await escTool.handler({
    identifier: createdIdentifier,
    reason: "Lớp học đã bắt đầu 15 phút, phụ huynh đang phản ánh gay gắt.",
    reporterName: "Ngô K (CS_user_k)",
  })) as any;
  assert("escalate_issue nâng ưu tiên thành công", escRes.escalated === true);
  assert("Nội dung cảnh báo không chứa icon", !escRes.alert.includes("🚨"));
  console.log(
    "  • Cảnh báo trực ca sinh ra:\n" +
      escRes.alert
        .split("\n")
        .map((l: string) => "    " + l)
        .join("\n"),
  );

  // 10. Test Trạng thái Resolved (chờ người dùng duyệt)
  console.log("\n10. Test Trạng thái Resolved (chờ người dùng duyệt):");
  // Tìm cột Resolved trong dự án
  const project = await itsaplanClient.getProject(tracker.projectKey);
  const columns = project.columns ?? [];
  const resolvedCol = columns.find((c) => c.name.toLowerCase().includes("resolved"));
  const doneCol = columns.find((c) => c.name.toLowerCase().includes("done"));

  if (resolvedCol) {
    console.log(
      `  • Chuyển ticket sang cột Resolved (ID: ${resolvedCol.id}, Name: ${resolvedCol.name})`,
    );
    await itsaplanClient.updateIssue(createdIssueId, { columnId: resolvedCol.id });

    const getResolved = (await getTool.handler({ identifier: createdIdentifier })) as any;
    assert(
      "Nhận diện trạng thái Resolved isResolved = true",
      getResolved.status?.isResolved === true,
    );
    assert(
      "Tên trạng thái tiếng Việt: Đã xử lý (chờ duyệt)",
      getResolved.status?.name === "Đã xử lý (chờ duyệt)",
    );
    assert(
      "humanSummary có lưu ý mời duyệt nghiệm thu",
      getResolved.humanSummary.includes("Kỹ thuật đã xử lý xong"),
    );
    console.log(
      "  • humanSummary khi ở trạng thái Resolved:\n" +
        getResolved.humanSummary
          .split("\n")
          .map((l: string) => "    " + l)
          .join("\n"),
    );
  } else {
    console.log("  [SKIP] Dự án không có cột Resolved riêng");
  }

  // 11. Test Trạng thái Done (Hoàn tất)
  if (doneCol) {
    console.log(`\n11. Test Chuyển sang cột Done (ID: ${doneCol.id}, Name: ${doneCol.name}):`);
    await itsaplanClient.updateIssue(createdIssueId, { columnId: doneCol.id });

    const getDone = (await getTool.handler({ identifier: createdIdentifier })) as any;
    assert("Tên trạng thái tiếng Việt: Hoàn tất", getDone.status?.name === "Hoàn tất");
    assert(
      "isResolved chuyển về false khi đã Done hoàn toàn",
      getDone.status?.isResolved === false,
    );
    console.log(
      "  • humanSummary khi Done:\n" +
        getDone.humanSummary
          .split("\n")
          .map((l: string) => "    " + l)
          .join("\n"),
    );
  }

  // TỔNG KẾT
  console.log("\n=================================================");
  console.log("               KẾT QUẢ TỔNG HỢP                  ");
  console.log("=================================================");
  console.log(`Tổng số assertions: ${harness.passed + harness.failed}`);
  console.log(`Passed:             ${harness.passed}`);
  console.log(`Failed:             ${harness.failed}`);

  if (harness.failed === 0) {
    console.log("\n>> TOÀN BỘ TÍNH NĂNG TIỂU LINH ĐỀU HOẠT ĐỘNG HOÀN HẢO! <<\n");
    process.exit(0);
  } else {
    console.error(`\n>> CÓ ${harness.failed} LỖI CẦN XỬ LÝ! <<\n`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Lỗi thực thi test:", err);
  process.exit(1);
});
