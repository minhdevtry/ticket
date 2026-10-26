/**
 * Các kịch bản gác tờ khai khi có sự cố mới (RFC 0002 PR 8, issue #22).
 *
 * Kiểm tra:
 * - B5: Định danh xung đột có nhãn cùng lớp (TECH-928), hỏi lại khi không rõ, "thôi huỷ".
 * - B6: Tờ khai dở + lời báo trọn vẹn (ngoại lệ câu hỏi dữ kiện/mô tả).
 * - A12: /new gác tờ khai dở, nút "Tiếp tục sự cố đang chờ" đưa tờ khai trở lại.
 * - Ba test "không mất dữ liệu bên nào".
 */
import { describe, expect, test } from "bun:test";
import { makeHarness, report, CHAT, type Harness } from "./engine-harness.fixture";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type { IntakeDraft } from "../draft/types";
import type { TechReviewerPort } from "../ports";
import { TECH_INFO_FIELD } from "./normalize";
import type { StepInput } from "./types";

function requireLatest(h: Harness): IntakeDraft {
  const d = h.drafts.getLatestByChatId(CHAT);
  if (!d) throw new Error("Expected latest draft to exist");
  return d;
}

function requireDraft(h: Harness, docId: string): IntakeDraft {
  const d = h.drafts.getByDocId(docId);
  if (!d) throw new Error(`Expected draft ${docId} to exist`);
  return d;
}

const REPORT_A = "Lỗi app Duo học sinh 0900000003 không làm bài được";
const CONFLICTING_B = "Đơn hàng DH900004 báo sai thời hạn khoá học, SĐT phụ huynh 0900000004";

/** Đưa chat tới trạng thái tóm tắt (ready_for_confirmation) của sự cố A. */
async function toSummary(h: Harness, message = REPORT_A): Promise<string> {
  h.extractor.push(
    report(["Lỗi app Duo không làm bài được"], {
      title: "Lỗi app Duo học sinh 0900000003 không làm bài được",
      values: { van_de: "không làm bài được" },
      identifiers: { studentAccount: "0900000003" },
    }),
  );
  const out = await h.engine.step({ chatId: CHAT, message });
  expect(out.outcome).toBe("summary");
  const latest = requireLatest(h);
  return latest.docId;
}

describe("PR 8 — Gác tờ khai khi có sự cố mới (RFC 0002 §1.5 B5, B6, A12)", () => {
  // ── Port các ca từ pipeline.flow.test.ts ───────────────────────────────────

  test('chọn "Bổ sung sự cố đang chờ" → gộp tin B vào CHÍNH tờ khai A (người dùng đã xác nhận là cùng sự cố)', async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);

    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    const asked = await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });
    expect(asked.outcome).toBe("parked");

    // Khi bổ sung, replay tin B vào draft A:
    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        values: { van_de: "sai thời hạn khoá học" },
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    const continueLabel = h.deps.copy.text("button.continue_draft");
    const merged = await h.engine.step({ chatId: CHAT, message: continueLabel });

    expect(merged.outcome).toBe("summary");
    const draftAfter = requireLatest(h);
    expect(draftAfter.docId).toBe(docIdA);
    expect(draftAfter.record?.values.studentAccount).toBe("0900000004");
    expect(draftAfter.ticket.rawText).toContain("0900000003");
    expect(draftAfter.ticket.rawText).toContain("0900000004");
  });

  test("trả lời không rõ (không bấm 1 trong 2 nút) → hỏi lại, không đoán, không mất dữ liệu bên nào", async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);

    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    const asked = await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });
    expect(asked.outcome).toBe("parked");

    const unclear = await h.engine.step({ chatId: CHAT, message: "hmm để em xem lại đã" });
    expect(unclear.outcome).toBe("parked");
    expect(unclear.messages[0].buttons).toBeTruthy();

    const draft = requireDraft(h, docIdA);
    expect(draft.record?.values.studentAccount).toBe("0900000003");
    expect(draft.parkedPayload?.text).toBe(CONFLICTING_B);
  });

  test('đang hỏi sự cố mới hay bổ sung, người dùng gõ "thôi huỷ" → bỏ tin vừa rồi, tờ khai A giữ nguyên', async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);

    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    const asked = await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });
    expect(asked.outcome).toBe("parked");

    const c = await h.engine.step({ chatId: CHAT, message: "thôi huỷ đi em" });
    expect(c.outcome).toBe("canceled");

    const a = requireDraft(h, docIdA);
    expect(a.parkedPayload).toBeUndefined();
    expect(a.record?.values.studentAccount).toBe("0900000003");
    expect(a.status).toBe("ready_for_confirmation");
  });

  test('B tạo ticket xong → ticket_created nhắc tên A kèm nút "Tiếp tục sự cố đang chờ"; bấm nút → quay lại đúng A (docId, SĐT, tiêu đề của A) chờ xác nhận', async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);
    const titleA = requireDraft(h, docIdA).ticket.title;

    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });

    // Bấm "Sự cố mới" -> mở B
    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        title: "Đơn hàng DH900004 sai thời hạn",
        values: { van_de: "sai thời hạn khoá học" },
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    const newIncidentLabel = h.deps.copy.text("button.new_incident");
    const freshB = await h.engine.step({ chatId: CHAT, message: newIncidentLabel });
    expect(freshB.outcome).toBe("summary");

    const draftB = requireLatest(h);
    expect(draftB.docId).not.toBe(docIdA);
    expect(draftB.parkedDocId).toBe(docIdA);

    // Xác nhận tạo ticket cho B
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 100);
    const confirmCreateLabel = h.deps.copy.text("button.confirm_create");
    const createdB = await h.engine.step({ chatId: CHAT, message: confirmCreateLabel });
    expect(createdB.outcome).toBe("created");

    // Nhắc về A: tiêu đề A xuất hiện trong tin, kèm nút tiếp tục
    expect(createdB.messages[0].text).toContain(titleA);
    const resumeLabel = h.deps.copy.text("button.resume_parked");
    const buttonLabels = (createdB.messages[0].buttons ?? []).flat().map((b) => b.callbackData);
    expect(buttonLabels).toContain(resumeLabel);

    // Bấm nút: A trở lại làm tài liệu đang mở, đúng docId, đúng dữ liệu gốc
    const resumed = await h.engine.step({ chatId: CHAT, message: resumeLabel });
    expect(resumed.outcome).toBe("summary");
    const draftResumed = requireLatest(h);
    expect(draftResumed.docId).toBe(docIdA);
    expect(draftResumed.record?.values.studentAccount).toBe("0900000003");
    expect(draftResumed.ticket.title).toBe(titleA);

    // Chỉ tạo duy nhất 1 ticket (cho B), không tự tạo ticket cho A
    expect(h.tracker.created).toHaveLength(1);
  });

  test("không có tờ khai nào bị gác lại → ticket_created bình thường, không có câu nhắc/nút phụ", async () => {
    const h = makeHarness();
    await toSummary(h, REPORT_A);

    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 100);
    const confirmCreateLabel = h.deps.copy.text("button.confirm_create");
    const created = await h.engine.step({ chatId: CHAT, message: confirmCreateLabel });

    expect(created.outcome).toBe("created");
    const resumeLabel = h.deps.copy.text("button.resume_parked");
    const buttonLabels = (created.messages[0].buttons ?? []).flat().map((b) => b.callbackData);
    expect(buttonLabels).not.toContain(resumeLabel);
  });

  test('B bị HUỶ (không tạo ticket) → packet "canceled" cũng nhắc về A còn đang chờ', async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);
    const titleA = requireDraft(h, docIdA).ticket.title;

    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });

    h.extractor.push(
      report(["sai thời hạn khoá học"], {
        title: "Đơn hàng DH900004",
        values: { van_de: "sai thời hạn" },
      }),
    );
    const newIncidentLabel = h.deps.copy.text("button.new_incident");
    await h.engine.step({ chatId: CHAT, message: newIncidentLabel });

    // Huỷ sự cố B
    h.extractor.push({ userIntent: "cancel" });
    const canceledB = await h.engine.step({ chatId: CHAT, message: "thôi hủy đi em" });
    expect(canceledB.outcome).toBe("canceled");

    expect(canceledB.messages[0].text).toContain(titleA);
    const resumeLabel = h.deps.copy.text("button.resume_parked");
    const buttonLabels = (canceledB.messages[0].buttons ?? []).flat().map((b) => b.callbackData);
    expect(buttonLabels).toContain(resumeLabel);

    // Bấm nút phục hồi A
    const resumed = await h.engine.step({ chatId: CHAT, message: resumeLabel });
    expect(resumed.outcome).toBe("summary");
    const draftResumed = requireLatest(h);
    expect(draftResumed.docId).toBe(docIdA);
    expect(draftResumed.record?.values.studentAccount).toBe("0900000003");
  });

  test("customerId thật không bị reground/xoá dù symptoms LLM paraphrase không còn chữ số (TECH-956)", async () => {
    const raw =
      "[TEST] 9100001 K TẠO ĐƯỢC ĐƠN HÀNG DO TRÙNG TÀI KHOẢN 2 CON ĐỀU LÀ CÙNG 1 SĐT. Hệ thống CRM, sản phẩm Tutor, em bên Sale";
    const h = makeHarness();
    h.extractor.push({
      userIntent: "report_issue",
      title: "Trùng tài khoản khi tạo đơn hàng CRM",
      symptoms: ["Trùng tài khoản khi tạo đơn hàng do hai con dùng chung một số điện thoại"],
      identifiers: { customerId: "9100001" },
      values: { van_de: "Trùng tài khoản" },
    });

    const r1 = await h.engine.step({ chatId: CHAT, message: raw });
    expect(r1.outcome).toBe("summary");

    const draft = requireLatest(h);
    expect(draft.record?.values.customerId).toBe("9100001");
    expect(draft.ticket.rawText).toContain("9100001");

    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 100);
    const r2 = await h.engine.step({
      chatId: CHAT,
      message: h.deps.copy.text("button.confirm_create"),
    });
    expect(r2.outcome).toBe("created");
    expect(h.tracker.created[0].description).toContain("9100001");
  });

  test("sau khi huỷ, lượt tiếp theo mở tài liệu mới và KHÔNG quên thông tin các lượt sau", async () => {
    const h = makeHarness();
    h.extractor.push({
      userIntent: "report_issue",
      symptoms: ["lỗi 1"],
      values: { van_de: "lỗi 1" },
    });
    await h.engine.step({ chatId: CHAT, message: "báo lỗi 1" });
    const docId1 = requireLatest(h).docId;

    h.extractor.push({ userIntent: "cancel" });
    const c = await h.engine.step({ chatId: CHAT, message: "thôi hủy đi em" });
    expect(c.outcome).toBe("canceled");

    // Tin tiếp theo mở tài liệu mới hoàn toàn
    h.extractor.push(
      report(["CRM lỗi 500"], {
        title: "CRM lỗi 500",
        values: { van_de: "CRM lỗi 500" },
        identifiers: { studentAccount: "0900000014" },
      }),
    );
    const n1 = await h.engine.step({
      chatId: CHAT,
      message: "CRM bị lỗi 500 khi mở đơn hàng của phụ huynh 0900000014",
    });
    expect(n1.outcome).toBe("summary");
    const docId2 = requireLatest(h).docId;
    expect(docId2).not.toBe(docId1);

    // Lượt sau trên cùng tài liệu mới
    h.extractor.push({
      userIntent: "provide_info",
      symptoms: [],
      values: { bo_phan: "Sale" },
    });
    const n2 = await h.engine.step({ chatId: CHAT, message: "Em bên Sale ạ" });
    expect(n2.outcome).toBe("summary");
    const draft2 = requireLatest(h);
    expect(draft2.docId).toBe(docId2);
    expect(draft2.record?.values.van_de).toBe("CRM lỗi 500");
    expect(draft2.record?.values.bo_phan).toBe("Sale");
  });

  // ── Ba test 'không mất dữ liệu bên nào' (Tiêu chí chấp nhận 2 & 4) ─────────

  test("không mất dữ liệu (1/3): chọn 'Sự cố mới' giữ nguyên 100% chữ và trường của tờ khai A, tờ khai B độc lập", async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);
    const draftABefore = requireDraft(h, docIdA);

    h.extractor.push(
      report(["báo lỗi B"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });

    h.extractor.push(
      report(["báo lỗi B"], {
        title: "Sự cố B",
        values: { van_de: "báo lỗi B" },
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: h.deps.copy.text("button.new_incident") });

    // Tờ khai A không mất 1 chữ nào
    const draftAAfter = requireDraft(h, docIdA);
    expect(draftAAfter.ticket.rawText).toBe(draftABefore.ticket.rawText);
    expect(draftAAfter.ticket.title).toBe(draftABefore.ticket.title);
    expect(draftAAfter.record?.values).toEqual(draftABefore.record?.values ?? {});
    expect(draftAAfter.parkedPayload).toBeUndefined();

    // Tờ khai B mang đầy đủ dữ liệu của B
    const draftB = requireLatest(h);
    expect(draftB.docId).not.toBe(docIdA);
    expect(draftB.ticket.rawText).toContain("0900000004");
    expect(draftB.record?.values.studentAccount).toBe("0900000004");
  });

  test("không mất dữ liệu (2/3): chọn 'Bổ sung sự cố đang chờ' gộp trọn vẹn cả nội dung A và B, không rơi rụng", async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);

    h.extractor.push(
      report(["nội dung bổ sung B"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });

    h.extractor.push(
      report(["nội dung bổ sung B"], {
        values: { van_de: "nội dung bổ sung B" },
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: h.deps.copy.text("button.continue_draft") });

    const merged = requireDraft(h, docIdA);
    // rawText chứa cả lời kể của A lẫn B
    expect(merged.ticket.rawText).toContain(REPORT_A);
    expect(merged.ticket.rawText).toContain(CONFLICTING_B);
    expect(merged.record?.values.studentAccount).toBe("0900000004");
  });

  test("không mất dữ liệu (3/3): chọn 'thôi huỷ' khi đang gác thì bỏ tin gác, tờ khai A giữ nguyên 100% dữ liệu", async () => {
    const h = makeHarness();
    const docIdA = await toSummary(h, REPORT_A);
    const draftABefore = requireDraft(h, docIdA);

    h.extractor.push(
      report(["tin B"], {
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    await h.engine.step({ chatId: CHAT, message: CONFLICTING_B });

    await h.engine.step({ chatId: CHAT, message: "thôi huỷ đi em" });

    const draftAAfter = requireDraft(h, docIdA);
    expect(draftAAfter.status).toBe("ready_for_confirmation");
    expect(draftAAfter.ticket.rawText).toBe(draftABefore.ticket.rawText);
    expect(draftAAfter.ticket.title).toBe(draftABefore.ticket.title);
    expect(draftAAfter.record?.values).toEqual(draftABefore.record?.values ?? {});
    expect(draftAAfter.parkedPayload).toBeUndefined();
  });

  // ── Ngoại lệ B6: không áp dụng khi đang trả lời câu hỏi dữ kiện / mô tả ─────

  test("B6 ngoại lệ: tờ khai đang hỏi short_description (gửi ảnh) → tin mới là lời báo trọn vẹn KHÔNG bị gác mà xử lý như câu trả lời bổ sung", async () => {
    const h = makeHarness();
    // Lượt 1: người báo gửi ảnh (chưa có mô tả), engine hỏi short_description
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const r1 = await h.engine.step({
      chatId: CHAT,
      message: "",
      mediaPaths: ["/tmp/screenshot.png"],
    });
    expect(r1.outcome).toBe("asked");
    expect(r1.missingFields).toEqual(["short_description"]);

    // Lượt 2: người báo gửi tiếp lời báo sự cố trọn vẹn (đủ triệu chứng, userIntent: report_issue)
    h.extractor.push(
      report(["học sinh 0900000003 không vào được phòng học"], {
        title: "Lỗi vào phòng học Duo",
        values: { van_de: "không vào được phòng" },
        identifiers: { studentAccount: "0900000003" },
      }),
    );
    const r2 = await h.engine.step({
      chatId: CHAT,
      message: "Dạ học sinh 0900000003 không vào được phòng học môn Toán ạ",
    });

    // B6 ngoại lệ: KHÔNG bị gác (outcome không phải parked) mà được xử lý vào tờ khai
    expect(r2.outcome).not.toBe("parked");
    expect(r2.outcome).toBe("summary");
    const draft = requireLatest(h);
    expect(draft.ticket.mediaPaths).toContain("/tmp/screenshot.png");
    expect(draft.ticket.rawText).toContain("0900000003");
  });

  test("B6 ngoại lệ: tờ khai đang hỏi câu hỏi kỹ thuật (__tech) → tin mới là lời báo trọn vẹn KHÔNG bị gác", async () => {
    const reviewer: TechReviewerPort = {
      review: async () => ({
        missing: ["mã phòng"],
        question: "Anh/chị cho em xin mã phòng học bị lỗi nhé ạ.",
      }),
    };
    const h = makeHarness({ techReviewer: reviewer });

    // Lượt 1: gửi báo cáo ban đầu, techReviewer hỏi thêm câu hỏi kỹ thuật (__tech)
    h.extractor.push(
      report(["lỗi vào phòng học"], {
        title: "Lỗi vào phòng học",
        values: { van_de: "lỗi vào phòng học" },
      }),
    );
    const r1 = await h.engine.step({ chatId: CHAT, message: "Lỗi vào phòng học" });
    expect(r1.outcome).toBe("asked");
    const draft1 = requireLatest(h);
    expect(draft1.lastAskedFields).toEqual([TECH_INFO_FIELD]);
    expect(draft1.ticket.title).toBe("Lỗi vào phòng học");

    // Lượt 2: người báo gửi một lời báo trọn vẹn (symptoms > 0, report_issue, có text)
    h.extractor.push(
      report(["phòng học P102 không kết nối được camera"], {
        title: "Lỗi camera phòng P102",
        values: { van_de: "không kết nối camera" },
      }),
    );
    const r2 = await h.engine.step({
      chatId: CHAT,
      message: "Dạ phòng học P102 không kết nối được camera của giáo viên ạ",
    });

    // B6 ngoại lệ: KHÔNG bị gác (outcome không phải parked) mà được xử lý tiếp
    expect(r2.outcome).not.toBe("parked");
    expect(r2.outcome).toBe("summary");
    const draft2 = requireLatest(h);
    expect(draft2.docId).toBe(draft1.docId);
  });

  test("B6 phân biệt: tờ khai đang hỏi trường dữ kiện khác (không phải __tech/short_description) và tin mới là lời báo trọn vẹn → CÓ bị gác", async () => {
    const h = makeHarness();

    // Lượt 1: gửi lời báo còn thiếu trường bắt buộc (van_de), engine hỏi van_de
    h.extractor.push({
      userIntent: "report_issue",
      symptoms: [],
      title: "Sự cố phòng học Duo",
    });
    const r1 = await h.engine.step({ chatId: CHAT, message: "Sự cố phòng học Duo" });
    expect(r1.outcome).toBe("asked");
    expect(r1.missingFields).toEqual(["van_de"]);
    const draft1 = requireLatest(h);
    expect(draft1.ticket.title).toBeTruthy();
    expect(draft1.lastAskedFields).toEqual(["van_de"]);

    // Lượt 2: người báo gửi một lời báo trọn vẹn mới (symptoms > 0, report_issue, có text)
    h.extractor.push(
      report(["CRM không hiển thị danh sách đơn hàng"], {
        title: "Lỗi CRM không hiển thị đơn",
        values: { van_de: "không hiển thị đơn hàng" },
      }),
    );
    const r2 = await h.engine.step({
      chatId: CHAT,
      message: "Hệ thống CRM bị lỗi không hiển thị danh sách đơn hàng của Sale",
    });

    // Không thuộc ngoại lệ B6: CÓ bị gác vì tờ khai dở đang hỏi trường dữ kiện khác
    expect(r2.outcome).toBe("parked");
    const draft2 = requireLatest(h);
    expect(draft2.docId).toBe(draft1.docId);
    expect(draft2.parkedPayload?.text).toContain("CRM bị lỗi");
  });

  // ── A12 nối liền: /new gác tờ khai đang dở → ticket created → resume ────────

  test("A12 nối liền: /new gác tờ khai đang dở → tạo ticket sự cố mới → nhận tin nhắc kèm nút resume → bấm nút phục hồi đúng tờ khai cũ giữ nguyên 100% dữ liệu", async () => {
    const h = makeHarness();
    // 1. Tạo tờ khai A tới trạng thái tóm tắt (chờ xác nhận)
    const docIdA = await toSummary(h, REPORT_A);
    const draftABefore = requireDraft(h, docIdA);
    const titleA = draftABefore.ticket.title;
    expect(titleA).toBeTruthy();

    // 2. Người dùng gõ /new (forceNew: true) kèm lời báo sự cố B
    h.extractor.push(
      report(["CRM lỗi 500 khi xuất báo cáo"], {
        title: "CRM lỗi 500 báo cáo",
        values: { van_de: "CRM lỗi 500" },
        identifiers: { studentAccount: "0900000004" },
      }),
    );
    const outB = await h.engine.step({
      chatId: CHAT,
      message: "CRM lỗi 500 khi xuất báo cáo của phụ huynh 0900000004",
      forceNew: true,
    } as StepInput);
    expect(outB.outcome).toBe("summary");

    // Tờ khai B độc lập, lưu parkedDocId trỏ tới A
    const draftB = requireLatest(h);
    expect(draftB.docId).not.toBe(docIdA);
    expect(draftB.parkedDocId).toBe(docIdA);

    // 3. Xác nhận tạo ticket cho sự cố B
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 100);
    const confirmCreateLabel = h.deps.copy.text("button.confirm_create");
    const createdB = await h.engine.step({ chatId: CHAT, message: confirmCreateLabel });
    expect(createdB.outcome).toBe("created");
    expect(h.tracker.created).toHaveLength(1);
    expect(h.tracker.created[0].title).toBe("CRM lỗi 500 báo cáo");

    // Tin createdB chứa lời nhắc về A và nút bấm phục hồi
    expect(createdB.messages[0].text).toContain(titleA);
    const resumeLabel = h.deps.copy.text("button.resume_parked");
    const buttonLabels = (createdB.messages[0].buttons ?? []).flat().map((b) => b.callbackData);
    expect(buttonLabels).toContain(resumeLabel);

    // 4. Bấm nút "Tiếp tục sự cố đang chờ"
    const resumed = await h.engine.step({ chatId: CHAT, message: resumeLabel });
    expect(resumed.outcome).toBe("summary");

    // Tờ khai cũ A được đưa trở lại làm tờ khai đang mở, giữ nguyên dữ liệu
    const draftAResumed = requireLatest(h);
    expect(draftAResumed.docId).toBe(docIdA);
    expect(draftAResumed.status).toBe("ready_for_confirmation");
    expect(draftAResumed.ticket.rawText).toBe(draftABefore.ticket.rawText);
    expect(draftAResumed.ticket.title).toBe(draftABefore.ticket.title);
    expect(draftAResumed.record?.values).toEqual(draftABefore.record?.values ?? {});
    expect(draftAResumed.parkedDocId).toBeUndefined();

    // Không tự tạo thêm ticket nào khác (chỉ 1 ticket của B đã tạo)
    expect(h.tracker.created).toHaveLength(1);
  });
});
