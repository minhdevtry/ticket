import { describe, expect, test } from "bun:test";
import {
  decodeHtmlEntities,
  escapeItsaplanMarkdown,
  escapeTelegramHtml,
  escapeHtml,
} from "./html-entities";
import { formatTicketDescription } from "../mcp/tieulinh/domain/ticket-formatter";
import { NotificationDispatcher } from "../worker/notification-dispatcher";
import type { TicketBinding, TicketBindingRepository } from "./storage/binding-repository";
import type { Notifier } from "../worker/notifier";

describe("decodeHtmlEntities (Chiều 1: Itsaplan → Telegram / Plain text)", () => {
  test("giải mã ca thực tế TECH-691 (UID < 900016 và UID >= 900016)", () => {
    const tech691Body =
      "@tieulinh **ND bị nhầm hoặc hiểu sai**\n\n" +
      "*Do hs 0900000002 -* Bùi Văn Anh I ***có UID là 900015 &lt; 900016*** *nên đang **áp dụng theo logic cũ***\n\n" +
      "- **Logic cũ:** HS cứ mua khóa học ( kể cả Tự học ) → Đều là VIP Duo *(áp dụng cho các HS có UID &lt; 900016)*\n" +
      "- **Logic mới:** HS chỉ mua khóa Tự học → Ko phải là VIP Duo *(áp dụng cho các HS có UID &gt;= 900016) =&gt;* Xử lý ở US DUO-3552";

    const decoded = decodeHtmlEntities(tech691Body);

    expect(decoded).toContain("UID là 900015 < 900016");
    expect(decoded).toContain("UID < 900016");
    expect(decoded).toContain("UID >= 900016");
    expect(decoded).toContain("=>");
    expect(decoded).not.toContain("&lt;");
    expect(decoded).not.toContain("&gt;");
  });

  test("giải mã các toán tử so sánh <, >, >=", () => {
    expect(decodeHtmlEntities("a &lt; b")).toBe("a < b");
    expect(decodeHtmlEntities("a &gt; b")).toBe("a > b");
    expect(decodeHtmlEntities("a &gt;= b")).toBe("a >= b");
    expect(decodeHtmlEntities("a &lt;= b")).toBe("a <= b");
  });

  test("giải mã &amp; và giữ nguyên ký tự & độc lập", () => {
    expect(decodeHtmlEntities("Học sinh &amp; Phụ huynh")).toBe("Học sinh & Phụ huynh");
    expect(decodeHtmlEntities("Toán & Văn")).toBe("Toán & Văn");
    expect(decodeHtmlEntities("R&amp;D team & QA team")).toBe("R&D team & QA team");
  });

  test("CHỐNG GIẢI MÃ ĐÔI (Double-decode prevention): &amp;lt; chỉ ra &lt;, KHÔNG biến thành <", () => {
    // Nếu giải mã 2 lần, &amp;lt; -> &lt; -> < (lỗi bảo mật / sai nghĩa)
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities("&amp;gt;")).toBe("&gt;");
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeHtmlEntities("Ví dụ &amp;lt;script&amp;gt;")).toBe("Ví dụ &lt;script&gt;");
  });

  test("giải mã &quot; và &#39; (dấu ngoặc kép và nháy đơn)", () => {
    expect(decodeHtmlEntities("&quot;Lỗi hệ thống&quot;")).toBe('"Lỗi hệ thống"');
    expect(decodeHtmlEntities("&#39;Không tìm thấy phòng&#39;")).toBe("'Không tìm thấy phòng'");
    expect(decodeHtmlEntities("&apos;user_token&apos;")).toBe("'user_token'");
  });

  test("xử lý văn bản có sẵn thẻ <b> hoặc thẻ HTML", () => {
    expect(decodeHtmlEntities("Thẻ &lt;b&gt;in đậm&lt;/b&gt;")).toBe("Thẻ <b>in đậm</b>");
    expect(decodeHtmlEntities("Văn bản có <b>thẻ html thật</b>")).toBe(
      "Văn bản có <b>thẻ html thật</b>",
    );
  });

  test("bảo toàn tiếng Việt có dấu trọn vẹn", () => {
    const viText =
      "Kỹ thuật viên phản hồi: Đã kiểm tra tài khoản, học sinh cần đổi mật khẩu &amp; đăng nhập lại.";
    expect(decodeHtmlEntities(viText)).toBe(
      "Kỹ thuật viên phản hồi: Đã kiểm tra tài khoản, học sinh cần đổi mật khẩu & đăng nhập lại.",
    );
  });

  test("giải mã code / log chứa <...>", () => {
    const log = "Gặp exception: &lt;NullPointerException&gt; tại luồng &lt;WorkerThread-1&gt;";
    expect(decodeHtmlEntities(log)).toBe(
      "Gặp exception: <NullPointerException> tại luồng <WorkerThread-1>",
    );
  });

  test("hỗ trợ entity số thập phân và thập lục phân", () => {
    expect(decodeHtmlEntities("&#60;tag&#62;")).toBe("<tag>");
    expect(decodeHtmlEntities("&#x3C;hex_tag&#x3E;")).toBe("<hex_tag>");
    expect(decodeHtmlEntities("&#38;")).toBe("&");
    expect(decodeHtmlEntities("&#x26;")).toBe("&");
    expect(decodeHtmlEntities("&nbsp;")).toBe(" ");
  });

  test("xử lý an toàn chuỗi rỗng, null, undefined", () => {
    expect(decodeHtmlEntities("")).toBe("");
    expect(decodeHtmlEntities(null)).toBe("");
    expect(decodeHtmlEntities(undefined)).toBe("");
  });
});

describe("escapeItsaplanMarkdown (Chiều 2: Telegram/bot → Itsaplan Markdown)", () => {
  test("mã hóa <, >, >= ngoài khối code để Itsaplan DOMPurify không xoá", () => {
    expect(escapeItsaplanMarkdown("UID < 900016")).toBe("UID &lt; 900016");
    expect(escapeItsaplanMarkdown("UID > 1000")).toBe("UID &gt; 1000");
    expect(escapeItsaplanMarkdown("UID >= 900016")).toBe("UID &gt;= 900016");
    expect(escapeItsaplanMarkdown("UID <= 1000")).toBe("UID &lt;= 1000");
  });

  test("mã hóa code / log chứa <...> để không bị DOMPurify nhận nhầm là thẻ HTML và xoá", () => {
    const raw = "Gặp lỗi: <NullPointerException> và <Token_Expired>";
    expect(escapeItsaplanMarkdown(raw)).toBe(
      "Gặp lỗi: &lt;NullPointerException&gt; và &lt;Token_Expired&gt;",
    );
  });

  test("mã hóa văn bản có sẵn thẻ <b> thành text an toàn, không bị parse thành HTML tag", () => {
    expect(escapeItsaplanMarkdown("Thẻ <b>in đậm</b>")).toBe("Thẻ &lt;b&gt;in đậm&lt;/b&gt;");
    expect(escapeItsaplanMarkdown("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("giữ nguyên ký tự & và KHÔNG biến thành &amp; để tránh double escape", () => {
    expect(escapeItsaplanMarkdown("Toán & Tiếng Việt")).toBe("Toán & Tiếng Việt");
    expect(escapeItsaplanMarkdown("A & B < C")).toBe("A & B &lt; C");
    // Nếu chuỗi đã có sẵn &lt;, không bị biến thành &amp;lt;
    expect(escapeItsaplanMarkdown("UID &lt; 100")).toBe("UID &lt; 100");
    expect(escapeItsaplanMarkdown("Ký tự &quot; và &#39;")).toBe("Ký tự &quot; và &#39;");
  });

  test("bảo toàn nội dung bên trong code block (```...```) và inline code (`...`)", () => {
    const mixed =
      "Ngoài code <tag>, trong inline `code <tag>` và trong block:\n```\n<NullPointerException>\n```\nsau block > 10";
    const escaped = escapeItsaplanMarkdown(mixed);

    expect(escaped).toContain("Ngoài code &lt;tag&gt;");
    expect(escaped).toContain("trong inline `code <tag>`");
    expect(escaped).toContain("```\n<NullPointerException>\n```");
    expect(escaped).toContain("sau block &gt; 10");
  });

  test("bảo toàn tiếng Việt có dấu trọn vẹn", () => {
    const viText = "Học sinh Nguyễn Văn A báo lỗi: Điểm trung bình < 5 cần hỗ trợ";
    expect(escapeItsaplanMarkdown(viText)).toBe(
      "Học sinh Nguyễn Văn A báo lỗi: Điểm trung bình &lt; 5 cần hỗ trợ",
    );
  });

  test("xử lý an toàn chuỗi rỗng, null, undefined", () => {
    expect(escapeItsaplanMarkdown("")).toBe("");
    expect(escapeItsaplanMarkdown(null)).toBe("");
    expect(escapeItsaplanMarkdown(undefined)).toBe("");
  });
});

describe("escapeTelegramHtml & escapeHtml", () => {
  test("escapeTelegramHtml mã hóa đúng 3 ký tự &, <, >", () => {
    expect(escapeTelegramHtml("UID < 100 & UID > 50")).toBe("UID &lt; 100 &amp; UID &gt; 50");
    expect(escapeTelegramHtml("Tin nhắn chứa \"ngoặc kép\" và 'đơn'")).toBe(
      "Tin nhắn chứa \"ngoặc kép\" và 'đơn'",
    );
  });

  test("escapeHtml mã hóa đầy đủ &, <, >, \", '", () => {
    expect(escapeHtml("UID < 100 & \"test\" 'val' > 10")).toBe(
      "UID &lt; 100 &amp; &quot;test&quot; &#39;val&#39; &gt; 10",
    );
  });
});

describe("Tích hợp cả hai chiều (End-to-End Flow)", () => {
  test("Chiều 1: NotificationDispatcher giải mã entities trước khi gửi Telegram", async () => {
    const calls: Array<{ binding: TicketBinding; author: string; text: string }> = [];
    const mockNotifier: Notifier = {
      channelType: "telegram",
      notifyComment: async (binding, authorName, text) => {
        calls.push({ binding, author: authorName, text });
        return 123;
      },
      notifyStateChange: async () => {},
      broadcastAlert: async () => {},
    };

    const binding: TicketBinding = {
      issueId: 443,
      identifier: "TECH-691",
      chatId: "123456",
      channelType: "telegram",
    };

    const mockRepo: TicketBindingRepository = {
      getBindingByIssueId: () => binding,
      saveBinding: () => {},
      saveMessageRoute: () => {},
      getMessageRoute: () => null,
    };

    const dispatcher = new NotificationDispatcher(mockRepo, {
      agentHandles: ["tieulinh"],
      commentForwardPolicy: "all",
    });
    dispatcher.registerBot(mockNotifier);

    await dispatcher.handleWebhook({
      action: "create",
      event: "comment.created",
      data: {
        issueId: 443,
        identifier: "TECH-691",
        body: "@tieulinh Kỹ thuật viên: UID là 900015 &lt; 900016 và UID &gt;= 900016 (lỗi &quot;timeout&quot; &amp; log &lt;NullPointerException&gt;)",
        author: { name: "KTV &amp; Support" },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].author).toBe("KTV & Support");
    expect(calls[0].text).toContain("UID là 900015 < 900016");
    expect(calls[0].text).toContain("UID >= 900016");
    expect(calls[0].text).toContain('"timeout"');
    expect(calls[0].text).toContain("<NullPointerException>");
    expect(calls[0].text).not.toContain("&lt;");
    expect(calls[0].text).not.toContain("&gt;");
    expect(calls[0].text).not.toContain("&amp;");
  });

  test("Chiều 2: formatTicketDescription mã hóa ký tự đặc biệt cho Itsaplan", () => {
    const description = formatTicketDescription({
      incident: {
        title: "Lỗi đăng nhập học sinh",
        rawText:
          "Học sinh báo: UID < 900016 và UID >= 900016 gặp crash log <NullPointerException> khi submit & nộp bài",
        product: "Tự học",
        system: "LMS",
        priorityReason: "Gấp < 1h",
      },
    });

    expect(description).toContain(
      "> Học sinh báo: UID &lt; 900016 và UID &gt;= 900016 gặp crash log &lt;NullPointerException&gt; khi submit & nộp bài",
    );
    expect(description).toContain("- Lý do ưu tiên (người báo): Gấp &lt; 1h");
    expect(description).not.toContain("<NullPointerException>");
  });
});
