import { describe, expect, test } from "bun:test";
import { loadTelegramBotToken, readTelegramBotToken } from "./telegram-token";

const CONFIG = {
  channels: {
    telegram: {
      botToken: "token-single",
      accounts: {
        ticket: { botToken: "token-ticket" },
        iris: { botToken: "token-iris" },
        empty: { botToken: "" },
      },
    },
  },
};

describe("readTelegramBotToken (hàm thuần)", () => {
  test("rút token theo accountId", () => {
    expect(readTelegramBotToken(CONFIG, "ticket")).toBe("token-ticket");
    expect(readTelegramBotToken(CONFIG, "iris")).toBe("token-iris");
  });

  test("account không có token ⇒ fallback token một-tài-khoản", () => {
    expect(readTelegramBotToken(CONFIG, "empty")).toBe("token-single");
    expect(readTelegramBotToken(CONFIG, "khong-ton-tai")).toBe("token-single");
  });

  test("accountId null/rỗng ⇒ chỉ xét token một-tài-khoản", () => {
    expect(readTelegramBotToken(CONFIG, null)).toBe("token-single");
    expect(readTelegramBotToken(CONFIG)).toBe("token-single");
  });

  test("không có telegram/token ⇒ null (KHÔNG đoán)", () => {
    expect(readTelegramBotToken({}, "ticket")).toBeNull();
    expect(readTelegramBotToken({ channels: { telegram: {} } }, "ticket")).toBeNull();
    expect(readTelegramBotToken(null, "ticket")).toBeNull();
    expect(readTelegramBotToken("khong-phai-object", "ticket")).toBeNull();
  });

  test("account không có token và không có fallback ⇒ null", () => {
    const cfg = { channels: { telegram: { accounts: { iris: { botToken: "x" } } } } };
    expect(readTelegramBotToken(cfg, "ticket")).toBeNull();
  });
});

describe("loadTelegramBotToken (nạp theo đường dẫn tường minh)", () => {
  test("đọc file rồi rút token", () => {
    const token = loadTelegramBotToken("/duong/openclaw.json", "ticket", () =>
      JSON.stringify(CONFIG),
    );
    expect(token).toBe("token-ticket");
  });

  test("file đọc không được ⇒ null (không ném)", () => {
    const token = loadTelegramBotToken("/khong/ton/tai.json", "ticket", () => {
      throw new Error("ENOENT");
    });
    expect(token).toBeNull();
  });

  test("JSON hỏng ⇒ null (không ném)", () => {
    expect(loadTelegramBotToken("/x.json", "ticket", () => "{khong phai json")).toBeNull();
  });
});
