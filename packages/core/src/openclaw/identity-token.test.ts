import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IDENTITY_TTL_MS,
  IdentityTokenFailure,
  IDENTITY_PARAM,
  InMemoryReplayStore,
  issueIdentityToken,
  signIdentityToken,
  verifyIdentityToken,
  type IdentityTokenPayload,
} from "./identity-token";

const SECRET = "bi-mat-chung-test";
const T0 = 1_700_000_000_000;

function issue(overrides: Partial<Parameters<typeof issueIdentityToken>[0]> = {}) {
  return issueIdentityToken({
    telegramUserId: "555000001",
    telegramUsername: "probe_a",
    runId: "run-1",
    sessionKey: "agent:cm-support:x",
    chatId: "999",
    toolName: "create_ticket",
    secret: SECRET,
    now: T0,
    ...overrides,
  })[IDENTITY_PARAM];
}

describe("verifyIdentityToken", () => {
  test("token hợp lệ ⇒ trả payload đúng người, đúng tool", () => {
    const token = issue();
    const payload = verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0 });
    expect(payload.u).toBe("555000001");
    expect(payload.t).toBe("create_ticket");
    expect(payload.n).toBe("probe_a");
  });

  test("thiếu token ⇒ E_IDENTITY_TOKEN_MISSING", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expect(() => verifyIdentityToken(bad, { toolName: "create_ticket", secret: SECRET, now: T0 }))
        .toThrow(IdentityTokenFailure);
      try {
        verifyIdentityToken(bad, { toolName: "create_ticket", secret: SECRET, now: T0 });
      } catch (e) {
        expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_MISSING");
      }
    }
  });

  test("sai chữ ký (bí mật khác) ⇒ E_IDENTITY_TOKEN_UNVERIFIED", () => {
    const token = issue();
    try {
      verifyIdentityToken(token, { toolName: "create_ticket", secret: "bi-mat-khac", now: T0 });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_UNVERIFIED");
    }
  });

  test("token bị sửa thân (payload) ⇒ chữ ký không khớp", () => {
    const token = issue();
    const [sig, body] = token.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as IdentityTokenPayload;
    payload.u = "555000002"; // mạo danh người khác
    const forged = `${sig}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
    try {
      verifyIdentityToken(forged, { toolName: "create_ticket", secret: SECRET, now: T0 });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_UNVERIFIED");
    }
  });

  test("hết hạn (quá TTL) ⇒ E_IDENTITY_TOKEN_EXPIRED", () => {
    const token = issue({ now: T0 });
    try {
      verifyIdentityToken(token, {
        toolName: "create_ticket",
        secret: SECRET,
        now: T0 + DEFAULT_IDENTITY_TTL_MS + 1,
      });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_EXPIRED");
    }
  });

  test("lệch giờ phía tương lai cũng ⇒ E_IDENTITY_TOKEN_EXPIRED", () => {
    const token = issue({ now: T0 });
    try {
      verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0 - DEFAULT_IDENTITY_TTL_MS - 1 });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_EXPIRED");
    }
  });

  test("token của tool khác ⇒ E_IDENTITY_TOKEN_MISMATCH", () => {
    const token = issue({ toolName: "create_ticket" });
    try {
      verifyIdentityToken(token, { toolName: "get_ticket", secret: SECRET, now: T0 });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_MISMATCH");
    }
  });

  test("runId chỉ so khi bên gọi truyền; khớp ⇒ ok, lệch ⇒ MISMATCH", () => {
    const token = issue({ runId: "run-1" });
    // Không truyền runId ⇒ bỏ qua (giống production MCP)
    expect(verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0 }).r).toBe("run-1");
    // Truyền đúng ⇒ ok
    expect(
      verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0, runId: "run-1" }).u,
    ).toBe("555000001");
    // Truyền lệch ⇒ mismatch
    try {
      verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0, runId: "run-2" });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_MISMATCH");
    }
  });

  test("malformed: không có dấu chấm / base64 hỏng ⇒ MALFORMED", () => {
    for (const bad of ["khongcodaucham", ".body", "sig.@@@khongphaibase64json"]) {
      try {
        verifyIdentityToken(bad, { toolName: "create_ticket", secret: SECRET, now: T0 });
        throw new Error("đáng lẽ phải ném");
      } catch (e) {
        expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_MALFORMED");
      }
    }
  });
});

describe("replay protection", () => {
  test("dùng lại cùng token ⇒ lần hai E_IDENTITY_TOKEN_REPLAYED", () => {
    const store = new InMemoryReplayStore(() => T0);
    const token = issue();
    const first = verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0, replayStore: store });
    expect(first.u).toBe("555000001");
    try {
      verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0, replayStore: store });
      throw new Error("đáng lẽ phải ném");
    } catch (e) {
      expect((e as IdentityTokenFailure).code).toBe("E_IDENTITY_TOKEN_REPLAYED");
    }
  });

  test("hai token khác nhau (nonce khác) đều qua được", () => {
    const store = new InMemoryReplayStore(() => T0);
    const a = issue({ nonce: "aaa" });
    const b = issue({ nonce: "bbb" });
    expect(verifyIdentityToken(a, { toolName: "create_ticket", secret: SECRET, now: T0, replayStore: store }).u).toBe("555000001");
    expect(verifyIdentityToken(b, { toolName: "create_ticket", secret: SECRET, now: T0, replayStore: store }).u).toBe("555000001");
  });

  test("token sai chữ ký KHÔNG làm bẩn kho replay", () => {
    const store = new InMemoryReplayStore(() => T0);
    const token = issue();
    try {
      verifyIdentityToken(token, { toolName: "create_ticket", secret: "sai", now: T0, replayStore: store });
    } catch {
      /* mong đợi hỏng chữ ký */
    }
    // Cùng token với bí mật ĐÚNG vẫn phải qua (kho chưa ghi nonce vì chữ ký hỏng).
    expect(verifyIdentityToken(token, { toolName: "create_ticket", secret: SECRET, now: T0, replayStore: store }).u).toBe("555000001");
  });

  test("InMemoryReplayStore quên nonce sau khi hết hạn", () => {
    let clock = T0;
    const store = new InMemoryReplayStore(() => clock);
    store.remember("n1", T0 + 1000);
    expect(store.has("n1")).toBe(true);
    clock = T0 + 1001;
    expect(store.has("n1")).toBe(false);
  });
});

describe("signIdentityToken determinism", () => {
  test("cùng payload + secret ⇒ cùng chữ ký (khớp chéo plugin↔MCP)", () => {
    const payload: IdentityTokenPayload = {
      u: "1", n: null, r: "r", s: "s", c: "c", t: "create_ticket", iat: T0, n2: "x",
    };
    expect(signIdentityToken(payload, SECRET)).toBe(signIdentityToken(payload, SECRET));
  });
});
