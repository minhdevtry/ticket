/**
 * Ghi bản ghi vàng: chạy từng kịch bản trong `scenarios.ts` qua pipeline LEGACY (`IntakeStepPipeline`)
 * với dữ liệu tổng hợp và mọi nguồn không tất định được cố định (đồng hồ giả, itsaplan giả, bộ trích
 * xuất heuristic không LLM), rồi trả JSON fixture. Chạy hai lần cho ra hai chuỗi giống từng byte.
 *
 * Fixture không import code legacy: engine mới chỉ đọc JSON. File này là chỗ DUY NHẤT dính legacy.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { InlineButton } from "@vuihoc/bot-core/intake";
import type { ItsaplanClient, ItsaplanIssue } from "@vuihoc/bot-core/itsaplan";
import {
  GOLDEN_FORMAT,
  type GoldenFixture,
  type GoldenTurn,
  normalizeVoiceText,
  serializeFixture,
} from "@vuihoc/bot-core/testing";
import { FieldExtractor } from "../../lib/intake-step/extractor";
import { IntakeStepPipeline, type PendingButtonsSink } from "../../lib/intake-step/pipeline";
import { IntakeDocumentRepository } from "../../lib/intake-document/repository";
import { TicketBindingRepository } from "../../lib/storage/binding-repository";
import { DraftSessionRepository } from "../../lib/storage/session-repository";
import { applySchema } from "../../lib/storage/schema";
import type { UrgencyRules } from "../../mcp/shared/index";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import { MIN_CONFIRM_DELAY_MS, SCENARIOS, START_MS, type Scenario } from "./scenarios";

/** Thư mục fixture trong repo (cạnh `packages/core`, nơi engine mới đọc). */
export const GOLDEN_DIR = join(import.meta.dir, "../../../../packages/core/golden/intake");

const CHAT = "telegram:-1000000000001";

/** Itsaplan giả tối thiểu (rút từ fake của `pipeline.flow.test.ts`): đủ cho tạo ticket, đọc ticket vừa tạo và tải ảnh; mã ticket đếm từ 101, tất định. */
function fakeItsaplan(): ItsaplanClient {
  let seq = 100;
  const client: Partial<ItsaplanClient> = {
    listProjectColumns: async () =>
      [
        { id: 1, name: "Todo", stateType: "unstarted", position: 1 },
        { id: 9, name: "Canceled", stateType: "canceled", position: 9 },
      ] as any,
    listCustomFields: async () => [] as any,
    createIssue: async (_projectKey: string, payload: any) => {
      seq++;
      return {
        id: seq,
        identifier: `TECHTEST-${seq}`,
        title: payload.title,
        sequenceNumber: seq,
      } as ItsaplanIssue;
    },
    getIssue: async (id: number) =>
      ({
        id,
        identifier: `TECHTEST-${id - 5000}`,
        title: `Ticket ${id - 5000}`,
        columnId: 1,
        description: "",
      }) as any,
    getIssueByNumber: async (_projectKey: string, n: number) =>
      ({ id: 5000 + n, identifier: `TECHTEST-${n}`, title: `Ticket ${n}`, description: "" }) as any,
    getIssueTimeline: async () => [] as any,
    linkIssues: async (_a: number, _b: number, kind?: string) => ({ id: 1, kind }) as any,
    updateIssue: async () => ({}) as any,
    addComment: async (_issueId: number, content: string) => ({ id: 1, body: content }),
    uploadAttachment: async (_issueId: number, filename: string) => ({
      id: "att1",
      url: "/attachments/att1/raw",
      filename,
    }),
  };
  return client as ItsaplanClient;
}

/** Bộ trích xuất legacy thật (heuristic, không LLM) có ghi lại kết quả để đối chiếu với ghim. */
class RecordingExtractor extends FieldExtractor {
  results: Array<{ userIntent: string }> = [];
  override async extract(...args: Parameters<FieldExtractor["extract"]>) {
    const r = await super.extract(...args);
    this.results.push({ userIntent: r.userIntent });
    return r;
  }
}

async function recordScenario(s: Scenario): Promise<GoldenFixture> {
  const db = new Database(":memory:");
  applySchema(db);
  let clock = START_MS;
  const extractor = new RecordingExtractor();
  const saved = new Map<string, InlineButton[][]>();
  const sink: PendingButtonsSink = {
    save: (chatId, rows) => saved.set(chatId, rows),
    clear: (chatId) => saved.delete(chatId),
  };
  const pipeline = new IntakeStepPipeline({
    repo: new IntakeDocumentRepository(db),
    extractor,
    itsaplan: fakeItsaplan(),
    itsaplanBaseUrl: "https://mock.itsaplan.example.com",
    projectKey: "TECHTEST",
    validationRules: validationRules as any,
    fieldRequirements: fieldRequirements as any,
    productMapping: productMapping as any,
    urgencyRules: urgencyRules as UrgencyRules,
    bindingRepo: new TicketBindingRepository(db),
    draftRepo: new DraftSessionRepository(db),
    buttons: sink,
    minConfirmDelayMs: MIN_CONFIRM_DELAY_MS,
    now: () => clock,
  });

  const turns: GoldenTurn[] = [];
  for (const [i, t] of s.turns.entries()) {
    const advanceMs = i === 0 ? 0 : (t.advanceMs ?? 10_000);
    clock += advanceMs;
    const before = extractor.results.length;
    const packet = await pipeline.run({
      chatId: CHAT,
      message: t.message,
      ...(t.mediaPaths ? { mediaPaths: t.mediaPaths } : {}),
    });
    const seen = extractor.results[before];
    if (seen && seen.userIntent !== t.extract.userIntent) {
      throw new Error(
        `Kịch bản ${s.scenario} lượt ${i + 1}: ghim userIntent="${t.extract.userIntent}" nhưng legacy trích "${seen.userIntent}"`,
      );
    }
    turns.push({
      advanceMs,
      message: t.message,
      ...(t.mediaPaths ? { mediaPaths: t.mediaPaths } : {}),
      extract: t.extract,
      action: packet.action,
      voiceText: normalizeVoiceText(packet.voiceText, packet.issue),
      buttons: packet.buttons?.length
        ? packet.buttons.map((row) =>
            row.map((b) => ({ text: b.text, callbackData: b.callbackData })),
          )
        : null,
    });
  }
  return {
    format: GOLDEN_FORMAT,
    scenario: s.scenario,
    description: s.description,
    source: s.source,
    startMs: START_MS,
    minConfirmDelayMs: MIN_CONFIRM_DELAY_MS,
    turns,
  };
}

/** Ghi mọi kịch bản; trả `tên file -> nội dung JSON`. Hai lần gọi cho kết quả giống từng byte. */
export async function recordGolden(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of SCENARIOS)
    out.set(`${s.scenario}.json`, serializeFixture(await recordScenario(s)));
  return out;
}
