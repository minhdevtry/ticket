# RFC 0001: Bot kit (`defineBot` / `createBot`)

- Trạng thái: đề xuất, milestone 1 (nền tảng) đi kèm RFC này
- Ngày: 2026-10-25
- Phạm vi: `packages/core` (`@vuihoc/bot-core`), `apps/tieulinh`

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
    rules: [                              // sự kiện → điều kiện → hành động (webhook)
      whenColumn("Cần phân loại").do(comment("Đã nhận"), setPriority("medium")),
      whenResolved().do(notifyReporter),
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
- `comment`: comment đã phân tích (`text` đã gỡ HTML và `@bot`, `replyToId`, `threadContext`);
- `issue()`: issue của run (lazy, nhớ kết quả, `null` nếu ngoài dự án);
- `tracker`: client **khoá vào dự án**, có `tracker.ref` (`tech.TECH2`) (`getIssue`, `comment`, `moveTo`, `assign`, `setPriority`, `search`...). Ghi lên issue ngoài dự án ném `OutOfProjectError`;
- `reply(text)`: comment trả lời đúng luồng, gắn dấu bot, **chống trùng theo run**.

Trả về: chuỗi (success + output), không gì (success), hoặc `{ status: "failed", error }` / `{ status: "retry" }`. Ném lỗi = `failed`.

### Luật

`event → điều kiện → hành động` trên webhook đã qua `ItsaplanWebhookServer` (chữ ký, dedupe). Bộ dựng: `whenEvent`, `whenColumn`, `whenResolved`, `whenDone`, `whenCommentCreated`, cộng `.and(cond)`, `.named()`, `.do(...)`. Hành động dựng sẵn: `comment`, `moveTo`, `assign`, `setPriority`; hành động tuỳ ý là một hàm. Engine tự bỏ qua sự kiện ngoài dự án, do agent gây ra (chống vòng lặp), comment của bot, và sự kiện trùng. Lỗi một luật không chặn luật khác.

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
bot.stop()                          êm, idempotent: ngừng claim → chờ run tới drainTimeoutMs → huỷ
runBot(bot)                         start + SIGINT/SIGTERM → stop (tín hiệu thứ hai thoát ngay)
```

`health()`:

- `ok`: đang chạy, poll gần đây thành công.
- `degraded`: claim lỗi liên tiếp từ 3 lần, hoặc quá lâu chưa poll thành công.
- `down`: worker dừng vì lỗi chết (key bị từ chối, agent có invocation URL) hoặc bot `failed`.
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
| 2 | Runtime lễ tân trong `createBot` (kênh Telegram, engine, extractor); lịch cục bộ `schedule: { "0 8 * * *": fn }` (bot tự bảo đảm lịch trên itsaplan qua API agent-schedules, gắn thẻ vào prompt để định tuyến); `closeAfter("48h")` và mọi hẹn giờ cần kho bền; đăng ký webhook theo `rules`; ledger bền (SQLite) cho agent-runs |
| 3 | Host OpenClaw; chuyển Tiểu Linh sang `defineBot` |

## Lộ trình chuyển `apps/tieulinh`

1. Thay `worker/agent-runner.ts` bằng `AgentRunWorker` (giữ nguyên logic `handleRun` thành handler `mention`). Được: heartbeat, backoff, dừng êm, không mất kết quả. Không đổi hành vi nhìn thấy được. Làm trước vì rủi ro thấp nhất và giá trị cao nhất.
2. Gom đọc env của `worker/index.ts` vào `defineEnv`/`loadConfig`; thêm `/healthz`.
3. Đưa `worker/lifecycle.ts` và các phản ứng theo cột/Resolved vào `rules`.
4. Khi lễ tân (M2) xong: bọc pipeline hiện tại thành `receptionist`, `worker/index.ts` còn `runBot(createBot(def))`.

Mỗi bước là một PR riêng, chạy song song với bản cũ (cờ bật/tắt) đến khi đã quan sát an toàn.

## Câu hỏi mở

1. **Lịch cục bộ**: bot tự tạo/đồng bộ lịch trên itsaplan (cần quyền quản lý schedule, thường là key của người, không phải key agent) hay chỉ nhận run `schedule` từ lịch người vận hành tạo tay? Claim không trả `scheduleId`, nên định tuyến phải dựa vào thẻ trong prompt.
2. **Hẹn giờ bền** cho `closeAfter`: SQLite cục bộ (đơn giản, mỗi bot một DB) hay một run `schedule` của itsaplan đóng vai bộ hẹn giờ (không cần DB, nhưng độ phân giải theo phút)?
3. **Một key hay hai**: hậu cần cần key agent (claim) cộng key có quyền ghi tracker. Hiện tracker client dùng cùng key agent. Có chỗ nào cần key admin (đăng ký webhook) tách riêng?
4. **Khung prompt** của run `mention` do server chọn. Có nên đề nghị itsaplan trả thêm `sourceActivityId`/`scheduleId` có cấu trúc trong claim để khỏi parse văn bản?
5. **Ranh giới `retry`**: server không có API "trả run về hàng đợi", chỉ có cách để lease hết hạn (mặc định 5 phút, tối đa 3 lần). Có cần đề nghị endpoint release/defer?
6. **Nhiều bot một process**: `createBot` hiện là một bot một process; có cần `createFleet([...])` dùng chung health server không?
7. **Ledger bền**: mặc định in-memory mất khi process chết. Giữ in-memory ở M1 là chấp nhận được vì idempotency ở tầng comment (dấu ẩn) vẫn chặn ghi trùng; có cần ledger bền ngay ở M2 không?

## Phương án đã loại

- **Chỉ dùng webhook** cho hậu cần: webhook mất sự kiện khi bot tắt, không có lease/thử lại, không có presence; agent-runs có sẵn các thứ đó.
- **Handler tự do không khoá dự án**: quá dễ ghi nhầm sang dự án khác (đã có tiền lệ khoá dự án ở worker Tiểu Linh), nên tracker của handler khoá theo dự án từ đầu, kèm lối thoát `unscopedClient`.
- **Class kế thừa `BaseBot`**: khó kiểm tra, khó test; khai báo dữ liệu + hàm thuần dễ kiểm hơn.
