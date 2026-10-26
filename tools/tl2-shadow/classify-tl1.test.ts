/**
 * Tests for classifyTl1Reply and readTl1Summary (RFC 0002 PR 6).
 *
 * Tiêu chí chấp nhận 1: Bộ phân loại đúng 100% chuỗi vàng của PR 2
 * (6 kịch bản trong packages/core/golden/intake/). Một ca sai là không đạt.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTl1Reply, extractAskedField, readTl1Summary } from "./classify-tl1";

const GOLDEN_DIR = join(import.meta.dir, "../../packages/core/golden/intake");

describe("classifyTl1Reply — kiểm thử trên chuỗi vàng PR 2 (tiêu chí 100%)", () => {
  const files = readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  test("có đủ 6 kịch bản vàng trong thư mục golden", () => {
    expect(files.length).toBe(6);
  });

  for (const file of files) {
    const raw = readFileSync(join(GOLDEN_DIR, file), "utf8");
    const data = JSON.parse(raw) as {
      scenario: string;
      turns: Array<{ action: string; voiceText: string }>;
    };

    test(`kịch bản vàng "${data.scenario}": mọi lượt phân loại đúng 100%`, () => {
      for (let i = 0; i < data.turns.length; i++) {
        const turn = data.turns[i];
        const predicted: string = classifyTl1Reply(turn.voiceText);
        expect(predicted).toBe(turn.action);
      }
    });
  }
});

describe("readTl1Summary — đọc ngược các trường từ tóm tắt TL1", () => {
  test("đọc từ format voiceText trong chuỗi vàng", () => {
    const text =
      "Em tóm tắt lại sự cố nhé: Lỗi app Duo học sinh 0900000005 không làm bài được, thuộc hệ thống DUO_Vuihoc, mức ưu tiên Trung bình. Anh/chị kiểm tra chuẩn rồi thì xác nhận giúp em nhé!";
    const s = readTl1Summary(text);
    expect(s).not.toBeNull();
    expect(s?.title).toBe("Lỗi app Duo học sinh 0900000005 không làm bài được");
    expect(s?.system).toBe("DUO_Vuihoc");
    expect(s?.priority).toBe("Trung bình");
    expect(s?.studentAccount).toBe("0900000005");
  });

  test("đọc từ format displayMarkdown đầy đủ các trường", () => {
    const markdown = [
      "**Em tóm tắt lại sự cố của anh/chị nhé ạ:**\n",
      "- Tiêu đề: CRM lỗi 500 khi mở đơn hàng",
      "- Sản phẩm: Vuihoc School",
      "- Hệ thống: CRM_Vuihoc",
      "- Mã khách hàng: KH-9912",
      "- Tài khoản HS / SĐT: 0900000014",
      "- Bộ phận: Sale",
      "- Phân loại lỗi: Lỗi hệ thống",
      "- Đính kèm: 2 tệp",
      "- Mức ưu tiên: Cao\n",
      "Anh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận nhé ạ!",
    ].join("\n");

    const s = readTl1Summary(markdown);
    expect(s).not.toBeNull();
    expect(s?.title).toBe("CRM lỗi 500 khi mở đơn hàng");
    expect(s?.product).toBe("Vuihoc School");
    expect(s?.system).toBe("CRM_Vuihoc");
    expect(s?.customerId).toBe("KH-9912");
    expect(s?.studentAccount).toBe("0900000014");
    expect(s?.reportingDept).toBe("Sale");
    expect(s?.errorCategory).toBe("Lỗi hệ thống");
    expect(s?.attachmentCount).toBe(2);
    expect(s?.priority).toBe("Cao");
  });

  test("tin không phải tóm tắt trả về null", () => {
    expect(readTl1Summary("Anh/chị bổ sung giúp em: bộ phận của anh/chị.")).toBeNull();
    expect(readTl1Summary("")).toBeNull();
  });
});

describe("extractAskedField — phát hiện trường được hỏi", () => {
  test("phát hiện bộ phận", () => {
    expect(extractAskedField("Anh/chị bổ sung giúp em: bộ phận của anh/chị.")).toBe(
      "reporting_dept",
    );
  });

  test("phát hiện hệ thống", () => {
    expect(extractAskedField("Dạ lỗi này xảy ra trên hệ thống nào ạ?")).toBe("system");
  });

  test("phát hiện lý do cần xử lý gấp", () => {
    expect(extractAskedField("Dạ anh/chị cho em biết lý do cần xử lý gấp")).toBe("priority_reason");
  });

  test("phát hiện mô tả sự cố", () => {
    expect(extractAskedField("Anh/chị mô tả giúp em sự cố đang gặp nhé.")).toBe("van_de");
  });
});
