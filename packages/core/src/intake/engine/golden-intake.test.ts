/**
 * Phát lại bản ghi vàng của lễ tân legacy (`packages/core/golden/intake/*.json`) qua
 * `IntakeEngine.step` bằng `ScriptedChat`, so từng lượt `(action, voiceText, nút)` và báo kịch
 * bản nào lệch. KHÔNG import code legacy: đầu vào và đầu ra chuẩn đều nằm trong fixture JSON.
 *
 * Lệch có trong `golden-intake.allowlist.ts` thì được phép (có lý do, PR sẽ xoá); lệch ngoài
 * danh sách, hoặc dòng danh sách không còn lệch, làm test đỏ. Việc ghi fixture: `bun run
 * golden:record` ở `apps/tieulinh-legacy`. Hướng dẫn: docs/how-to/golden-scripts.md.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeCopyCatalog } from "../copy-catalog";
import { SqliteChannelBindingStore } from "../create";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { createCatalog } from "../gate/catalog";
import type {
  CreateIssueInput,
  ExtractedFields,
  ExtractInput,
  FieldExtractorPort,
  TrackerIssue,
  TrackerPort,
} from "../ports";
import type { UrgencyRules } from "../priority";
import {
  applyAllowlist,
  compareGolden,
  formatGoldenReport,
  type GoldenDivergence,
  type GoldenFixture,
  type GoldenResult,
  goldenScript,
  ManualClock,
  parseFixture,
  ScriptedChat,
} from "../../testing";
import { TEST_COPY } from "./test-copy.fixture";
import { IntakeEngine } from "./engine";
import { GOLDEN_ALLOWLIST } from "./golden-intake.allowlist";

const GOLDEN_DIR = join(import.meta.dir, "../../../golden/intake");

/** Sáu kịch bản của PR 2 (RFC 0002 mục 5). Thêm kịch bản thì thêm vào đây. */
const EXPECTED_SCENARIOS = [
  "cancel-then-new",
  "double-click",
  "expiry-24h",
  "first-ok",
  "premature-confirm",
  "ticket-creation",
];

/**
 * Catalog thử mô hình hoá phần tối thiểu của legacy: mô tả sự cố và bộ phận đều bắt buộc (legacy
 * hỏi bộ phận khi người báo chưa nói). Câu hỏi và nhãn là chữ thử tiếng Anh của engine; chữ và
 * nút tiếng Việt của Tiểu Linh là việc của PR 14.
 */
const catalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Tech incident",
        truong_mo_dau: "van_de",
        recap: ["van_de", "bo_phan"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Problem",
            hoi: "What's the problem?",
          },
          bo_phan: {
            bat_buoc: true,
            kieu: "enum:phong_ban",
            duoc_hoi: true,
            nhan: "Department",
            hoi: "Which team?",
            hoi_lai: ["Which team?"], // ngân sách hỏi 2 lần như legacy (đếm số lần đã hỏi)
          },
        },
      },
    },
  },
  enums: {
    phong_ban: ["Vận hành", "Vận đơn", "CSKH", "CSHV", "Chuyên môn", "Sale", "Quản lý lớp"],
  },
});

const URGENCY: UrgencyRules = {
  levels: ["Low", "Medium", "High", "Urgent"],
  floors: [],
  ceilings: [],
};

class QueueExtractor implements FieldExtractorPort {
  private queue: ExtractedFields[] = [];
  push(...fields: ExtractedFields[]) {
    this.queue.push(...fields);
  }
  async extract(_input: ExtractInput): Promise<ExtractedFields> {
    return this.queue.shift() ?? { userIntent: "chitchat" };
  }
}

class CountingTracker implements TrackerPort {
  private seq = 0;
  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    const n = ++this.seq;
    return {
      id: 1000 + n,
      identifier: `TECH-${n}`,
      title: input.title,
      url: `https://t.example.com/${n}`,
    };
  }
  async getIssue(id: number) {
    return { id, identifier: `TECH-${id - 1000}`, title: "x" };
  }
  async addComment() {}
  async attach(_i: number, _d: string, m: string[]) {
    return m.length;
  }
  async findByIdentifier() {
    return null;
  }
}

function chatFor(fixture: GoldenFixture): ScriptedChat {
  const db = new Database(":memory:");
  intakeApplySchema(db);
  const clock = new ManualClock(fixture.startMs);
  const extractor = new QueueExtractor();
  let docs = 0;
  const engine = new IntakeEngine({
    tracker: new CountingTracker(),
    drafts: new SqliteDraftRepository(db),
    bindings: new SqliteChannelBindingStore(db),
    copy: makeCopyCatalog(TEST_COPY),
    clock,
    extractor,
    catalog,
    variant: "tech",
    urgencyRules: URGENCY,
    identifierPrefix: "TECH",
    confirm: { minConfirmDelayMs: fixture.minConfirmDelayMs },
    genDocId: () => `doc-${++docs}`,
  });
  return new ScriptedChat({ engine, clock, extractor });
}

const fixtures: GoldenFixture[] = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => parseFixture(readFileSync(join(GOLDEN_DIR, f), "utf8")));

const scenarioNames = fixtures.map((f) => f.scenario);

/** Chạy mỗi kịch bản một lần; mọi test dùng chung kết quả. */
const analysed = new Map<string, Promise<GoldenDivergence[]>>();
function divergencesOf(fixture: GoldenFixture): Promise<GoldenDivergence[]> {
  let p = analysed.get(fixture.scenario);
  if (!p) {
    p = chatFor(fixture)
      .run(goldenScript(fixture))
      .then((run) => compareGolden(fixture, run));
    analysed.set(fixture.scenario, p);
  }
  return p;
}

const results: GoldenResult[] = [];

describe("bản ghi vàng lễ tân legacy phát lại qua IntakeEngine.step", () => {
  test("có đủ sáu kịch bản, tên file khớp tên kịch bản", () => {
    expect(scenarioNames).toEqual(EXPECTED_SCENARIOS);
    const files = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files).toEqual(EXPECTED_SCENARIOS.map((s) => `${s}.json`));
  });

  test("phát lại không import code legacy", () => {
    for (const file of ["golden-intake.test.ts", "golden-intake.allowlist.ts"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toMatch(/from\s+["'][^"']*tieulinh-legacy/);
    }
  });

  for (const fixture of fixtures) {
    test(`${fixture.scenario}: chỉ lệch ở chỗ allowlist cho phép`, async () => {
      const divergences = await divergencesOf(fixture);
      const verdict = applyAllowlist(divergences, GOLDEN_ALLOWLIST);
      results.push({ scenario: fixture.scenario, turns: fixture.turns.length, verdict });
      const detail = verdict.unexpected
        .map(
          (d) =>
            `  lượt ${d.turn} ${d.field}: ghi vàng ${JSON.stringify(d.expected)}, engine ${JSON.stringify(d.actual)}`,
        )
        .join("\n");
      expect(
        verdict.unexpected,
        `${fixture.scenario} lệch ngoài allowlist (thêm vào golden-intake.allowlist.ts kèm lý do, hoặc sửa engine):\n${detail}`,
      ).toEqual([]);
    });
  }

  test("allowlist không có dòng thừa (đã khớp thì phải xoá dòng)", async () => {
    const all = (await Promise.all(fixtures.map(divergencesOf))).flat();
    const { stale } = applyAllowlist(all, GOLDEN_ALLOWLIST, scenarioNames);
    expect(stale, `Dòng allowlist không còn lệch, hãy xoá: ${JSON.stringify(stale)}`).toEqual([]);
  });

  afterAll(() => {
    console.log(`\n${formatGoldenReport(results)}\n`);
  });
});
