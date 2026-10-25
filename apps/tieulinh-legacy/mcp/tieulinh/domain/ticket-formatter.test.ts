import { describe, expect, test } from "bun:test";
import {
  appendTicketUpdateDescription,
  buildAdviceComment,
  cleanMediaTags,
  formatConfirmationMessage,
  formatIctTimestamp,
  formatTicketDescription,
  splitDiagnosis,
} from "./ticket-formatter";
import { symptomsOfDescription } from "../../../lib/kg/similar-finder";
import type { IncidentDetails } from "./types";

const incident: IncidentDetails = {
  title: "[LiveClass] Phòng ROOM-5511 lỗi 502",
  product: "LiveClass",
  category: "LiveClass",
  environment: "Production",
  priority: "high",
  roomCode: "ROOM-5511",
  studentAccount: "0900000005",
  // Chứa cả 2 mã ở trên để qua được chốt grounding (giá trị định danh phải
  // thấy trong lời kể của người báo) — xem groundIdentifierFields.
  rawText: "Vào phòng ROOM-5511 báo lỗi 502, SĐT phụ huynh 0900000005",
  imageUrls: [],
};

/** A description shaped the way `create_ticket` actually writes one. */
function existingDescription(): string {
  return formatTicketDescription({
    incident,
    reporter: { name: "Nguyễn Văn A (CS01)", username: "user_a" },
  });
}

describe("cleanMediaTags", () => {
  test("removes the attachment marker the channel leaves behind", () => {
    expect(cleanMediaTags("Lỗi 502 [media attached: /tmp/a.png (image/png)]")).toBe("Lỗi 502");
  });

  test("removes the angle-bracket form too", () => {
    expect(cleanMediaTags("Ảnh đây <media:photo id=3> lỗi 502")).toBe("Ảnh đây  lỗi 502");
  });

  test("survives a missing description", () => {
    expect(cleanMediaTags(null)).toBe("");
    expect(cleanMediaTags(undefined)).toBe("");
  });
});

describe("formatIctTimestamp", () => {
  test("reports the hour people in the office would recognise", () => {
    // 02:30 UTC is 09:30 in Hanoi; a ticket stamped 02:30 reads as wrong.
    expect(formatIctTimestamp(new Date("2026-03-14T02:30:00Z"))).toBe("2026-03-14 09:30");
  });

  test("rolls the date over when UTC evening is the next Vietnamese day", () => {
    expect(formatIctTimestamp(new Date("2026-03-14T18:00:00Z"))).toBe("2026-03-15 01:00");
  });
});

describe("splitDiagnosis", () => {
  test("turns a bulleted runbook answer into points", () => {
    const points = splitDiagnosis("- Kiểm tra pod livekit\n- Restart lại gateway phòng học");
    expect(points).toEqual(["Kiểm tra pod livekit", "Restart lại gateway phòng học"]);
  });

  test("drops the headings a RAG answer wraps its points in", () => {
    const points = splitDiagnosis("## Nguyên nhân\n- Pod livekit hết bộ nhớ");
    expect(points).toEqual(["Pod livekit hết bộ nhớ"]);
  });

  test("keeps a substantial plain sentence but not a fragment", () => {
    const points = splitDiagnosis("Ngắn quá\nLỗi 502 thường do gateway phòng học bị quá tải.");
    expect(points).toEqual(["Lỗi 502 thường do gateway phòng học bị quá tải."]);
  });

  test("caps the ticket at six points so the description stays readable", () => {
    const points = splitDiagnosis(
      Array.from({ length: 10 }, (_, i) => `- Bước xử lý số ${i + 1}`).join("\n"),
    );
    expect(points).toHaveLength(6);
  });

  test("falls back to the raw text rather than returning nothing", () => {
    expect(splitDiagnosis("ngắn")).toEqual(["ngắn"]);
  });
});

describe("buildAdviceComment", () => {
  test("gộp nguyên nhân đã biết + gợi ý runbook thành một comment của bot", () => {
    const body = buildAdviceComment(
      "Triệu chứng khớp nhóm lịch sử",
      "- Kiểm tra dữ liệu BTVN buổi học",
    );
    expect(body).toContain("Gợi ý chuyên môn");
    expect(body).toContain("Triệu chứng khớp nhóm lịch sử");
    expect(body).toContain("- Kiểm tra dữ liệu BTVN buổi học");
  });

  test("giữ câu hỏi phân biệt khi sự cố mơ hồ (CONTEXT.md, ADR-0007)", () => {
    const body = buildAdviceComment(null, "Có thể liên quan (chưa chắc): kiểm tra CRM hay lịch?");
    expect(body).toContain("Có thể liên quan (chưa chắc)");
  });

  test("trả null khi rỗng hoặc chỉ là câu 'không tìm thấy' — không tạo comment rác", () => {
    expect(buildAdviceComment(undefined, undefined)).toBeNull();
    expect(buildAdviceComment("", "")).toBeNull();
    expect(
      buildAdviceComment(null, "- Chưa xác định được đây là lỗi đã biết trong tài liệu"),
    ).toBeNull();
    expect(buildAdviceComment(null, "- Không trả về tài liệu nào")).toBeNull();
  });
});

describe("formatTicketDescription", () => {
  test("never writes null or undefined into a field a human will read", () => {
    const description = formatTicketDescription({
      incident: { ...incident, deviceType: "null", reportingDept: "undefined", browser: "" },
      reporter: { name: "Nguyễn Văn A", username: "user_a" },
    });

    expect(description).not.toContain("null");
    expect(description).not.toContain("undefined");
  });

  test("does not repeat the username when the display name already carries it", () => {
    const description = formatTicketDescription({
      incident,
      reporter: { name: "user_a", username: "@user_a" },
    });

    const reporterLine = description.split("\n").find((l) => l.startsWith("- Người báo:"))!;
    expect(reporterLine).toBe("- Người báo: user_a");
  });

  test("shows the priority only when the bot overrode what the reporter asked for", () => {
    const asked = formatTicketDescription({
      incident: { ...incident, suggestedPriority: "high" },
    });
    expect(asked).not.toContain("- Ưu tiên:");

    const overridden = formatTicketDescription({
      incident: { ...incident, suggestedPriority: "low" },
    });
    expect(overridden).toContain("- Ưu tiên: HIGH (người báo đề xuất: LOW)");
  });

  test("never plainly restates category or priority — both already sit on the properties bar", () => {
    const description = formatTicketDescription({
      incident: { ...incident, errorCategory: "Lỗi kỹ thuật", priority: "urgent" },
    });
    expect(description).not.toContain("Phân loại lỗi");
    expect(description).not.toContain("- Ưu tiên: Urgent");
  });

  test("never lets the bot's own reasoning reach the description (TECH-1084)", () => {
    const description = formatTicketDescription({
      incident: { ...incident, diagnosis: "Cần đối chiếu dữ liệu BTVN trên hệ thống Gia sư" },
    });
    expect(description).not.toContain("Chẩn đoán");
    expect(description).not.toContain("Cần đối chiếu");
  });

  test("mô tả là NGUYÊN VĂN lời kể, không phải bản LLM viết lại", () => {
    const description = formatTicketDescription({
      incident: {
        ...incident,
        rawText: "Vào phòng ROOM-5511 báo lỗi 502, SĐT phụ huynh 0900000005",
        symptoms: "AI tóm tắt: phòng học hỏng, cần đối chiếu log",
      },
    });
    expect(description).toContain("> Vào phòng ROOM-5511 báo lỗi 502");
    expect(description).not.toContain("AI tóm tắt");
  });

  test("carries a machine-readable copy of the metadata for later updates", () => {
    const description = formatTicketDescription({ incident });
    const meta = JSON.parse(description.match(/<!-- vuihoc-meta: (.*?) -->/)![1]);

    expect(meta.roomCode).toBe("ROOM-5511");
    expect(meta.studentAccount).toBe("0900000005");
    expect(meta).not.toHaveProperty("browser");
  });

  test("does not duplicate similar tickets in description text", () => {
    const description = formatTicketDescription({
      incident,
      similarIssues: [{ identifier: "TECH-498", title: "LMS cập nhật sai hạn học" }],
    });
    expect(description).not.toContain("- Ticket tương tự:");
  });
});

// TECH-928 (26/09/2026, tech lead báo): người báo (Đặng Văn H) chỉ nhắn
// "90000003 - 0900000003 DH900003 UID: 900017" nhưng ticket lại ghi
// "Tài khoản HS / SĐT: 0900000004" — số đó không nằm ở đâu trong lời kể,
// model/LLM extractor tự bịa. Trường định danh phải GROUNDED: chỉ ghi khi
// dãy chữ số của nó thật sự có trong lời kể của người báo.
describe("formatTicketDescription — chặn định danh model tự bịa (TECH-928)", () => {
  const reporterRawText = "90000003 - 0900000003 DH900003 UID: 900017";

  test("model/extractor bịa SĐT không ai cho thì không ghi lên ticket — dùng lại SĐT thật moi từ lời kể", () => {
    const description = formatTicketDescription({
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: reporterRawText,
        studentAccount: "0900000004",
      },
    });

    expect(description).not.toContain("0900000004");
    expect(description).toContain("- Tài khoản HS / SĐT: 0900000003");
  });

  test("không moi lại được số nào thật thì để trống, không để lại số bịa", () => {
    const description = formatTicketDescription({
      // Lời kể không chứa số điện thoại hợp lệ nào để moi lại.
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: "Đơn hàng bị lỗi, cần kiểm tra gấp",
        studentAccount: "0900000004",
      },
    });

    expect(description).not.toContain("0900000004");
    expect(description).not.toContain("Tài khoản HS / SĐT");
  });

  test("mã khách hàng model bịa cũng bị bỏ (không phải SĐT nên không moi lại được)", () => {
    const description = formatTicketDescription({
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: reporterRawText,
        studentAccount: undefined,
        customerId: "KH-99999",
      },
    });

    expect(description).not.toContain("KH-99999");
    expect(description).not.toContain("Mã khách hàng");
  });

  test("SĐT người báo thật sự cho vẫn giữ nguyên — không chặn nhầm giá trị grounded", () => {
    const description = formatTicketDescription({
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: reporterRawText,
        studentAccount: "0900000003",
      },
    });

    expect(description).toContain("- Tài khoản HS / SĐT: 0900000003");
  });

  test("so khớp bất kể người báo gõ SĐT có khoảng trắng hoặc dấu chấm", () => {
    const withSpaces = formatTicketDescription({
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: "SĐT liên hệ 0900 000 003",
        studentAccount: "0900000003",
      },
    });
    expect(withSpaces).toContain("- Tài khoản HS / SĐT: 0900000003");

    const withDots = formatTicketDescription({
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: "SĐT liên hệ 0900.000.003",
        studentAccount: "0900000003",
      },
    });
    expect(withDots).toContain("- Tài khoản HS / SĐT: 0900000003");

    // Và ngược lại: model điền lại SĐT có khoảng trắng/dấu chấm nhưng người báo gõ liền — vẫn khớp.
    const modelWithDots = formatTicketDescription({
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: reporterRawText,
        studentAccount: "0900.000.003",
      },
    });
    expect(modelWithDots).toContain("- Tài khoản HS / SĐT: 0900.000.003");
  });

  test("formatConfirmationMessage (câu xác nhận sau khi tạo ticket) cũng được chặn giống hệt", () => {
    const message = formatConfirmationMessage({
      issueIdentifier: "TECH-928",
      issueUrl: "https://itsaplan.local/TECH-928",
      incident: {
        ...incident,
        roomCode: undefined,
        rawText: reporterRawText,
        studentAccount: "0900000004",
      },
    });

    expect(message).not.toContain("0900000004");
    expect(message).toContain("Tài khoản HS / SĐT: 0900000003");
  });
});

describe("appendTicketUpdateDescription", () => {
  test("keeps every update in one section rather than stacking headings", () => {
    let description = existingDescription();
    description = appendTicketUpdateDescription(description, {
      additionalNotes: "Thử lại vẫn lỗi",
      timestamp: "2026-03-14 09:30",
    });
    description = appendTicketUpdateDescription(description, {
      additionalNotes: "Đã đổi sang máy tính",
      timestamp: "2026-03-14 09:45",
    });

    expect(description.match(/### ➕ Bổ sung/g)).toHaveLength(1);
    expect(description).toContain("Thử lại vẫn lỗi");
    expect(description).toContain("Đã đổi sang máy tính");
  });

  test("lời kể đầy đủ sống sót qua mọi lần bổ sung ticket", () => {
    // "### Mô tả" vừa là thứ người đọc thấy vừa là văn bản nguồn cho BM25
    // (symptomsOfDescription). Mỗi lần người báo bổ sung đều gọi
    // appendTicketUpdateDescription trên toàn bộ mô tả — nếu khối Mô tả bị
    // cắt mất thì ticket cũ mất từ khóa tra cứu vĩnh viễn.
    let description = existingDescription();
    expect(symptomsOfDescription(description)).toContain("ROOM-5511");
    description = appendTicketUpdateDescription(description, {
      additionalNotes: "Đã thử đổi máy vẫn lỗi",
      timestamp: "2026-03-14 09:30",
    });
    description = appendTicketUpdateDescription(description, {
      additionalNotes: "Đã gửi ảnh màn hình",
      timestamp: "2026-03-14 10:00",
    });
    expect(symptomsOfDescription(description)).toContain("ROOM-5511");
  });

  test("leaves the source footer at the bottom where it belongs", () => {
    const description = appendTicketUpdateDescription(existingDescription(), {
      additionalNotes: "Thử lại vẫn lỗi",
      timestamp: "2026-03-14 09:30",
    });

    const footerIndex = description.indexOf("*Nguồn:");
    expect(footerIndex).toBeGreaterThan(description.indexOf("Thử lại vẫn lỗi"));
  });

  test("promotes a phone number from the note into the metadata block", () => {
    const description = appendTicketUpdateDescription(
      formatTicketDescription({ incident: { ...incident, studentAccount: undefined } }),
      { additionalNotes: "Phụ huynh là 0900000008", timestamp: "2026-03-14 09:30" },
    );

    expect(description).toContain("- Tài khoản HS / SĐT: 0900000008");
  });

  test("corrects the metadata in place instead of appending a second copy", () => {
    const description = appendTicketUpdateDescription(existingDescription(), {
      additionalNotes: "Nhầm số, đúng là 0900000008",
      studentAccount: "0900000008",
      timestamp: "2026-03-14 09:30",
    });

    expect(description.match(/- Tài khoản HS \/ SĐT:/g)).toHaveLength(1);
    expect(description).toContain("- Tài khoản HS / SĐT: 0900000008");
    expect(description).not.toContain("- Tài khoản HS / SĐT: 0900000005");
  });

  test("keeps the hidden metadata in step with the visible block", () => {
    // The webhook reads this comment, so a stale copy misroutes notifications.
    const description = appendTicketUpdateDescription(existingDescription(), {
      additionalNotes: "Máy là iPad",
      device: "iPad",
      timestamp: "2026-03-14 09:30",
    });
    const meta = JSON.parse(description.match(/<!-- vuihoc-meta: (.*?) -->/)![1]);

    expect(meta.deviceType).toBe("iPad");
  });

  test("cleans up a null line an earlier version left in the description", () => {
    const description = appendTicketUpdateDescription(
      "## Thông tin sự cố\n\n- Thiết bị: null\n- Sản phẩm: LiveClass\n",
      { additionalNotes: "Thử lại vẫn lỗi", timestamp: "2026-03-14 09:30" },
    );

    expect(description).not.toContain("- Thiết bị: null");
    expect(description).toContain("- Sản phẩm: LiveClass");
  });

  test("cleans up false customerId when note clarifies it is phone number", () => {
    const existing =
      '## Thông tin sự cố\n\n- Mã khách hàng: 0900000020\n- Tài khoản HS / SĐT: 0900000020\n- Sản phẩm: Tutor\n\n<!-- vuihoc-meta: {"customerId":"0900000020","studentAccount":"0900000020"} -->';
    const description = appendTicketUpdateDescription(existing, {
      additionalNotes:
        "Đính chính: 0900000020 là số điện thoại phụ huynh, không phải mã khách hàng",
      studentAccount: "0900000020",
      timestamp: "2026-09-16 20:31",
    });

    expect(description).not.toContain("- Mã khách hàng: 0900000020");
    expect(description).toContain("- Tài khoản HS / SĐT: 0900000020");
    const meta = JSON.parse(description.match(/<!-- vuihoc-meta: (.*?) -->/)![1]);
    expect(meta.customerId).toBeUndefined();
    expect(meta.studentAccount).toBe("0900000020");
  });
});

describe("formatConfirmationMessage", () => {
  test("reads back what was recorded without the internal layout", () => {
    const message = formatConfirmationMessage({
      issueIdentifier: "TECH-42",
      issueUrl: "https://itsaplan.local/TECH-42",
      incident,
    });

    expect(message).toContain("Đã tạo ticket TECH-42");
    expect(message).toContain("Ưu tiên: High");
    expect(message).not.toContain("vuihoc-meta");
  });

  test("asks for what is still missing at the end, after the ticket exists", () => {
    const message = formatConfirmationMessage({
      issueIdentifier: "TECH-42",
      issueUrl: "",
      incident,
      missingSoftFields: ["số điện thoại phụ huynh"],
    });

    expect(message.trimEnd().endsWith("số điện thoại phụ huynh với ạ.")).toBe(true);
  });
});
