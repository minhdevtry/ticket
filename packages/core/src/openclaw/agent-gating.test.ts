import { describe, expect, test } from "bun:test";
import {
  isAgentInScope,
  parseAgentIdFromSessionKey,
  parseAllowedAgentIds,
  resolveAgentId,
} from "./agent-gating";

describe("parseAgentIdFromSessionKey", () => {
  test("khuôn agent:<id>:... ⇒ rút id", () => {
    expect(parseAgentIdFromSessionKey("agent:cm-support:telegram:ticket:123")).toBe("cm-support");
    expect(parseAgentIdFromSessionKey("agent:iris-agent:x")).toBe("iris-agent");
  });

  test("session key Telegram trực tiếp KHÔNG đoán ⇒ null", () => {
    expect(parseAgentIdFromSessionKey("telegram:ticket:direct:555")).toBeNull();
    expect(parseAgentIdFromSessionKey("")).toBeNull();
    expect(parseAgentIdFromSessionKey(undefined)).toBeNull();
    expect(parseAgentIdFromSessionKey(42 as unknown)).toBeNull();
    expect(parseAgentIdFromSessionKey("agent::x")).toBeNull(); // id rỗng
  });
});

describe("resolveAgentId", () => {
  test("ưu tiên ctx.agentId", () => {
    expect(resolveAgentId({ agentId: "sales", sessionKey: "agent:cm-support:x" })).toBe("sales");
  });
  test("không có agentId ⇒ parse sessionKey", () => {
    expect(resolveAgentId({ sessionKey: "agent:cm-support:x" })).toBe("cm-support");
  });
  test("cả hai thiếu ⇒ null", () => {
    expect(resolveAgentId({})).toBeNull();
    expect(resolveAgentId({ agentId: "  " })).toBeNull();
  });
});

describe("isAgentInScope", () => {
  const cfg = { allowedAgentIds: ["cm-support"] };

  test("agent trong danh sách ⇒ true", () => {
    expect(isAgentInScope({ agentId: "cm-support" }, cfg)).toBe(true);
    expect(isAgentInScope({ sessionKey: "agent:cm-support:x" }, cfg)).toBe(true);
  });

  test("agent khác ⇒ false (hook toàn cục, không vương sang bot khác)", () => {
    expect(isAgentInScope({ agentId: "iris-agent" }, cfg)).toBe(false);
    expect(isAgentInScope({ sessionKey: "agent:sales:x" }, cfg)).toBe(false);
  });

  test("danh sách rỗng ⇒ fail-closed (false)", () => {
    expect(isAgentInScope({ agentId: "cm-support" }, { allowedAgentIds: [] })).toBe(false);
  });

  test("không xác định được agent id ⇒ false", () => {
    expect(isAgentInScope({ sessionKey: "telegram:ticket:direct:555" }, cfg)).toBe(false);
    expect(isAgentInScope({}, cfg)).toBe(false);
  });
});

describe("parseAllowedAgentIds", () => {
  test("chuỗi phân tách dấu phẩy ⇒ mảng đã trim", () => {
    expect(parseAllowedAgentIds("cm-support, iris-agent ,sales")).toEqual(["cm-support", "iris-agent", "sales"]);
  });
  test("rỗng ⇒ fallback (mặc định rỗng = fail-closed)", () => {
    expect(parseAllowedAgentIds(undefined)).toEqual([]);
    expect(parseAllowedAgentIds("   ")).toEqual([]);
    expect(parseAllowedAgentIds("", ["cm-support"])).toEqual(["cm-support"]);
  });
});
