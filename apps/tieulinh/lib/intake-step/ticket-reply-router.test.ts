import { describe, expect, it } from "bun:test";
import {
  applyEditOps,
  classifyCancelOrCloseIntent,
  countSpecialistTimelineComments,
  descriptionBody,
  isCancelOrCloseTicketRequest,
  LlmTicketCommandInterpreter,
  mentionedIdentifiers,
  MIN_SPECIALIST_COMMENTS_FOR_DONE,
  planEdit,
  stripSupplementCommandWrapper,
  type ReplyCandidate,
} from "./ticket-reply-router";
const llm = { baseUrl: "", apiKey: "", model: "m" };
const cand = {
  identifier: "TECH-795",
  issueId: 1,
  title: "Khoá gia hạn sai hạn",
  techQuestion: "đơn hàng nào sai?",
  ownTicket: true,
  mentioned: false,
};
const DESC = `## Thông tin sự cố

- Người báo: A - telegram:1
- Tài khoản HS / SĐT: 0900000006
- Bộ phận: CSKH

### Mô tả

> Khoá gia hạn sai hạn

![a.jpg](/attachments/1/raw)

---
*Nguồn: Tiểu Linh*`;

describe("mentionedIdentifiers", () => {
  it("nhận các cách viết mã ticket", () => {
    expect(mentionedIdentifiers("TECH-795 cập nhật", "TECH")).toEqual(["TECH-795"]);
    expect(mentionedIdentifiers("Ticket tech 722 đã ổn, tech722 nữa", "TECH")).toEqual([
      "TECH-722",
    ]);
    expect(mentionedIdentifiers("mã đơn DH900002", "TECH")).toEqual([]);
  });
});

describe("LlmTicketCommandInterpreter", () => {
  const run = (raw: string, candidates: any[] = [cand]) =>
    new LlmTicketCommandInterpreter(llm, async () => raw).interpret({
      message: "Đơn hàng gia hạn ạ",
      attachments: 0,
      candidates,
    });

  it("append / edit / lookup chỉ nhận mã trong ứng viên; câu kỹ thuật hỏi vào prompt", async () => {
    let user = "";
    const c = new LlmTicketCommandInterpreter(llm, async (_c: any, _s: string, u: string) => {
      user = u;
      return '{"action":"append","ticket":"tech-795","content":"Đơn hàng gia hạn ạ"}';
    });
    expect(
      await c.interpret({ message: "Đơn hàng gia hạn ạ", attachments: 0, candidates: [cand] }),
    ).toEqual({
      action: "append",
      identifier: "TECH-795",
      content: "Đơn hàng gia hạn ạ",
    });
    expect(user).toContain("đơn hàng nào sai?");
    expect(
      await run('{"action":"edit","ticket":"TECH-795","instruction":"SĐT thành 0393"}'),
    ).toEqual({ action: "edit", identifier: "TECH-795", instruction: "SĐT thành 0393" });
    expect(await run('{"action":"lookup","ticket":"TECH-795"}')).toEqual({
      action: "lookup",
      identifier: "TECH-795",
    });
    expect(await run('{"action":"append","ticket":"TECH-1"}')).toEqual({ action: "unclear" });
    expect(await run('{"action":"new"}')).toEqual({ action: "new" });
    expect(await run("???")).toEqual({ action: "unclear" });
  });

  it("move_created cần ticket vừa tạo làm nguồn", async () => {
    const created = {
      identifier: "TECH-975",
      issueId: 2,
      ownTicket: true,
      mentioned: false,
      justCreated: true,
    };
    expect(
      await run('{"action":"move_created","ticket":"TECH-795","from":"TECH-975"}', [cand, created]),
    ).toEqual({
      action: "move_created",
      from: "TECH-975",
      identifier: "TECH-795",
    });
    expect(
      await run('{"action":"move_created","ticket":"TECH-795","from":"TECH-975"}', [cand]),
    ).toEqual({ action: "unclear" });
  });
});

describe("sửa ticket", () => {
  it("planEdit lọc thao tác hợp lệ", async () => {
    const ops = await planEdit(
      llm,
      { title: "t", description: DESC, instruction: "x" },
      async () =>
        '{"ops":[{"type":"field","label":"Tài khoản HS / SĐT","value":"0900000015"},{"type":"bogus"},{"type":"title","value":" "}]}',
    );
    expect(ops).toEqual([{ type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" }]);
  });

  it("applyEditOps: sửa dòng có sẵn, thêm dòng mới vào cuối Thông tin sự cố, thay câu mô tả duy nhất", () => {
    const r = applyEditOps("Cũ", DESC, [
      { type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" },
      { type: "field", label: "Mã khách hàng", value: "90000006" },
      { type: "replace", old: "Khoá gia hạn sai hạn", new: "Khoá gia hạn DH900002 sai hạn" },
      { type: "replace", old: "không có", new: "x" },
      { type: "title", value: "Mới" },
    ]);
    expect(r.title).toBe("Mới");
    expect(r.description).toContain("- Tài khoản HS / SĐT: 0900000015");
    expect(r.description).toContain("- Bộ phận: CSKH\n- Mã khách hàng: 90000006\n\n### Mô tả");
    expect(r.description).toContain("> Khoá gia hạn DH900002 sai hạn");
    expect(r.rejected).toHaveLength(1);
    expect(r.changes.map((c) => c.what)).toEqual([
      "Tài khoản HS / SĐT",
      "Mã khách hàng",
      "Mô tả",
      "Tiêu đề",
    ]);
  });

  it("descriptionBody lấy phần Mô tả và ảnh", () => {
    const { body, images } = descriptionBody(DESC);
    expect(body).toContain("> Khoá gia hạn sai hạn");
    expect(body).not.toContain("Nguồn");
    expect(images).toEqual(["![a.jpg](/attachments/1/raw)"]);
  });

  it("mentionedIdentifiers nhận các kiểu người báo hay gõ (TECH-1001, 30/09)", () => {
    const ids = (t: string) => mentionedIdentifiers(t, "TECH");
    expect(ids("đây là ticket 989 mà")).toEqual(["TECH-989"]);
    expect(ids("Bổ sung TECH_989 video")).toEqual(["TECH-989"]);
    expect(ids("tech 1001 và #989")).toEqual(["TECH-1001", "TECH-989"]);
    expect(ids("tk 989 lỗi")).toEqual(["TECH-989"]);
    expect(ids("SĐT 0900000017 đơn DH900005 ticket")).toEqual([]);
    expect(ids("TECHTEST-795")).toEqual([]);
  });

  it("mentionedIdentifiers hỗ trợ khoá dự án có chữ số mà không khớp nhầm SĐT hay mã khác", () => {
    const ids = (t: string) => mentionedIdentifiers(t, "TECH2");
    expect(ids("TECH2-795 cập nhật")).toEqual(["TECH2-795"]);
    expect(ids("bổ sung tech2 722 và TECH2_989")).toEqual(["TECH2-722", "TECH2-989"]);
    expect(ids("ticket 989 và #501")).toEqual(["TECH2-989", "TECH2-501"]);
    expect(ids("SĐT 0900000005, 0900-000005, đơn DH900002, mã TECH2026")).toEqual([]);
  });
});

describe("nhận diện hủy / đóng ticket (ADR-0006 cập nhật 2026-10-10; TECH-951, TECH-999, TECH-1126, TECH-509)", () => {
  it("phân loại tất định các câu thật yêu cầu HỦY rõ → intent = 'cancel'", () => {
    const cancelCases = [
      "Hủy TECH-951",
      "Mình muốn hủy ticket TECH-951",
      "Hủy ticket TECH-951",
      "hủy TECH-951 vì học sinh đã vào được rồi",
      "hủy ticket TECH-999",
      "hủy ticket TECH-1126",
      "TECH-1126 dự kiến sẽ điều chỉnh sang form mới, nên không cần sửa nữa ạ",
      "HỦY ticket TECH-509",
      "TECH-926 crm mình gọi đc r, hủy ticket giúp mình",
      "bỏ ticket TECH-951",
      "TECH-951 không cần nữa ạ",
      "TECH-951 hủy giúp em nhé",
    ];
    for (const msg of cancelCases) {
      expect(isCancelOrCloseTicketRequest(msg)).toBe(true);
      expect(classifyCancelOrCloseIntent(msg)).toBe("cancel");
    }
  });

  it("phân loại tất định các câu yêu cầu ĐÓNG / báo đã dùng được (không kèm từ hủy) → intent = 'close'", () => {
    const closeCases = [
      "Đóng ticket TECH-999",
      "được rồi ạ, có thể đóc ticket TECH-999",
      "xin đóng TECH-999",
      "TECH-999 học sinh đã vào được rồi",
      "TECH-999 HS đã dùng được",
      "TECH-999 đã ổn rồi ạ",
    ];
    for (const msg of closeCases) {
      expect(isCancelOrCloseTicketRequest(msg)).toBe(true);
      expect(classifyCancelOrCloseIntent(msg)).toBe("close");
    }
  });

  it("không bắt nhầm câu sửa thật, chuyển ticket trùng, câu thiếu mã ticket hay mô tả sự cố có chữ hủy/đóng (≥20 câu thực tế)", () => {
    const nonCancelCases = [
      // Câu thiếu mã ticket (bắt buộc phải hỏi lại, không tự đoán):
      "không cần sửa nữa",
      "đóng cửa sổ",
      "hủy đơn hàng của học sinh",
      "đóng băng",
      "chương trình đóng/hủy lớp",
      "crm mình gọi đc r, hủy ticket giudp mình",
      // Câu mô tả sự cố thực tế có chữ hủy / đóng / vào được / ổn (không mã và có mã ticket):
      "Khi bấm đóng cửa sổ popup thì màn hình bị trắng xóa",
      "Em nhờ kỹ thuật hủy đơn hàng DH900002 của học sinh 0900000005 để tạo lại đơn mới",
      "Tài khoản học sinh đang bị đóng băng không mở khóa được",
      "Chương trình đóng/hủy lớp trên CRM báo lỗi 500",
      "Phụ huynh bấm nút hủy trên màn hình thanh toán thì bị treo",
      "Nhờ hỗ trợ đóng băng gói học cho học sinh Nguyễn Văn A",
      "Khi giáo viên đóng phòng học ROOM-5511 trên Zoom thì học sinh vẫn kẹt trong phòng",
      "Lỗi không hủy được quyền truy cập của giáo viên cũ trên CMS",
      "Học sinh vào được rồi nhưng sau 5 phút lại bị văng ra khỏi phòng học",
      "Lúc sáng đã vào được bình thường nhưng chiều nay lại báo lỗi không kết nối được",
      "Mạng nhà học sinh đã ổn rồi nhưng vào app Vuihoc vẫn quay tròn không tải được bài",
      "TECH-951 bổ sung: khi học sinh bấm đóng cửa sổ bài tập thì bị văng ra ngoài",
      "TECH-951 khách báo hủy gói cước gia hạn tự động không hoạt động",
      "TECH-999 học sinh vào được rồi nhưng không nghe thấy tiếng giáo viên",
      "TECH-999 lỗi giống lúc đóng băng bảo lưu tài khoản học sinh",
      "Bổ sung TECH-951: phần mềm tự đóng khi mở video bài giảng",
      "TECH-951: nút hủy bài kiểm tra bị liệt không bấm được",
      "TECH-951: nhờ tech hủy kích hoạt mã thẻ học thử giúp em",
      "TECH-951: giáo viên báo câu 3 không cần sửa nữa mà câu 4 bị lỗi hiển thị",
      "TECH-951: phụ huynh muốn hủy đơn hàng của học sinh",
      "TECH-951: chương trình đóng/hủy lớp không bấm được",
      "Lỗi giống TECH-951, học sinh đóng cửa sổ xong không mở lại được",
      // Câu sửa thật, gộp vé trùng, tra cứu, mơ hồ:
      "sửa TECH-795 SĐT thành 0900000015",
      "sửa mô tả TECH-795 thành học sinh không vào được phòng học",
      "đổi tiêu đề TECH-795 thành Lỗi đóng học phí",
      "sửa TECH-795: phụ huynh báo hủy lịch học",
      "nhầm rồi, cái này bổ sung cho TECH-795",
      "Đơn hàng gia hạn ạ",
      "TECH-795 học sinh vẫn không vào được",
      "TECH-795 tới đâu rồi",
      "TECH-795 ạ",
    ];
    for (const msg of nonCancelCases) {
      expect(isCancelOrCloseTicketRequest(msg)).toBe(false);
      expect(classifyCancelOrCloseIntent(msg)).toBeNull();
    }
  });

  it("LlmTicketCommandInterpreter định tuyến tất định sang cancel_or_close kể cả khi LLM trả edit / unclear", async () => {
    const cand951: ReplyCandidate = {
      identifier: "TECH-951",
      issueId: 824,
      ownTicket: true,
      mentioned: true,
    };
    const cand999: ReplyCandidate = {
      identifier: "TECH-999",
      issueId: 872,
      ownTicket: true,
      mentioned: true,
    };
    const cand1126: ReplyCandidate = {
      identifier: "TECH-1126",
      issueId: 1009,
      ownTicket: true,
      mentioned: true,
    };
    const cand1162: ReplyCandidate = {
      identifier: "TECH-1162",
      issueId: 1048,
      ownTicket: true,
      mentioned: false,
      recentlyRelayed: true,
    };
    const cand509: ReplyCandidate = {
      identifier: "TECH-509",
      issueId: 509,
      ownTicket: true,
      mentioned: true,
    };

    const misclassifiedEdit = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"edit","ticket":"TECH-951","instruction":"Hủy TECH-951"}',
    );
    expect(
      await misclassifiedEdit.interpret({
        message: "Hủy TECH-951",
        attachments: 0,
        candidates: [cand951],
      }),
    ).toEqual({
      action: "cancel_or_close",
      identifier: "TECH-951",
      content: "Hủy TECH-951",
      intent: "cancel",
    });
    expect(
      await misclassifiedEdit.interpret({
        message: "hủy TECH-951 vì học sinh đã vào được rồi",
        attachments: 0,
        candidates: [cand951],
      }),
    ).toEqual({
      action: "cancel_or_close",
      identifier: "TECH-951",
      content: "hủy TECH-951 vì học sinh đã vào được rồi",
      intent: "cancel",
    });

    const misclassifiedUnclear = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"unclear"}',
    );
    expect(
      await misclassifiedUnclear.interpret({
        message: "Đóng ticket TECH-999",
        attachments: 0,
        candidates: [cand999],
      }),
    ).toEqual({
      action: "cancel_or_close",
      identifier: "TECH-999",
      content: "Đóng ticket TECH-999",
      intent: "close",
    });
    expect(
      await misclassifiedUnclear.interpret({
        message: "được rồi ạ, có thể đóc ticket TECH-999",
        attachments: 0,
        candidates: [cand999],
      }),
    ).toEqual({
      action: "cancel_or_close",
      identifier: "TECH-999",
      content: "được rồi ạ, có thể đóc ticket TECH-999",
      intent: "close",
    });
    expect(
      await misclassifiedUnclear.interpret({
        message: "hủy ticket TECH-1126",
        attachments: 0,
        candidates: [cand1126],
      }),
    ).toEqual({
      action: "cancel_or_close",
      identifier: "TECH-1126",
      content: "hủy ticket TECH-1126",
      intent: "cancel",
    });
    // Ưu tiên ticket được nhắc mã (TECH-509) thay vì ticket khác vừa chuyển tiếp (TECH-1162).
    expect(
      await misclassifiedUnclear.interpret({
        message: "HỦY ticket TECH-509",
        attachments: 0,
        candidates: [cand1162, cand509],
      }),
    ).toEqual({
      action: "cancel_or_close",
      identifier: "TECH-509",
      content: "HỦY ticket TECH-509",
      intent: "cancel",
    });

    // Câu sửa mô tả thật vẫn là edit; câu mơ hồ vẫn là unclear.
    const editInterp = new LlmTicketCommandInterpreter(
      llm,
      async () =>
        '{"action":"edit","ticket":"TECH-795","instruction":"sửa mô tả thành học sinh không mở được bài"}',
    );
    expect(
      await editInterp.interpret({
        message: "sửa mô tả TECH-795 thành học sinh không mở được bài",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({
      action: "edit",
      identifier: "TECH-795",
      instruction: "sửa mô tả thành học sinh không mở được bài",
    });
    expect(
      await misclassifiedUnclear.interpret({
        message: "TECH-795 ạ",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({ action: "unclear" });
    // Không có mã ticket trong câu hoặc câu mô tả sự cố có chữ đóng/hủy → không tự đoán cancel_or_close.
    const hallucinatedCancel = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"cancel_or_close","ticket":"TECH-1162","content":"không cần sửa nữa"}',
    );
    expect(
      await hallucinatedCancel.interpret({
        message: "không cần sửa nữa",
        attachments: 0,
        candidates: [cand1162],
      }),
    ).toEqual({ action: "unclear" });
    const appendInterp = new LlmTicketCommandInterpreter(
      llm,
      async () =>
        '{"action":"append","ticket":"TECH-951","content":"khi bấm đóng cửa sổ thì bị đóng băng"}',
    );
    expect(
      await appendInterp.interpret({
        message: "TECH-951: khi bấm đóng cửa sổ thì bị đóng băng",
        attachments: 0,
        candidates: [cand951],
      }),
    ).toEqual({
      action: "append",
      identifier: "TECH-951",
      content: "khi bấm đóng cửa sổ thì bị đóng băng",
    });
  });

  it("countSpecialistTimelineComments chỉ đếm bình luận của chuyên viên TECH, loại bỏ bot và người báo", () => {
    expect(MIN_SPECIALIST_COMMENTS_FOR_DONE).toBe(3);
    const timeline = [
      {
        kind: "comment",
        actorUserId: "u-techlead-a",
        actorName: "TechLead_A",
        body: "@tieulinh Bạn gửi thêm danh sách lớp nhé",
      },
      {
        kind: "comment",
        actorUserId: "u-bot",
        actorName: "Tiểu Linh",
        body: "**SA_User*** bổ sung:\ndanh sách lớp\n\n<!-- intake-bot -->",
      },
      {
        kind: "comment",
        actorUserId: "u-bot2",
        actorName: "VUIHOC Tiểu Linh",
        body: "Thông báo tự động",
      },
      { kind: "comment", actorUserId: "u-admin", actorName: "admin", body: "script cập nhật" },
      { kind: "comment", actorUserId: "u-rep", actorName: "SA_User***", body: "Em gửi thêm" },
      {
        kind: "comment",
        actorUserId: "u-techlead-a",
        actorName: "TechLead_A",
        body: "@techuser_i Kiểm tra lại DB",
      },
      { kind: "comment", actorUserId: "u-loc", actorName: "TechUser_I", body: "Đã đồng bộ xong" },
      { kind: "activity", actorName: "TechLead_A", body: "status changed" },
    ];
    expect(
      countSpecialistTimelineComments(timeline, {
        reporterNames: ["SA_User***"],
        projectAssignees: [
          { userId: "u-techlead-a", name: "TechLead_A", username: "techlead_a", kind: "member" },
          { userId: "u-loc", name: "TechUser_I", username: "techuser_i", kind: "member" },
          { userId: "u-bot", name: "Tiểu Linh", username: "tieulinh", kind: "agent" },
          {
            userId: "u-bot2",
            name: "VUIHOC Tiểu Linh",
            username: "bot-ticket-intake",
            kind: "member",
          },
        ],
      }),
    ).toBe(3);
  });

  it("bóc vỏ câu lệnh bổ sung / đính kèm trần (TECH-1218: 'update vào tick TECH-1218') để không ghi câu lệnh thành comment", async () => {
    const cand1218: ReplyCandidate = {
      identifier: "TECH-1218",
      issueId: 1107,
      ownTicket: true,
      mentioned: true,
    };
    for (const bareCmd of [
      "update vào tick TECH-1218",
      "update TECH-1218",
      "bổ sung vào ticket TECH-1218",
      "đính kèm ảnh vào TECH-1218 giúp em nhé",
      "gắn ảnh vào ticket TECH-1218 ạ",
      "TECH-1218 bổ sung ạ",
      "ảnh bổ sung cho ticket TECH-1218",
    ]) {
      expect(stripSupplementCommandWrapper(bareCmd)).toEqual({
        isSupplementCommand: true,
        content: "",
      });
    }
    expect(
      stripSupplementCommandWrapper("update vào tick TECH-1218: học sinh bị chặn Vuihoc.vn"),
    ).toEqual({
      isSupplementCommand: true,
      content: "học sinh bị chặn Vuihoc.vn",
    });
    expect(stripSupplementCommandWrapper("nhầm rồi, cái này bổ sung cho TECH-795")).toEqual({
      isSupplementCommand: false,
      content: "nhầm rồi, cái này bổ sung cho TECH-795",
    });

    const unclearInterp = new LlmTicketCommandInterpreter(llm, async () => '{"action":"unclear"}');
    expect(
      await unclearInterp.interpret({
        message: "update vào tick TECH-1218",
        attachments: 0,
        candidates: [cand1218],
      }),
    ).toEqual({
      action: "append",
      identifier: "TECH-1218",
      content: "",
    });

    const echoInterp = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"append","ticket":"TECH-1218","content":"update vào tick TECH-1218"}',
    );
    expect(
      await echoInterp.interpret({
        message: "update vào tick TECH-1218",
        attachments: 1,
        candidates: [cand1218],
      }),
    ).toEqual({
      action: "append",
      identifier: "TECH-1218",
      content: "",
    });
  });
});
