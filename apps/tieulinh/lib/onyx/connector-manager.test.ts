import { describe, expect, it, afterEach, mock } from "bun:test";
import { OnyxConnectorManager } from "./connector-manager";

// Bug thật đã xảy ra: script push-kg-to-onyx.ts truyền connectorName/documentSetName
// RIÊNG ("kg-cause-taxonomy") nhưng constructor vẫn âm thầm lấy ONYX_CC_PAIR_ID từ
// .env (cc-pair của "intake-test-done") làm ccPairId — khiến ensureTestConnector()
// trả thẳng cc-pair CŨ mà bỏ qua toàn bộ luồng tạo connector/document-set mới, ghi
// nhầm 17 document vào document set không liên quan trước khi bị phát hiện và dọn.
describe("OnyxConnectorManager — không được kế thừa ONYX_CC_PAIR_ID khi caller đặt tên riêng", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });
  const originalFetch = globalThis.fetch;

  it("Không truyền options (identity mặc định) => dùng ONYX_CC_PAIR_ID từ env như cũ", async () => {
    process.env.ONYX_CC_PAIR_ID = "31";
    process.env.ONYX_DOCUMENT_SET = "intake-test-done";

    const mgr = new OnyxConnectorManager("https://mock.onyx", "mock_key");
    const conn = await mgr.ensureTestConnector();

    expect(conn.ccPairId).toBe(31);
    expect(conn.documentSetName).toBe("intake-test-done");
  });

  it("Truyền documentSetName RIÊNG => KHÔNG được lấy ONYX_CC_PAIR_ID của set khác, phải tự tra cứu/tạo mới", async () => {
    process.env.ONYX_CC_PAIR_ID = "31"; // cc-pair của "intake-test-done" — set khác hoàn toàn
    let createConnectorCalled = false;

    globalThis.fetch = mock(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/api/manage/document-set") && (!init || init.method !== "POST")) {
        // Chưa có document set "kg-cause-taxonomy" nào tồn tại
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes("/api/manage/admin/connector-with-mock-credential")) {
        createConnectorCalled = true;
        return new Response(JSON.stringify(99), { status: 200 });
      }
      if (u.includes("/api/manage/admin/document-set") && init?.method === "POST") {
        return new Response(JSON.stringify(88), { status: 200 });
      }
      if (u.includes("/api/manage/admin/user-group")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.includes("/api/persona/6")) {
        return new Response(JSON.stringify({ document_sets: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const mgr = new OnyxConnectorManager("https://mock.onyx", "mock_key", {
      connectorName: "FileConnector-KG-CauseTaxonomy",
      documentSetName: "kg-cause-taxonomy",
    });
    const conn = await mgr.ensureTestConnector();

    // Phải đi qua luồng tạo mới thật sự (cc-pair 99), TUYỆT ĐỐI không phải 31
    expect(createConnectorCalled).toBe(true);
    expect(conn.ccPairId).toBe(99);
    expect(conn.ccPairId).not.toBe(31);
    expect(conn.documentSetName).toBe("kg-cause-taxonomy");
  });

  it("Truyền ccPairId tường minh trong options thì vẫn được tôn trọng (không phải bug, là tính năng)", async () => {
    delete process.env.ONYX_CC_PAIR_ID;
    const mgr = new OnyxConnectorManager("https://mock.onyx", "mock_key", {
      documentSetName: "kg-cause-taxonomy",
      ccPairId: 77,
    });
    const conn = await mgr.ensureTestConnector();
    expect(conn.ccPairId).toBe(77);
  });
});
