# Kiểm hội thoại bằng kịch bản và bản ghi vàng

Việc cần làm: kiểm một cuộc hội thoại tiếp nhận sự cố từ đầu đến cuối (tin vào, chữ và nút ra) mà không phải gọi từng hàm của engine bằng tay, và so engine mới với hành vi của bản legacy từng chữ, từng nút. Hai công cụ cùng nằm ở `@vuihoc/bot-core/testing`:

- `ScriptedChat`: chạy một kịch bản "tin vào, kỳ vọng ra" qua `engine.step`.
- **Bản ghi vàng**: kịch bản ghi một lần từ bản legacy thành JSON trong repo. Engine mới phát lại phần **đầu vào** và so phần **đầu ra**, nên không phải import code legacy.

Lý do và vị trí trong lộ trình: [RFC 0002](/rfc/0002-receptionist) mục 5 ("Hai cơ chế chống mất hành vi"). Bảng tra (định dạng fixture, trường so sánh, quy tắc allowlist): [Tham chiếu testing](/reference/testing).

## 1. Viết một kịch bản

Một kịch bản là danh sách lượt. Mỗi lượt nói người báo gửi gì (`say`), đồng hồ đi bao lâu trước đó (`advanceMs`), bộ trích xuất giả trả gì (`extract`) và điều mong đợi (`expect`). Mẫu dưới dựng engine thật với đồng hồ tay, bộ trích xuất xếp hàng và tracker giả, rồi kiểm ba lượt: hỏi bộ phận, tóm tắt, và một lần xác nhận tới quá sớm bị từ chối.

```ts run
import { Database } from "bun:sqlite";
import {
  createCatalog,
  type CopyCatalog,
  type ExtractedFields,
  type FieldExtractorPort,
  IntakeEngine,
  intakeApplySchema,
  SqliteChannelBindingStore,
  SqliteDraftRepository,
  type TrackerPort,
} from "@vuihoc/bot-core/intake";
import { ManualClock, ScriptedChat } from "@vuihoc/bot-core/testing";

const catalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Sự cố kỹ thuật",
        truong_mo_dau: "van_de",
        recap: ["van_de", "bo_phan"],
        truong: {
          van_de: { bat_buoc: true, kieu: "text", duoc_hoi: true, nhan: "Vấn đề", hoi: "Vấn đề là gì ạ?" },
          bo_phan: { bat_buoc: true, kieu: "text", duoc_hoi: true, nhan: "Bộ phận", hoi: "Anh/chị bên bộ phận nào ạ?" },
        },
      },
    },
  },
});

// Chữ do bot cung cấp; ở đây chỉ cần trả lại tên khoá để kịch bản kiểm được luồng.
const copy: CopyCatalog = { text: (key) => key };

// Bộ trích xuất giả: lấy kết quả đã xếp cho từng lượt (ScriptedChat.extract xếp vào đây).
const queue: ExtractedFields[] = [];
const extractor: FieldExtractorPort & { push(...f: ExtractedFields[]): void } = {
  push: (...f) => void queue.push(...f),
  extract: async () => queue.shift() ?? { userIntent: "chitchat" },
};

const tracker: TrackerPort = {
  createIssue: async (input) => ({ id: 1001, identifier: "TECH-1", title: input.title }),
  getIssue: async () => null,
  addComment: async () => {},
  attach: async () => 0,
  findByIdentifier: async () => null,
};

const db = new Database(":memory:");
intakeApplySchema(db);
const clock = new ManualClock();

const engine = new IntakeEngine({
  tracker,
  drafts: new SqliteDraftRepository(db),
  bindings: new SqliteChannelBindingStore(db),
  copy,
  clock,
  extractor,
  catalog,
  variant: "tech",
  urgencyRules: { levels: ["Low", "Medium", "High", "Urgent"], floors: [], ceilings: [] },
  identifierPrefix: "TECH",
});

const run = await new ScriptedChat({ engine, clock, extractor }).run({
  name: "xac-nhan-qua-som",
  turns: [
    {
      say: "App không làm bài được",
      extract: { userIntent: "report_issue", title: "Không làm bài được", symptoms: ["không làm bài được"], values: { van_de: "không làm bài được" } },
      expect: { outcome: "asked", includes: "bộ phận", buttons: null },
    },
    {
      say: "Em bên Vận hành",
      advanceMs: 10_000,
      extract: { userIntent: "provide_info", values: { bo_phan: "Vận hành" } },
      expect: { outcome: "summary", buttons: [["button.confirm_create"]] },
    },
    {
      say: "button.confirm_create",
      advanceMs: 1_100, // người thật không bấm trong 1,1 giây (bug 24/09)
      extract: { userIntent: "confirm" },
      expect: { outcome: "too_soon", issue: null },
    },
  ],
});

run.assertOk();
console.log(`${run.name}: ${run.turns.length} lượt khớp kỳ vọng`);
```

`run.assertOk()` ném lỗi nêu từng chỗ lệch (lượt mấy, trường nào, kỳ vọng và thực tế). `ScriptedChat.run` không tự ném, nên cũng đọc được `run.mismatches` và `run.turns` (bản ghi từng lượt, gồm `output` gốc của engine) khi muốn kiểm kiểu khác.

Các điều kiện trong `expect` đều tuỳ chọn; trường nào bỏ trống thì không kiểm:

| Điều kiện | Kiểm |
|---|---|
| `outcome` | Kết quả engine (`asked`, `summary`, `created`, ...); mảng nghĩa là "một trong" |
| `text`, `includes`, `excludes` | Chữ gửi người báo (các tin của lượt nối bằng xuống dòng): đúng nguyên văn, chứa, không chứa |
| `buttons` | Nhãn nút theo từng hàng; `null` là lượt không có nút |
| `issue` | Mã ticket của lượt; `null` là lượt không có ticket |

Kịch bản chạy tuần tự, mỗi lượt xong rồi mới tới lượt sau. Nó không mô phỏng hai tin tới cùng lúc (ca "hai cú xác nhận đồng thời" vẫn là test riêng của engine).

## 2. Ghi bản ghi vàng từ bản legacy

Khi cần biết bản legacy trả gì cho cùng chuỗi tin, ghi nó một lần thay vì chép chữ bằng tay. Việc ghi nằm ở `apps/tieulinh-legacy/scripts/golden` (chỗ duy nhất dính code legacy):

```bash
bun run --cwd apps/tieulinh-legacy golden:record           # ghi (đè) các file JSON
bun run --cwd apps/tieulinh-legacy golden:record --check   # không ghi; thoát 1 nếu file trong repo khác bản ghi mới
```

Kịch bản (chỉ là dữ liệu) ở `apps/tieulinh-legacy/scripts/golden/scenarios.ts`; fixture nằm ở `packages/core/golden/intake/<kịch-bản>.json`. Bản ghi chạy pipeline legacy thật với mọi nguồn không tất định bị cố định, nên **ghi lại hai lần cho hai file giống từng byte**:

- đồng hồ giả (bắt đầu 2026-01-01, đi theo `advanceMs` của từng lượt);
- itsaplan giả, mã ticket đếm từ 101;
- bộ trích xuất heuristic của legacy, không LLM;
- dữ liệu tổng hợp: SĐT `0900000005`, chat `telegram:-1000000000001`, host `*.example.com`. `bun run scan` quét cả fixture.

Test `apps/tieulinh-legacy/scripts/golden/record.test.ts` giữ ba điều: hai lần ghi bằng nhau, file trong repo bằng bản ghi mới (nếu lệch nghĩa là hành vi legacy đã đổi, và legacy là bản đóng băng), mỗi kịch bản ra một fixture hợp lệ.

Mỗi lượt trong fixture có `message`, `action`, `voiceText`, `buttons` (hợp đồng `intake_step` của legacy), cộng `advanceMs` và `extract` để phát lại. Mã ticket và link trong `voiceText` được thay bằng `{identifier}` và `{url}` (cùng hàm `normalizeVoiceText` ở hai phía), nên không phụ thuộc cách mỗi bên đánh số ticket. Định dạng đầy đủ: [Tham chiếu testing](/reference/testing).

`extract` là kết quả trích xuất mà bộ trích xuất giả của engine mới trả cho lượt đó. Nó được ghim trong kịch bản vì engine mới chưa có bộ trích xuất heuristic; lúc ghi, `userIntent` của nó bị đối chiếu với kết quả thật của legacy, nên ghim không trôi khỏi hành vi legacy.

## 3. Phát lại ở engine mới

Engine mới đọc JSON, biến nó thành kịch bản bằng `goldenScript` (chỉ đầu vào, không có kỳ vọng), chạy qua `ScriptedChat`, rồi `compareGolden` so từng lượt `action`, chữ đã chuẩn hoá và nút:

```ts check
import { applyAllowlist, compareGolden, goldenScript, parseFixture, ScriptedChat } from "@vuihoc/bot-core/testing";
import type { ManualClock } from "@vuihoc/bot-core/testing";
import type { ExtractedFields, IntakeEngine } from "@vuihoc/bot-core/intake";

declare const fixtureJson: string; // nội dung packages/core/golden/intake/<kịch-bản>.json
declare const engine: IntakeEngine; // dựng như ở mục 1, đồng hồ bắt đầu ở fixture.startMs
declare const clock: ManualClock;
declare const extractor: { push(...f: ExtractedFields[]): void };

const fixture = parseFixture(fixtureJson);
const run = await new ScriptedChat({ engine, clock, extractor }).run(goldenScript(fixture));

const divergences = compareGolden(fixture, run); // rỗng = khớp từng chữ
const verdict = applyAllowlist(divergences, [], [fixture.scenario]);
console.log(verdict.unexpected, verdict.expected, verdict.stale);
```

Test mẫu của repo là `packages/core/src/intake/engine/golden-intake.test.ts`: nó phát lại cả sáu kịch bản qua `IntakeEngine` hiện tại và in một báo cáo, ví dụ:

```text
Bản ghi vàng: 6 kịch bản, 0 khớp, 6 lệch
  lệch có phép first-ok: 4 được phép, 0 chưa được phép: lượt 1 [voiceText, buttons]; lượt 2 [voiceText, buttons]
```

### Allowlist: lệch có phép, co dần

Engine hiện chưa khớp bản legacy ở nhiều chỗ (chữ tiếng Anh, câu hỏi không kèm nút, huỷ không trả tin). Các chỗ đó nằm trong `packages/core/src/intake/engine/golden-intake.allowlist.ts`, mỗi nhóm có lý do và PR sẽ xoá. Quy tắc:

- Lệch **không** có trong allowlist làm test đỏ (hồi quy hoặc lệch mới).
- Dòng allowlist mà engine không còn lệch nữa **cũng** làm test đỏ. PR làm engine khớp thêm một chỗ phải xoá dòng tương ứng, nên danh sách chỉ co lại và tiến độ nhìn thấy được trong diff.
- Dòng cụ thể (`scenario`, `turn`, `field`) đứng trước dòng `"*"`; lý do ghi vào dòng, không ghi ở chỗ khác.

## 4. Thêm một kịch bản

1. Thêm kịch bản vào `apps/tieulinh-legacy/scripts/golden/scenarios.ts`: `source` ghi test legacy gốc, mỗi lượt có `message` và `extract`. Dùng dữ liệu tổng hợp.
2. `bun run --cwd apps/tieulinh-legacy golden:record` rồi commit file JSON mới.
3. Thêm tên kịch bản vào `EXPECTED_SCENARIOS` trong `golden-intake.test.ts`, chạy test, và thêm các chỗ lệch thật vào allowlist kèm lý do và PR.

## Xem thêm

- [Tham chiếu testing](/reference/testing): định dạng fixture, trường so sánh, quy tắc allowlist.
- [RFC 0002](/rfc/0002-receptionist) mục 5: vì sao có bản ghi vàng và PR nào làm hết lệch.
