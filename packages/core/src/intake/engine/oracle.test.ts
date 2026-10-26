/**
 * Tests for IntakeEngine replay oracle (RFC 0002 §4.3, PR 6).
 *
 * Verifies:
 * 1. Oracle disabled (default): engine runs standard flow, unchanged.
 * 2. Oracle enabled:
 *    - forces ask_missing_field -> lastAskedFields and question count overridden
 *    - forces confirm_summary -> ready_for_confirmation and summaryShownAt set
 *    - forces ticket_created -> draft closed with created status
 *    - forces canceled -> draft canceled
 *    - forces ask_split_or_merge -> pendingSplit set
 *    - forces ask_new_or_continue -> pendingNewIncident and parkedPayload set
 * 3. ScriptedReplayOracle helper works across multiple turns.
 * 4. applyReplayControlOverride pure function works deterministically.
 */
import { newDraft } from "../draft/types";
import { describe, expect, test } from "bun:test";
import { CHAT, makeHarness, report } from "./engine-harness.fixture";
import {
  applyReplayControlOverride,
  type ReplayOracleAction,
  type ReplayOraclePort,
  ScriptedReplayOracle,
} from "./oracle";

describe("IntakeEngine replay oracle (RFC 0002 PR 6)", () => {
  test("mặc định tắt: không có oracle thì engine chạy tự nhiên, không đổi hành vi", async () => {
    const h = makeHarness();
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const out = await h.engine.step({ chatId: CHAT, message: "cần hỗ trợ" });

    expect(out.outcome).toBe("asked");
    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft).toBeDefined();
    expect(draft?.status).toBe("collecting");
    // Gate naturally asked "van_de" in test catalog
    expect(draft?.lastAskedFields).toEqual(["van_de"]);
  });

  test("oracle ép ask_missing_field: đổi trường vừa hỏi sang trường TL1 đã hỏi", async () => {
    const oracle: ReplayOraclePort = {
      getControlAction: () => ({
        action: "ask_missing_field",
        field: "reporting_dept",
      }),
    };

    const h = makeHarness({ oracle });
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    await h.engine.step({ chatId: CHAT, message: "cần hỗ trợ" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.lastAskedFields).toEqual(["reporting_dept"]);
    expect(draft?.record?.questionCount.reporting_dept).toBe(1);

    // Lượt 2: người dùng nói "không biết" -> trường bị ép (reporting_dept) được đưa vào explicitlyMissing
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "không biết" });
    const draft2 = h.drafts.getLatestByChatId(CHAT);
    expect(draft2?.record?.explicitlyMissing).toContain("reporting_dept");
  });

  test("oracle ép confirm_summary: đưa tờ khai sang ready_for_confirmation", async () => {
    let forced: ReplayOracleAction | null = null;
    const oracle: ReplayOraclePort = {
      getControlAction: () => forced,
    };

    const h = makeHarness({ oracle });
    const summaryIso = new Date(h.clock.now()).toISOString();
    forced = {
      action: "confirm_summary",
      summaryShownAt: summaryIso,
    };

    h.extractor.push(report(["app lỗi"]));
    // Dù báo cáo chưa đủ (van_de chưa có), oracle ép tóm tắt như TL1 đã làm
    await h.engine.step({ chatId: CHAT, message: "tin 1" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.status).toBe("ready_for_confirmation");
    expect(draft?.summaryShownAt).toBe(summaryIso);

    // Lượt 2 tắt ép để chạy tự nhiên: người dùng xác nhận sau thời gian chờ -> engine tạo ticket
    forced = null;
    h.clock.advance(10_000);
    h.extractor.push({ userIntent: "confirm" });
    const out = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });

    expect(out.outcome).toBe("created");
    expect(h.tracker.created).toHaveLength(1);
  });

  test("oracle ép ticket_created: đóng tờ khai ở trạng thái created", async () => {
    const oracle: ReplayOraclePort = {
      getControlAction: () => ({
        action: "ticket_created",
        issueIdentifier: "TECH-9999",
        issueId: 9999,
      }),
    };

    const h = makeHarness({ oracle });
    h.extractor.push({ userIntent: "report_issue", symptoms: ["app lỗi"], title: "app lỗi" });
    await h.engine.step({ chatId: CHAT, message: "app lỗi" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.status).toBe("created");
    expect(draft?.issueIdentifier).toBe("TECH-9999");
    expect(draft?.issueId).toBe(9999);
  });

  test("oracle ép canceled: đưa tờ khai sang canceled", async () => {
    const oracle: ReplayOraclePort = {
      getControlAction: () => ({
        action: "canceled",
      }),
    };

    const h = makeHarness({ oracle });
    h.extractor.push({ userIntent: "report_issue", symptoms: ["app lỗi"], title: "app lỗi" });
    await h.engine.step({ chatId: CHAT, message: "app lỗi" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.status).toBe("canceled");
  });

  test("oracle ép ask_split_or_merge: đặt pendingSplit trên tờ khai", async () => {
    const oracle: ReplayOraclePort = {
      getControlAction: () => ({
        action: "ask_split_or_merge",
        pendingSplit: {
          blocks: [{ text: "học sinh A lỗi app" }, { text: "học sinh B không vào được" }],
          mediaPaths: [],
          askedAt: "2026-10-26T10:00:00.000Z",
        },
      }),
    };

    const h = makeHarness({ oracle });
    h.extractor.push(report(["hai bạn lỗi"]));
    await h.engine.step({ chatId: CHAT, message: "hai bạn lỗi" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.pendingSplit).toBeDefined();
    expect(draft?.pendingSplit?.blocks).toHaveLength(2);
  });

  test("oracle ép ask_new_or_continue: đặt pendingNewIncident và parkedPayload", async () => {
    const oracle: ReplayOraclePort = {
      getControlAction: () => ({
        action: "ask_new_or_continue",
        pendingNewIncident: {
          message: "sự cố thứ hai",
          mediaPaths: [],
          askedAt: "2026-10-26T10:00:00.000Z",
        },
      }),
    };

    const h = makeHarness({ oracle });
    h.extractor.push(report(["lỗi 1"]));
    await h.engine.step({ chatId: CHAT, message: "lỗi 1" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.pendingNewIncident?.message).toBe("sự cố thứ hai");
    expect(draft?.parkedPayload?.text).toBe("sự cố thứ hai");
  });

  test("ScriptedReplayOracle: tuần tự từng lượt theo kịch bản", async () => {
    const sequence: (ReplayOracleAction | null)[] = [
      { action: "ask_missing_field", field: "reporting_dept" },
      { action: "confirm_summary", summaryShownAt: new Date(1_000_000).toISOString() },
      null, // lượt 3 chạy tự do
    ];
    const oracle = new ScriptedReplayOracle(sequence);
    const h = makeHarness({ oracle });

    h.extractor.push(
      { userIntent: "report_issue", symptoms: [], title: null },
      { userIntent: "provide_info", symptoms: [] },
      { userIntent: "confirm" },
    );

    // Turn 1: ép ask_missing_field
    await h.engine.step({ chatId: CHAT, message: "lỗi" });
    expect(h.drafts.getLatestByChatId(CHAT)?.lastAskedFields).toEqual(["reporting_dept"]);

    // Turn 2: ép confirm_summary
    await h.engine.step({ chatId: CHAT, message: "bộ phận Sale" });
    expect(h.drafts.getLatestByChatId(CHAT)?.status).toBe("ready_for_confirmation");

    // Turn 3: null -> chạy tự nhiên
    h.clock.advance(10_000);
    const out3 = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(out3.outcome).toBe("created");
  });

  test("applyReplayControlOverride: hàm thuần cập nhật đúng các trường điều khiển", () => {
    const base = newDraft("doc-test", CHAT, "2026-10-26T10:00:00.000Z");
    base.ticket.title = "Sự cố gốc";
    base.ticket.rawText = "Người báo nhắn abc";
    const overridden = applyReplayControlOverride(
      base,
      { action: "confirm_summary", summaryShownAt: "2026-10-26T10:05:00.000Z" },
      "2026-10-26T10:05:00.000Z",
    );

    // Điều khiển được ghi đè
    expect(overridden.status).toBe("ready_for_confirmation");
    expect(overridden.summaryShownAt).toBe("2026-10-26T10:05:00.000Z");
    // Nội dung người báo KHÔNG bị mất
    expect(overridden.ticket.title).toBe("Sự cố gốc");
    expect(overridden.ticket.rawText).toBe("Người báo nhắn abc");
  });
});
