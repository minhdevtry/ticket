import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ticketDomain } from "../../tieulinh/domain";
import type { IssueDomain } from "./create-issue";

/**
 * PO-79 (16/09/2026): ticket ra Itsaplan trắng trơn vì lượt xác nhận đè bản nháp.
 *
 * Một nửa nguyên nhân nằm ở `.default()`: MCP SDK parse tham số qua
 * `z.object(inputSchema)` trước khi vào handler, nên mọi `.default()` được chèn
 * vào `input` KỂ CẢ khi model không gửi trường đó. `mergeOverDraft` bỏ qua giá
 * trị rỗng, nhưng `"medium"` hay `"1"` thì không rỗng — chúng vẫn đè, và bản
 * ghi mất đúng nhánh lẫn mức ưu tiên người dùng đã chọn.
 *
 * Mặc định phải đặt trong `build`, không đặt trong schema.
 */
const DOMAINS: Array<[string, IssueDomain<any>]> = [
  ["tieulinh", ticketDomain],
];

describe("inputShape của domain không được khai `.default()`", () => {
  for (const [name, domain] of DOMAINS) {
    test(`${name}: mọi trường hoặc bắt buộc, hoặc optional — không có mặc định`, () => {
      const withDefaults = Object.entries(domain.inputShape)
        .filter(([field]) => field !== "userConfirmed")
        .filter(([, schema]) => (schema as any)?.def?.type === "default")
        .map(([field]) => field);
      expect(withDefaults).toEqual([]);
    });
  }

  test("userConfirmed vẫn được phép mặc định — nó là cờ điều khiển, không phải nội dung", () => {
    const shape = { userConfirmed: z.boolean().default(false) };
    expect(z.object(shape).parse({})).toEqual({ userConfirmed: false });
  });
});
