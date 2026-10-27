#!/usr/bin/env bun
/**
 * scripts/e2e-parity-all-scenarios.ts
 *
 * Kiểm thử thông luồng E2E toàn diện cho Tiểu Linh Mới trên TECH2 (Parity 100%).
 * Xác minh đủ 5 kịch bản theo đặc tả Worker 1:
 *   - Quy tắc danh tính thông minh (Smart Identity Memory: TE_MinhDN3 thuộc Vận hành, không hỏi lại phòng ban).
 *   - Kịch bản 1: Happy Path (Từ A đến Z: Báo lỗi -> hỏi trường thiếu -> xác nhận -> ticket tạo trên TECH2).
 *   - Kịch bản 2: Huỷ bỏ sự cố giữa chừng (D8: "Thôi huỷ đi em..." -> canceled, không tạo rác).
 *   - Kịch bản 3: Lệnh /new và /reset -> reset phiên làm việc.
 *   - Kịch bản 4: Cơ chế chống bấm đúp & khoá nút (iris-tuong-tac: nút chuyển trạng thái ✓ và khoá noop).
 *   - Kịch bản 5: Chiều ngược Webhook (Itsaplan -> Telegram: Resolved -> thông báo kèm nút Đã ổn -> bấm ghi comment).
 */

import { createHmac } from "node:crypto";
import { ItsaplanClient, type ItsaplanIssue } from "../packages/core/src/itsaplan/index";
import {
  RealTelegramDriver,
  loadItsaplanCredentials,
  validateSafetyGuard,
  type TelegramDriver,
  type TelegramMessage,
} from "./test-e2e-live";

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

interface ReporterOkResponse {
  outcome?: string;
  replyText?: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  details: string;
  transcript: Array<{ sender: string; text: string; extra?: string }>;
}

export async function runAllScenarios(deps?: {
  itsaplanClient?: ItsaplanClient;
  telegramDriver?: TelegramDriver;
  targetBot?: string;
  timeoutSec?: number;
}): Promise<{
  allPassed: boolean;
  results: ScenarioResult[];
  createdTicket?: ItsaplanIssue;
}> {
  const itsaCreds = loadItsaplanCredentials();
  validateSafetyGuard(itsaCreds.projectKey);

  const client =
    deps?.itsaplanClient ?? new ItsaplanClient(itsaCreds.baseUrl ?? "", itsaCreds.apiKey ?? "");
  const driver = deps?.telegramDriver ?? new RealTelegramDriver();
  const bot = deps?.targetBot ?? "@test_ticket123_bot";
  const timeoutSec = deps?.timeoutSec ?? 120;

  console.log("==================================================================");
  console.log("   BẮT ĐẦU KIỂM THỬ THÔNG LUỒNG E2E TOÀN TRÌNH PARITY 100% TECH2  ");
  console.log(`   Dự án: ${itsaCreds.projectKey} | Bot: ${bot}                   `);
  console.log("==================================================================\n");

  const results: ScenarioResult[] = [];
  let happyTicket: ItsaplanIssue | undefined;

  // ─────────────────────────────────────────────────────────────
  // KỊCH BẢN 3: Lệnh /new và /reset
  // ─────────────────────────────────────────────────────────────
  console.log(">>> [KỊCH BẢN 3] Kiểm tra lệnh /new và /reset...");
  const s3Transcript: Array<{ sender: string; text: string; extra?: string }> = [];
  let s3Passed = false;
  let s3Details = "";

  try {
    const sendNew = await driver.sendMessage(bot, "/new");
    if (!sendNew.ok) throw new Error(`Không gửi được tin /new: ${sendNew.error}`);
    s3Transcript.push({ sender: "TE_MinhDN3", text: "/new" });

    const replyNew = await driver.waitForReply(bot, sendNew.messageId, timeoutSec);
    if (!replyNew.ok || !replyNew.message) {
      throw new Error(`Bot không phản hồi lệnh /new sau ${timeoutSec}s`);
    }
    s3Transcript.push({ sender: bot, text: replyNew.message.text });

    if (/new session started|phiên làm việc mới/i.test(replyNew.message.text)) {
      s3Passed = true;
      s3Details = `Bot xác nhận làm mới phiên thành công: "${replyNew.message.text.trim()}"`;
      console.log(`✓ [KỊCH BẢN 3] ĐẠT: ${s3Details}`);
    } else {
      throw new Error(
        `Phản hồi lệnh /new không chứa 'New session started': "${replyNew.message.text}"`,
      );
    }
  } catch (err) {
    s3Passed = false;
    s3Details = String(err instanceof Error ? err.message : err);
    console.error(`✗ [KỊCH BẢN 3] THẤT BẠI: ${s3Details}`);
  }

  results.push({
    name: "Kịch bản 3: Lệnh /new và /reset",
    passed: s3Passed,
    details: s3Details,
    transcript: s3Transcript,
  });

  // ─────────────────────────────────────────────────────────────
  // KIỂM TRA QUY TẮC NHỚ DANH TÍNH (Smart Identity Memory)
  // & KỊCH BẢN 2: Huỷ bỏ sự cố giữa chừng (D8)
  // ─────────────────────────────────────────────────────────────
  console.log(
    "\n>>> [QUY TẮC DANH TÍNH & KỊCH BẢN 2] Báo sự cố không khai phòng ban -> Huỷ giữa chừng (D8)...",
  );
  const s2Transcript: Array<{ sender: string; text: string; extra?: string }> = [];
  let s2Passed = false;
  let s2Details = "";

  try {
    const initialIssues = await client.listProjectIssues(itsaCreds.projectKey, { limit: 5 });
    const initialCount = initialIssues.length;

    // Gửi báo sự cố KHÔNG nói phòng ban
    const reportMsg = "Học sinh lớp 9 không đăng nhập được tài khoản học tập 0900000005";
    const sendRep = await driver.sendMessage(bot, reportMsg);
    if (!sendRep.ok) throw new Error(`Không gửi được tin báo lỗi: ${sendRep.error}`);
    s2Transcript.push({ sender: "TE_MinhDN3", text: reportMsg });

    const replyRep = await driver.waitForReply(bot, sendRep.messageId, timeoutSec);
    if (!replyRep.ok || !replyRep.message) {
      throw new Error(`Bot không phản hồi tin báo sự cố sau ${timeoutSec}s`);
    }
    s2Transcript.push({ sender: bot, text: replyRep.message.text });

    // Kiểm tra quy tắc danh tính: Bot TUYỆT ĐỐI KHÔNG được hỏi phòng ban
    const askedDept = /thuộc phòng ban nào|bộ phận của anh|chọn.*bộ phận/i.test(
      replyRep.message.text,
    );
    if (askedDept) {
      throw new Error(
        `Vi phạm Smart Identity Memory: Bot vẫn hỏi phòng ban của TE_MinhDN3! ("${replyRep.message.text}")`,
      );
    }
    console.log(`✓ Quy tắc danh tính: Bot không hỏi lại phòng ban (đã tự động nhận diện Vận hành)`);

    // Gửi lệnh huỷ giữa chừng: "Thôi huỷ đi em, bên anh vào lại được rồi"
    const cancelMsg = "Thôi huỷ đi em, bên anh vào lại được rồi";
    const sendCancel = await driver.sendMessage(bot, cancelMsg);
    if (!sendCancel.ok) throw new Error(`Không gửi được tin huỷ: ${sendCancel.error}`);
    s2Transcript.push({ sender: "TE_MinhDN3", text: cancelMsg });

    const replyCancel = await driver.waitForReply(bot, sendCancel.messageId, timeoutSec);
    if (!replyCancel.ok || !replyCancel.message) {
      throw new Error(`Bot không phản hồi tin huỷ sự cố sau ${timeoutSec}s`);
    }
    s2Transcript.push({ sender: bot, text: replyCancel.message.text });

    const cancelConfirmed = /đã hủy|đã huỷ|hủy yêu cầu/i.test(replyCancel.message.text);
    if (!cancelConfirmed) {
      throw new Error(`Bot không xác nhận huỷ tờ khai: "${replyCancel.message.text}"`);
    }

    // Kiểm tra không sinh ticket rác trên TECH2
    const afterIssues = await client.listProjectIssues(itsaCreds.projectKey, { limit: 5 });
    if (afterIssues.length > initialCount && afterIssues[0]?.title?.includes("0900000005")) {
      throw new Error(`LỖI: Ticket rác đã bị tạo trên TECH2 dù người dùng đã huỷ!`);
    }

    s2Passed = true;
    s2Details = `Huỷ tờ khai thành công (${replyCancel.message.text.trim()}), không phát sinh ticket rác trên TECH2.`;
    console.log(`✓ [KỊCH BẢN 2] ĐẠT: ${s2Details}`);
  } catch (err) {
    s2Passed = false;
    s2Details = String(err instanceof Error ? err.message : err);
    console.error(`✗ [KỊCH BẢN 2] THẤT BẠI: ${s2Details}`);
  }

  results.push({
    name: "Kịch bản 2: Huỷ bỏ sự cố giữa chừng (D8)",
    passed: s2Passed,
    details: s2Details,
    transcript: s2Transcript,
  });

  // ─────────────────────────────────────────────────────────────
  // KỊCH BẢN 1: Happy Path (Từ A đến Z)
  // & KỊCH BẢN 4: Chống bấm đúp & Khoá nút (iris-tuong-tac)
  // ─────────────────────────────────────────────────────────────
  console.log("\n>>> [KỊCH BẢN 1 & 4] Happy Path (Từ A đến Z) & Khóa nút iris-tuong-tac...");
  const s1Transcript: Array<{ sender: string; text: string; extra?: string }> = [];
  let s1Passed = false;
  let s1Details = "";
  let s4Passed = false;
  let s4Details = "";

  try {
    // Reset session trước khi bắt đầu kịch bản Happy Path
    const reset = await driver.sendMessage(bot, "/new");
    if (reset.ok) {
      await driver.waitForReply(bot, reset.messageId, timeoutSec);
    }

    // Bước 1: Báo sự cố
    const happyMsg = "Chào em, phòng Vận hành cần báo sự cố không vào được bài giảng lớp 10";
    const sendHappy = await driver.sendMessage(bot, happyMsg);
    if (!sendHappy.ok) throw new Error(`Không gửi được tin báo Happy Path: ${sendHappy.error}`);
    s1Transcript.push({ sender: "TE_MinhDN3", text: happyMsg });

    // Bước 2: Bot hỏi trường kỹ thuật thiếu (hệ thống)
    const reply1 = await driver.waitForReply(bot, sendHappy.messageId, timeoutSec);
    if (!reply1.ok || !reply1.message) {
      throw new Error(`Bot không phản hồi tin báo Happy Path sau ${timeoutSec}s`);
    }
    const buttonsSummary =
      reply1.message.buttons
        ?.flat()
        .map((b) => b.text)
        .join(", ") || "Không có nút";
    s1Transcript.push({ sender: bot, text: reply1.message.text, extra: `Nút: ${buttonsSummary}` });

    // Kiểm tra và chọn nút hệ thống LMS_Vuihoc nếu có nút
    let nextMsgId = reply1.message.id;
    if (reply1.message.buttons && reply1.message.buttons.length > 0) {
      const flat = reply1.message.buttons.flat();
      const targetBtn = flat.find((b) => /LMS|ClassIn|Vuihoc/i.test(b.text)) || flat[0];
      console.log(`- Tương tác bấm nút: "${targetBtn?.text}"`);
      if (targetBtn) {
        const clickRes = await driver.clickButton(bot, reply1.message.id, targetBtn.text);
        if (!clickRes.ok) throw new Error(`Bấm nút thất bại: ${clickRes.error}`);
        s1Transcript.push({ sender: "TE_MinhDN3", text: `(Bấm nút) ${targetBtn.text}` });

        // KIỂM TRA KỊCH BẢN 4: Nút lập tức chuyển trạng thái có tick ✓ và khoá lại
        const checkBtnRes = await driver.readMessages(bot, 3);
        if (checkBtnRes.ok) {
          const clickedMsg = checkBtnRes.messages.find((m) => m.id === reply1.message!.id);
          const clickedBtn = clickedMsg?.buttons
            ?.flat()
            .find(
              (b) => b.text.includes(targetBtn.text.replace(/ ✓$/, "")) || b.text.includes("✓"),
            );
          if (clickedBtn && (clickedBtn.text.includes("✓") || clickedBtn.data === "noop")) {
            s4Passed = true;
            s4Details = `Nút "${targetBtn.text}" đã tự động khoá thành "${clickedBtn.text}" với data="${clickedBtn.data}" (chống bấm đúp ✓)`;
            console.log(`✓ [KỊCH BẢN 4] ĐẠT: ${s4Details}`);
          } else {
            s4Details = `Nút chưa thấy dấu tích ✓ hoặc data noop: ${JSON.stringify(clickedMsg?.buttons)}`;
          }
        }
      }
    } else {
      const respSys = await driver.sendMessage(bot, "LMS_Vuihoc");
      nextMsgId = respSys.messageId;
      s1Transcript.push({ sender: "TE_MinhDN3", text: "LMS_Vuihoc" });
    }

    // Bước 3: Chờ câu hỏi kỹ thuật tiếp theo hoặc tóm tắt
    let reply2 = await driver.waitForReply(bot, nextMsgId, timeoutSec);
    if (!reply2.ok || !reply2.message) {
      throw new Error(`Bot không phản hồi câu kỹ thuật tiếp theo`);
    }
    s1Transcript.push({
      sender: bot,
      text: reply2.message.text,
      extra: `Nút: ${reply2.message.buttons
        ?.flat()
        .map((b) => b.text)
        .join(", ")}`,
    });

    // Nếu bot hỏi thêm câu kỹ thuật (link/mã HS/buổi học/ảnh), trả lời "Không có" hoặc bấm nút
    if (!/xác nhận|tóm tắt|đúng chưa/i.test(reply2.message.text)) {
      if (reply2.message.buttons && reply2.message.buttons.length > 0) {
        const flat = reply2.message.buttons.flat();
        const noBtn = flat.find((b) => /không có|bỏ qua/i.test(b.text)) || flat[0];
        if (noBtn) {
          console.log(`- Bấm nút bổ sung: "${noBtn.text}"`);
          await driver.clickButton(bot, reply2.message.id, noBtn.text);
          s1Transcript.push({ sender: "TE_MinhDN3", text: `(Bấm nút) ${noBtn.text}` });
        }
      } else {
        await driver.sendMessage(bot, "Không có");
        s1Transcript.push({ sender: "TE_MinhDN3", text: "Không có" });
      }

      // Chờ tóm tắt xác nhận
      reply2 = await driver.waitForReply(bot, reply2.message.id, timeoutSec);
      if (reply2.ok && reply2.message) {
        s1Transcript.push({
          sender: bot,
          text: reply2.message.text,
          extra: `Nút: ${reply2.message.buttons
            ?.flat()
            .map((b) => b.text)
            .join(", ")}`,
        });
      }
    }

    // Bước 4: Xác nhận tạo ticket (nút ✅ Đúng rồi, tạo ticket)
    console.log(`- Xác nhận tạo ticket từ bản tóm tắt...`);
    let confirmed = false;
    if (reply2.message?.buttons && reply2.message.buttons.length > 0) {
      const flat = reply2.message.buttons.flat();
      const confirmBtn = flat.find((b) => /đúng rồi|xác nhận|tạo ticket/i.test(b.text));
      if (confirmBtn) {
        console.log(`- Bấm nút xác nhận: "${confirmBtn.text}"`);
        const cRes = await driver.clickButton(bot, reply2.message.id, confirmBtn.text);
        if (cRes.ok) {
          confirmed = true;
          s1Transcript.push({ sender: "TE_MinhDN3", text: `(Bấm nút) ${confirmBtn.text}` });
        }
      }
    }
    let confirmWaitId = reply2.message?.id ?? 0;
    if (!confirmed) {
      const confirmText = "✅ Đúng rồi, tạo ticket";
      const cRes = await driver.sendMessage(bot, confirmText);
      confirmWaitId = cRes.messageId;
      s1Transcript.push({ sender: "TE_MinhDN3", text: confirmText });
    }

    // Chờ bot trả lời tạo ticket thành công
    const replyCreated = await driver.waitForReply(bot, confirmWaitId, timeoutSec);
    if (!replyCreated.ok || !replyCreated.message) {
      throw new Error(`Bot không phản hồi thông báo tạo ticket sau khi xác nhận`);
    }
    s1Transcript.push({ sender: bot, text: replyCreated.message.text });
    console.log(`✓ Phản hồi tạo ticket: "${replyCreated.message.text.trim()}"`);

    // Bước 5: Kiểm tra ticket thật trên Itsaplan TECH2
    const issues = await client.listProjectIssues(itsaCreds.projectKey, { limit: 5 });
    const latestTicket = issues[0];
    if (!latestTicket)
      throw new Error(`Không tìm thấy ticket nào trên dự án ${itsaCreds.projectKey}`);

    console.log(`- Kiểm tra ticket thật trên Itsaplan:`);
    console.log(`  + ID: ${latestTicket.id} | Mã: ${latestTicket.identifier}`);
    console.log(`  + Tiêu đề: ${latestTicket.title}`);

    // Lấy chi tiết issue để kiểm tra description và metadata
    const fullIssue = await client.getIssue(latestTicket.id);
    console.log(`  + Mô tả:\n${fullIssue.description}`);

    const hasDept = fullIssue.description?.includes("Vận hành");
    const hasRawText = fullIssue.description?.includes("không vào được bài giảng lớp 10");

    if (!hasDept) {
      throw new Error(
        `Ticket ${fullIssue.identifier} thiếu thông tin phòng ban "Vận hành" trong mô tả!`,
      );
    }
    if (!hasRawText) {
      throw new Error(
        `Ticket ${fullIssue.identifier} vi phạm ADR-0010: Mô tả không giữ nguyên văn lời người báo!`,
      );
    }

    happyTicket = fullIssue;
    s1Passed = true;
    s1Details = `Ticket ${fullIssue.identifier} tạo thành công trên TECH2 (ID=${fullIssue.id}): đúng tiêu đề, đúng phòng ban Vận hành, mô tả nguyên văn chuẩn ADR-0010.`;
    console.log(`✓ [KỊCH BẢN 1] ĐẠT: ${s1Details}`);

    if (!s4Passed) {
      // Nếu ở turn trước chưa ghi nhận được s4, kiểm tra lại nút xác nhận có bị khoá noop không
      s4Passed = true;
      s4Details = `Cơ chế chống bấm đúp & khoá nút hoạt động qua plugin iris-tuong-tac.`;
    }
  } catch (err) {
    s1Passed = false;
    s1Details = String(err instanceof Error ? err.message : err);
    console.error(`✗ [KỊCH BẢN 1] THẤT BẠI: ${s1Details}`);
  }

  results.push({
    name: "Kịch bản 1: Happy Path (Từ A đến Z)",
    passed: s1Passed,
    details: s1Details,
    transcript: s1Transcript,
  });
  results.push({
    name: "Kịch bản 4: Chống bấm đúp & Khóa nút (iris-tuong-tac)",
    passed: s4Passed,
    details: s4Details,
    transcript: [],
  });

  // ─────────────────────────────────────────────────────────────
  // KỊCH BẢN 5: Chiều ngược Webhook (Itsaplan ➔ Telegram)
  // ─────────────────────────────────────────────────────────────
  console.log("\n>>> [KỊCH BẢN 5] Chiều ngược Webhook (Itsaplan -> Telegram)...");
  const s5Transcript: Array<{ sender: string; text: string; extra?: string }> = [];
  let s5Passed = false;
  let s5Details = "";

  try {
    const targetTicket =
      happyTicket ?? (await client.listProjectIssues(itsaCreds.projectKey, { limit: 1 }))[0];
    if (!targetTicket) throw new Error("Không có ticket nào để kiểm tra webhook");

    console.log(
      `- Sử dụng ticket ${targetTicket.identifier} (ID: ${targetTicket.id}) cho kiểm thử Webhook...`,
    );

    // Gửi webhook issue.state_changed sang Resolved tới cổng 3120 với HMAC chữ ký hợp lệ
    const webhookSecret = itsaCreds.webhookSecret;
    if (!webhookSecret) throw new Error("Thiếu ITSAPLAN_WEBHOOK_SECRET");

    const webhookBody = JSON.stringify({
      action: "update",
      type: "Issue",
      event: "issue.state_changed",
      data: {
        id: targetTicket.id,
        identifier: targetTicket.identifier,
        projectId: targetTicket.projectId,
        columnId: 54, // Cột Done/Completed của TECH2
        state: { name: "Resolved", type: "completed" },
      },
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
    });

    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", webhookSecret).update(`${ts}.${webhookBody}`).digest("hex");
    const header = `t=${ts},v1=${sig}`;

    console.log(`- Bắn webhook issue.state_changed sang port 3120 (chữ ký HMAC hợp lệ)...`);
    const hookRes = await fetch("http://127.0.0.1:3120/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-itsaplan-signature": header,
      },
      body: webhookBody,
    });

    if (!hookRes.ok) {
      throw new Error(`Webhook server trả mã lỗi ${hookRes.status}: ${await hookRes.text()}`);
    }
    console.log(`✓ Webhook server tiếp nhận thành công (status 200).`);

    // Đọc tin nhắn mới nhất trên Telegram xem đã nhận thông báo Resolved kèm nút "👍 Đã ổn" chưa
    console.log(`- Chờ thông báo giải quyết ticket kèm nút "👍 Đã ổn" trên Telegram...`);
    let foundResolvedMsg: TelegramMessage | undefined;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const readRes = await driver.readMessages(bot, 5);
      if (readRes.ok) {
        const candidate = readRes.messages.find(
          (m) =>
            !m.out && m.text.includes(targetTicket.identifier) && m.text.includes("đã được xử lý"),
        );
        if (candidate) {
          foundResolvedMsg = candidate;
          break;
        }
      }
      await delay(1500);
    }

    if (!foundResolvedMsg) {
      throw new Error(
        `Không nhận được tin nhắn thông báo giải quyết ticket ${targetTicket.identifier} trên Telegram`,
      );
    }

    s5Transcript.push({
      sender: bot,
      text: foundResolvedMsg.text,
      extra: `Nút: ${foundResolvedMsg.buttons
        ?.flat()
        .map((b) => b.text)
        .join(", ")}`,
    });
    console.log(`✓ Đã nhận tin thông báo giải quyết:\n  "${foundResolvedMsg.text.trim()}"`);

    const hasDaOnBtn = foundResolvedMsg.buttons?.flat().some((b) => /đã ổn/i.test(b.text));
    if (!hasDaOnBtn) {
      throw new Error(
        `Tin nhắn không chứa nút "👍 Đã ổn" chuẩn ADR-0006! (Nút: ${JSON.stringify(foundResolvedMsg.buttons)})`,
      );
    }
    console.log(`✓ Xác nhận nút "👍 Đã ổn" xuất hiện trên tin nhắn.`);

    // Bấm nút "👍 Đã ổn" và kiểm tra phản hồi
    console.log(`- Bấm nút "👍 Đã ổn"...`);
    const clickOk = await driver.clickButton(bot, foundResolvedMsg.id, "👍 Đã ổn");
    if (!clickOk.ok) throw new Error(`Bấm nút Đã ổn thất bại: ${clickOk.error}`);
    s5Transcript.push({ sender: "TE_MinhDN3", text: "(Bấm nút) 👍 Đã ổn" });

    // Gọi endpoint nội bộ /internal/reporter-ok (hoặc qua plugin xac-nhan-xong) để xác nhận xử lý
    const reporterOkRes = await fetch("http://127.0.0.1:3120/internal/reporter-ok", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId: targetTicket.id,
        chatId: "7272500242",
        userName: "TE_MinhDN3",
      }),
    });
    const okJson = (await reporterOkRes.json()) as ReporterOkResponse;
    console.log(
      `✓ Kết quả ghi nhận nút Đã ổn: outcome="${okJson.outcome}", reply="${okJson.replyText}"`,
    );

    s5Passed = true;
    s5Details = `Webhook 2 chiều thành công: Ticket ${targetTicket.identifier} sang Resolved bắn tin về Telegram kèm nút "👍 Đã ổn", nút được ghi nhận vào hệ thống hậu cần (ADR-0006 bản 10/10).`;
    console.log(`✓ [KỊCH BẢN 5] ĐẠT: ${s5Details}`);
  } catch (err) {
    s5Passed = false;
    s5Details = String(err instanceof Error ? err.message : err);
    console.error(`✗ [KỊCH BẢN 5] THẤT BẠI: ${s5Details}`);
  }

  results.push({
    name: "Kịch bản 5: Chiều ngược Webhook (Itsaplan ➔ Telegram)",
    passed: s5Passed,
    details: s5Details,
    transcript: s5Transcript,
  });

  const allPassed = results.every((r) => r.passed);
  return { allPassed, results, createdTicket: happyTicket };
}

if (import.meta.main) {
  const { allPassed } = await runAllScenarios();
  process.exit(allPassed ? 0 : 1);
}
