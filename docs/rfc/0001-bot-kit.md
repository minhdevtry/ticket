# RFC 0001: Bot kit (`defineBot` / `createBot`)

- Trạng thái: đề xuất; milestone 1 (nền tảng) đã cài đặt; milestone 2a (độ bền và thời gian: kho bền, lịch cron, hẹn giờ, tự đăng ký webhook) đã cài đặt, runtime lễ tân còn lại
- Ngày: 2026-10-25
- Phạm vi: `packages/core` (`@vuihoc/bot-core`), `apps/tieulinh-legacy`

## Bối cảnh

`@vuihoc/bot-core` đã có nhiều mảnh (engine tiếp nhận, client itsaplan, webhook, Telegram, OpenClaw) nhưng mỗi bot vẫn tự ráp: tự đọc env, tự dựng worker, tự viết vòng poll `agent-runs` (Tiểu Linh: `worker/agent-runner.ts`), tự đóng gói health, tự tắt êm. Mỗi bot mới lặp lại việc đó và mắc lại các lỗi cũ (không heartbeat, không backoff, mất kết quả khi báo lỗi).

Một bot thực chất có **hai vai**:

- **Lễ tân** (receptionist): hội thoại tiếp nhận qua chat → xác nhận → tạo ticket.
- **Hậu cần** (back office): làm việc trên ticket đã có: trả lời mention, xử lý ticket được giao, phản ứng khi ticket đổi cột, chạy theo lịch, đóng vòng đời ticket.

Itsaplan có sẵn cơ chế giao việc cho agent ngoài (hàng đợi `agent-runs`, xem [tham chiếu](/reference/agent-runs)). Hậu cần nên dựa trên đó thay vì tự dựng cơ chế riêng.

## Mục tiêu

1. Một **khai báo** (`defineBot`) mô tả cả bot: định danh, dự án, persona, vai lễ tân, vai hậu cần.
2. Một **runtime** (`createBot`) có vòng đời rõ (`start`, `stop`, `health`) và `/healthz`.
3. Cấu hình **kiểm tra lúc khởi động**, lỗi gom đủ, secret không lộ.
4. Hậu cần chạy trên **agent-runs native** của itsaplan với heartbeat, backoff, dừng êm, idempotency.
5. Không phá API hiện có; Tiểu Linh chuyển dần.

Không phải mục tiêu: thay engine hội thoại; thay OpenClaw; viết lại Tiểu Linh trong một PR.

## Khai báo

```ts no-check
export default defineBot({
  id: "tieulinh",                         // chữ thường, số, gạch ngang; dùng trong log/health/khoá
  tracker: { team: "tech", project: "TECH2" },
  persona: copyVi,                        // CopyCatalog của lễ tân
  env: defineEnv({ ... }),                // schema zod; tới handler qua ctx.config

  receptionist: {                         // milestone 2: runtime
    channels: [telegram({ account: "ticket" })],
    catalog, priorityRules, extractor: llmExtractor(),
  },

  backoffice: {
    agent: "tieulinh2",                   // username agent trên itsaplan
    on: {                                 // handler theo trigger của run
      mention: answerMention,
      delegation: triage,
      field, manual, status, event, fallback,
      schedule: staleDigest,              // run `schedule` từ lịch tạo trên itsaplan
    },
    schedule: { "0 8 * * MON-FRI": digest },  // lịch do bot giữ (M2a), kho SQLite
    rules: [                              // sự kiện → điều kiện → hành động (webhook)
      whenColumn("Cần phân loại").do(actions.comment("Đã nhận"), actions.setPriority("medium")),
      whenResolved().do(notifyReporter, actions.closeAfter("48h")),  // hẹn giờ bền (M2a)
    ],
    runs: { concurrency: 2 },
  },
});
```

### Schema (milestone 1)

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | `string` | `^[a-z][a-z0-9-]{1,39}$` |
| `tracker.team` | `string` | **bắt buộc**, slug team (`^[a-z][a-z0-9-]{0,38}[a-z0-9]$`), vd `tech` |
| `tracker.project` | `string` | **bắt buộc**, mã dự án trong team (`^[A-Z][A-Z0-9]*$`), vd `TECH2`; bot chỉ đụng issue của dự án này |
| `persona` | `CopyCatalog?` | dùng cho lễ tân |
| `env` | `EnvSchema?` | `defineEnv({...})` |
| `receptionist` | `ReceptionistDefinition?` | chỉ kiểm hình dạng ở M1 |
| `backoffice.agent` | `string?` | gỡ `@agent` khỏi nội dung comment |
| `backoffice.on.<trigger>` | `RunHandler` | trigger hợp lệ: `mention`, `delegation`, `field`, `schedule`, `manual`, `status`, `event`, `fallback` |
| `backoffice.rules` | `Rule[]` | tên luật duy nhất |
| `backoffice.runs` | `{ concurrency, pollIntervalMs, heartbeatIntervalMs, runTimeoutMs }` | |

Cần ít nhất một vai. `defineBot` kiểm tra và ném **một** `BotDefinitionError` liệt kê mọi chỗ sai (gõ nhầm `mentionn`, không phải hàm, tên luật trùng…). `defineBot` thuần: không đọc env, không mạng.

### Dự án luôn có team: ref đủ `<team>.<KEY>`

Mọi dự án nằm trong một team và mã `KEY` chỉ duy nhất trong team. Khoá trần (`TECH2`) vì vậy mơ hồ khi nhiều team trùng khoá; server cũ vẫn nhận khoá trần nhưng đoán theo dự án tạo sớm nhất. Bot kit không đoán: `tracker.team` bắt buộc, `defineBot` kiểm định dạng (slug team, `KEY` in hoa) và mọi lời gọi itsaplan (`/projects/tech.TECH2/...`) đi bằng ref đủ, lộ ra ở `ctx.tracker.ref`. Mã issue (`TECH2-42`) vẫn dùng khoá trần vì nó nằm trong team sẵn. `FakeItsaplan` từ chối khoá trần mặc định để test bắt được chỗ quên.

### Handler theo trigger

Handler nhận `RunContext`:

- `run`, `trigger`, `config` (có kiểu), `logger`, `signal` (huỷ khi mất lease/tắt cưỡng bức), `trace`, `clock`, `idempotencyKey`;
- `attempt`, `maxAttempts`, `prompt` (prompt nguyên văn);
- `comment`: comment đã phân tích (`text` đã gỡ HTML và `@bot`, `replyToId`, `threadContext`); CHỈ có ở trigger `mention`, trigger khác là `null`;
- `issue()`: issue của run (lazy, nhớ kết quả, `null` nếu ngoài dự án);
- `tracker`: client **khoá vào dự án**, có `tracker.ref` (`tech.TECH2`) (`getIssue`, `comment`, `moveTo`, `assign`, `setPriority`, `search`...). Ghi lên issue ngoài dự án ném `OutOfProjectError`;
- `reply(text)`: comment trả lời đúng luồng, gắn dấu bot, **chống trùng theo run và số thứ tự lần gọi** (`reply#n`); kiểm-rồi-ghi không nguyên tử.

Trả về: chuỗi (success + output), không gì (success), hoặc `{ status: "failed", error }` / `{ status: "retry" }`. Ném lỗi thường = `failed`; lỗi tạm thời (5xx/429/mạng/hết giờ) = `retry`, và ở lượt cuối `retry` thành `failed` kèm lý do.

### Luật

`event → điều kiện → hành động` trên webhook đã qua `ItsaplanWebhookServer` (chữ ký, dedupe). Bộ dựng: `whenEvent`, `whenColumn`, `whenResolved`, `whenDone`, `whenCommentCreated`, cộng `.and(cond)`, `.named()`, `.do(...)`. Hành động dựng sẵn trong namespace `actions`: `actions.comment`, `moveTo`, `assign`, `setPriority`; hành động tuỳ ý là một hàm. Sự kiện đổi cột là `issue.state_changed` (đã đối chiếu code server: không có `issue.column_changed`). Engine tự bỏ qua sự kiện ngoài dự án, do agent gây ra (chống vòng lặp), comment của bot, và sự kiện trùng. Lỗi một luật không chặn luật khác.

## Vòng đời

```
createBot(def, { env, logger?, clock? })     đồng bộ, KHÔNG mạng, KHÔNG nghe cổng
   ├─ validate khai báo            → BotDefinitionError
   ├─ loadConfig(kit + def.env)    → ConfigError (gom mọi lỗi, secret không lộ)
   └─ dựng client, worker, engine
bot.start()                         created → starting → running
   ├─ preflight: đọc cột của dự án (key sai / dự án không có → ném, state failed)
   ├─ webhook server (nếu có rules và BOT_WEBHOOK_PORT)
   ├─ worker agent-runs bắt đầu poll
   └─ /healthz (nếu BOT_HEALTH_PORT)
bot.health()                        status: starting | ok | degraded | down | stopped
bot.stop()                          êm, idempotent: ngừng claim → chờ run tới drainTimeoutMs (5 s) → huỷ
                                    → chờ tối đa 1 s rồi bỏ mặc handler phớt lờ signal
runBot(bot)                         start + SIGINT/SIGTERM/lỗi chết → stop (hạn thoát cưỡng bức = bot.stopBudgetMs;
                                    tín hiệu thứ hai thoát ngay; lỗi chết thoát mã 1)
```

`health()`:

- `ok`: đang chạy, poll gần đây thành công.
- `degraded`: claim lỗi liên tiếp từ 3 lần, hoặc quá lâu chưa poll thành công (không tính lúc bận hết concurrency).
- `down`: worker dừng vì lỗi chết (key bị từ chối 3 lần liên tiếp, agent có invocation URL) hoặc bot `failed`.
- `/healthz` trả 200 cho `ok`/`degraded`, 503 cho còn lại; mặc định bind `127.0.0.1`.

Cấu hình và log:

- `createBot` nhận `env` tường minh. `.env` chỉ đọc khi truyền `envFile`; biến có sẵn trong `env` thắng file; không bao giờ ghi ngược `process.env`.
- Thiếu/sai: một `ConfigError` liệt kê mọi biến (tên và lý do, không có giá trị).
- Secret (đánh dấu `secret()` hoặc tên chứa `KEY`/`SECRET`/`TOKEN`/`PASSWORD`) hiện `[REDACTED]` trong `loaded.redacted`; logger của bot bọc `redactSecrets` trên mọi dòng.

## Cách lễ tân và hậu cần cắm vào

Cả hai vai dùng chung: `tracker` (dự án), `persona`, `config`, `logger`, vòng đời và health. Khác nhau ở nguồn việc:

| | Nguồn việc | Thành phần |
|---|---|---|
| Lễ tân | tin nhắn chat | kênh (Telegram…) → engine hội thoại → `TrackerPort.createIssue` |
| Hậu cần | run agent-runs + webhook + (M2) lịch | worker polling → dispatcher theo trigger; webhook → rule engine |

Hai vai chạm nhau ở ticket: lễ tân tạo ticket và lưu binding (ticket ↔ chat); hậu cần phản ứng khi ticket đổi. Ví dụ `notifyReporter` của hậu cần cần binding của lễ tân để biết nhắn ai. Ở M2 hai vai chia sẻ một "cổng thông báo" (`ChannelPort` + binding store) đã có trong `intake/notify`.

## Hai host

1. **Standalone** (milestone 1): `runBot(createBot(def, { env: process.env }))` thành một process, có `/healthz`, systemd/docker quản lý.
2. **OpenClaw-hosted** (milestone 3): OpenClaw giữ kênh và agent hội thoại; bot kit chạy như plugin: lễ tân chạy qua tool/hook của OpenClaw, hậu cần vẫn là worker agent-runs. Cần `createBot` tách `start()` thành các phần (`startBackoffice`, `handleEvent`) để host chọn phần nào của nó chạy. `bot.handleEvent(envelope)` đã tồn tại ở M1 cho trường hợp host đã có webhook server riêng.

## Lộ trình

| Milestone | Nội dung |
|---|---|
| **1 (PR này)** | `defineBot`/`createBot`/`runBot`, `defineEnv`/`loadConfig`, agent-runs client + worker, `backoffice` (trigger dispatch, tracker khoá dự án, luật tối thiểu), `FakeItsaplan`, ví dụ `minimal-bot`, tài liệu |
| **2a (đã cài đặt)** | Độ bền và thời gian: kho SQLite bền (`BOT_DATA_DIR`: ledger agent-runs, khoá `reply#n`, dedupe luật, mốc cron, hẹn giờ, lease một-instance), lịch cron do bot giữ (`backoffice.schedule`, tự giữ trong process, không phụ thuộc API lịch của itsaplan), `actions.after`/`closeAfter`/`cancelTimer` với khoá huỷ, đăng ký webhook theo `rules` (opt-in) |
| 2b | Runtime lễ tân trong `createBot` (kênh Telegram, engine, extractor); binding ticket ↔ chat dùng chung với hậu cần |
| 3 | Host OpenClaw; chuyển Tiểu Linh sang `defineBot` |

## Lộ trình chuyển `apps/tieulinh-legacy`

> Cập nhật 2026-10-25: chủ repo chốt giữ `apps/tieulinh-legacy` làm bản tham chiếu đóng băng và xây app mới (thư mục dự kiến apps/tieulinh) bằng `defineBot` (xem [Bản legacy và bản mới](/explanation/tieulinh-legacy)). Các bước dưới là danh sách việc cần đối chiếu khi xây bản mới, không còn là việc sửa tại chỗ bản legacy.

1. Thay `worker/agent-runner.ts` bằng `AgentRunWorker` (giữ nguyên logic `handleRun` thành handler `mention`). Được: heartbeat, backoff, dừng êm, không mất kết quả. Không đổi hành vi nhìn thấy được. Làm trước vì rủi ro thấp nhất và giá trị cao nhất.
2. Gom đọc env của `worker/index.ts` vào `defineEnv`/`loadConfig`; thêm `/healthz`.
3. Đưa `worker/lifecycle.ts` và các phản ứng theo cột/Resolved vào `rules`.
4. Khi lễ tân (M2) xong: bọc pipeline hiện tại thành `receptionist`, `worker/index.ts` còn `runBot(createBot(def))`.

Mỗi bước là một PR riêng, chạy song song với bản cũ (cờ bật/tắt) đến khi đã quan sát an toàn.

## Câu hỏi mở

1. **Lịch cục bộ** (đã quyết ở M2a): bot tự giữ lịch trong process bằng kho SQLite (`backoffice.schedule`), không tạo lịch trên itsaplan, nên không cần quyền quản lý schedule và không phải định tuyến bằng thẻ trong prompt. Run `schedule` từ lịch người vận hành tạo tay vẫn đi qua `on.schedule`.
2. **Hẹn giờ bền** cho `closeAfter` (đã quyết ở M2a): SQLite cục bộ, mỗi bot một file. Đổi lại phải có ổ đĩa bền cho `BOT_DATA_DIR`; mất file thì mất hẹn đang chờ (không hỏng ticket).
3. **Một key hay hai**: hậu cần cần key agent (claim) cộng key có quyền ghi tracker. Hiện tracker client dùng cùng key agent. Đăng ký webhook (đã cài đặt ở M2a) dùng key riêng `ITSAPLAN_WEBHOOK_KEY` chỉ cho việc đó; chưa tách key ghi tracker.
4. **Khung prompt** của run `mention` do server chọn. Có nên đề nghị itsaplan trả thêm `sourceActivityId`/`scheduleId` có cấu trúc trong claim để khỏi parse văn bản?
5. **Ranh giới `retry`**: server không có API "trả run về hàng đợi", chỉ có cách để lease hết hạn (mặc định 5 phút, tối đa 3 lần). Có cần đề nghị endpoint release/defer?
6. **Nhiều bot một process**: `createBot` hiện là một bot một process; có cần `createFleet([...])` dùng chung health server không?
7. **Ledger bền** (đã quyết ở M2a): có, khi đặt `BOT_DATA_DIR`. Không đặt thì vẫn in-memory (mặc định của test) và idempotency ở tầng comment (dấu ẩn) vẫn chặn ghi trùng.

## Phát hiện từ review và việc để lại cho milestone 2 (trạng thái sau M2a)

Review độc lập của PR milestone 1 đã được xử lý ngay trong PR (lỗi tạm thời không còn thành `failed`, `stop()` bị chặn trên, run bị giao lại được nhận thay vì bỏ qua, ranh giới dự án theo `projectId`, luật chỉ đánh dấu "đã thấy" sau thành công, che secret theo giá trị, webhook ngoài loopback bắt buộc có secret, `issue.column_changed` bị bỏ vì server không phát sự kiện đó). Những mục sau cố ý để lại ở M1, mỗi mục nên thành một issue riêng; trạng thái ghi cuối từng mục sau khi M2a (độ bền và thời gian) cài đặt. Mục "đăng ký webhook theo `rules`" của lộ trình đã xong ở M2a (opt-in, `BOT_WEBHOOK_AUTO_REGISTER`).

1. **`findIssueByIdentifier` mặc định vẫn nuốt mọi lỗi** thành "không thấy" (cho tương thích các bot cũ). Bot kit dùng `strict` (chỉ nuốt 404). Cần rà các nơi gọi của `apps/tieulinh-legacy` rồi đổi mặc định. *Còn mở.*
2. **Ghi comment không nguyên tử**: chống trùng là kiểm-rồi-ghi bằng dấu ẩn. Cần itsaplan nhận khoá idempotency khi tạo comment, hoặc bot giữ khoá bền. *Một phần (M2a): bot giữ khoá bền (`BOT_DATA_DIR`), nên sau restart không phải đọc lại timeline; vẫn chưa nguyên tử giữa hai lượt chạy đồng thời, cần phía itsaplan.*
3. **Ledger bền** (SQLite) cho `RunLedger`; hiện in-memory. *Xong (M2a): `BotStore.ledger()`, bật bằng `BOT_DATA_DIR`.*
4. **Endpoint nhả/hoãn run** ở itsaplan để `retry` không phải chờ lease hết hạn (5 phút). *Còn mở (cần phía itsaplan).*
5. **Heartbeat lỗi liên tiếp** nên huỷ handler trước khi lease hết hạn thay vì chờ server báo mất lease. *Còn mở.*
6. **`X-Itsaplan-Event-Id`** (mã giao nhận ổn định của server, nằm ở header chứ không ở body) chưa tới được handler của `ItsaplanWebhookServer`, nên dedupe vẫn dựa vào `webhookTimestamp`. Nên chuyển header xuống handler. *Một phần (M2a): dedupe của luật (`webhookTimestamp`) được lưu bền; chuyển header xuống handler còn mở. Dedupe ở tầng HTTP của `ItsaplanWebhookServer` cố ý vẫn in-memory: nó chiếm khoá trước khi xử lý, lưu bền thì một lần sập giữa chừng làm mất sự kiện vĩnh viễn.*
7. **`comment.deleted`** có ở server nhưng chưa có trong `ItsaplanWebhookEventName`. *Còn mở.*
8. **Luật**: chưa có hẹn giờ (`closeAfter`), chưa có thử lại riêng từng luật, và tracker của luật chưa gắn `signal` như tracker của run. *Hẹn giờ xong (M2a: `after`, `closeAfter`, `cancelTimer`, khoá huỷ; hẹn có thử lại và tracker gắn `signal`). Thử lại riêng từng luật và `signal` cho tracker của luật chạy theo webhook còn mở.*
9. **Brand type** cho từng phần của ref (team slug, mã dự án) thay vì chỉ `ProjectRef`; hiện chỉ ref đủ là brand. *Còn mở.*
10. **Một key hay hai** (câu hỏi mở 3) vẫn chưa quyết: tracker còn dùng key agent. *Key đăng ký webhook đã tách (`ITSAPLAN_WEBHOOK_KEY`); key ghi tracker còn mở.*

## Phương án đã loại

- **Chỉ dùng webhook** cho hậu cần: webhook mất sự kiện khi bot tắt, không có lease/thử lại, không có presence; agent-runs có sẵn các thứ đó.
- **Handler tự do không khoá dự án**: quá dễ ghi nhầm sang dự án khác (đã có tiền lệ khoá dự án ở worker Tiểu Linh), nên tracker của handler khoá theo dự án từ đầu, kèm lối thoát `unscopedClient`.
- **Class kế thừa `BaseBot`**: khó kiểm tra, khó test; khai báo dữ liệu + hàm thuần dễ kiểm hơn.
