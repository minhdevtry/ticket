# Changelog

All notable changes to `@vuihoc/bot-core`. 0.x allows breaking changes, recorded here.

## Unreleased

- **`llm` (subpath mới)**: cách chuẩn để bot gọi LLM (mặc định MiniMax). Additive; không đổi API hiện có.
  - `createLlm({ baseUrl, apiKey, model, api, timeoutMs, deadlineMs, maxRetries, fetch })` → `{ complete }` cho
    `anthropic-messages` và `openai-chat`, request/response trung lập (system, vai user/assistant/tool,
    tool JSON Schema, tool call, token, `stopReason`). Thử lại CHỈ với 429/5xx/mạng/hết giờ (backoff + jitter,
    `Retry-After` vượt `maxRetryAfterMs` thì thất bại ngay; hạn tổng `deadlineMs`); lỗi có kiểu (`LlmApiError` có `status`, `retryable`; `LlmNetworkError`, `LlmTimeoutError`,
    `LlmAbortError`, `LlmResponseError`, `LlmConfigError`); key không bao giờ vào thông điệp lỗi. Không có
    `stream` (để sau).
  - `runToolLoop` + `defineLlmTool` (tham số kiểm bằng zod, lỗi nói cho model biết trường sai, trần
    `maxSteps`/`maxTotalTokens`, huỷ bằng `signal`), `extract` (sửa JSON, hỏi lại đúng một lần),
    `createLlmTracer` (bước của vòng lặp tool → sự kiện AG-UI qua `RunTrace`/`appendEvents`),
    `UsageMeter`/`estimateCost`/hook `onUsage`.
  - `llmEnv`, `llmFromConfig`; `createBot` tự đọc `LLM_BASE_URL`, `LLM_API_KEY` (secret), `LLM_MODEL`,
    `LLM_API`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_DEADLINE_MS` và đưa client tới handler qua `ctx.llm` (gắn `signal`
    của run); `Bot.llm`; `createBot(def, { llm })` để tắt/ghi đè (test). `runAgentLoop(ctx, ...)`,
    `requireLlm(ctx)`, `toRunUsage`.
  - Hành vi đã chốt sau rà soát: `toolChoice` ép chỉ áp ở bước 1; bước cuối gửi `none` và không chạy tool;
    khối tool_use bị `max_tokens` cắt không chạy; `finishReason: "refused"`; `deadlineMs` (client và vòng
    lặp) và `toolTimeoutMs`/`LlmTool.timeoutMs`; `LlmTimeoutError` không `transient` ở cấp run (thử lại ở
    cấp run chạy lại cả handler và tool); `usage` có `cacheReadTokens`/`cacheCreationTokens` (`inputTokens`
    gồm cả cache), `LlmPricing` có giá cache, `onUsage`/`UsageMeter` tính cả lần gọi hỏng đã có token
    (`LlmUsageEvent.outcome`); `temperature` chỉ gửi khi đặt; `extract` sửa JSON không đụng nội dung chuỗi
    và trả `repairs`, input không tự đóng được `</input>`, từ chối thì dừng ngay; nội dung rỗng trong hội
    thoại thành chỗ giữ chỗ (Anthropic từ chối rỗng); tham số tool hỏng được phát lại nguyên văn
    (`LlmToolCall.rawArgs`); trace bị kẹp ở 12 000 ký tự, `ctx.trace` che secret của bot, `runAgentLoop`
    ghi dòng tổng kết cả khi lỗi; `LlmNetworkError.cause` đã che key; `LLM_*` không vào `ctx.config`.
  - `RunContext.llm` (mới, `Llm | undefined`; handler dựng `RunContext` bằng tay phải thêm trường này).
  - `isTransientError` nhận lỗi có `transient: true` (để `LlmError` tạm thời thành `retry` thay vì `failed`).
  - `testing`: thêm `FakeLlm` (LLM giả trên HTTP thật, hai kiểu API). Ví dụ: `examples/llm-bot`.

- Docs site: `OutboxKind`, `CommentPayload`, `StatePayload` (`intake`) giờ được export;
  `identityTokenSchema` (`openclaw`) được export từ entry point; `ParseMode` của
  `render` được xuất lại dưới tên `RenderParseMode` (`telegram`) vì `ParseMode` của
  `send` che nó. Chỉ thêm export, không đổi hành vi. Lý do: TypeDoc (cảnh báo = lỗi)
  đòi mọi kiểu được tham chiếu phải có trong tài liệu.

- **Bot kit, milestone 2a: độ bền và thời gian** (RFC `docs/rfc/0001-bot-kit.md`). Additive; mặc định
  (không đặt `BOT_DATA_DIR`) giữ nguyên hành vi in-memory của milestone 1.
  - `backoffice`: `BotStore` (kho SQLite bền, `bun:sqlite`, WAL, schema có phiên bản qua
    `PRAGMA user_version`, từ chối file do bản code mới hơn tạo: `BotStoreVersionError`) gồm
    `RunLedger` bền (`store.ledger()`), tập khoá chống trùng (`KeySet`, `MemoryKeySet`), lease, mốc
    cron và hẹn giờ. `bun:sqlite` nạp lười (barrel import được dưới Node; mở kho cần Bun);
    `busy_timeout` đặt trước WAL kèm thử lại khi mở đồng thời nhiều process; thư mục 0700, file 0600;
    schema v2 (định danh hành động, cờ yêu cầu huỷ, hẹn xếp hàng); ledger/khoá cũ dọn định kỳ. `createScopedTracker({ keys })`: khoá `idempotencyKey` của comment sống qua
    restart. `RuleEngine({ seen, store, reporter })`: dedupe sự kiện luật bền.
  - `backoffice.schedule: { "<cron>": handler | { run, missed, timezone } }` (trước đây bị
    `defineBot` từ chối) và `scheduleOptions` (`timezone`, `missed`, `graceMs`): lịch do bot giữ.
    `parseCron` (5 trường, tên tháng/thứ, bí danh `@daily`…, múi giờ IANA qua `Intl`, mặc định
    `Asia/Ho_Chi_Minh`), `BotScheduler`, `ScheduleContext` (có `llm` như `RunContext`, ràng với
    `signal`). Mốc được chiếm nguyên tử trong kho trước khi chạy (at-most-once, hai process cùng kho
    chỉ một bên chạy); lease chống chạy chồng; mốc lỡ theo `skip` (mặc định) hoặc `catch-up-once`.
    `CronSchedule.prev`, đếm mốc theo ngày (không duyệt từng phút, độ lệch múi giờ nhớ theo ngày):
    bot tắt bao lâu cũng không chặn event loop. Id lịch trong kho là `<biểu thức>@<múi giờ>`; lịch bị
    gỡ khỏi khai báo bị dọn. Health: `firingTimers`, `failedTimers`, `tickLagMs`, lỗi tự hết sau 15
    phút, và lịch/hẹn giờ lỗi làm bot `degraded`.
  - Hẹn giờ cho luật: `actions.after(duration, fn, { key, cancelOn, guard, replace })`,
    `actions.closeAfter("48h", { to, comment })`, `actions.cancelTimer(key)`, `parseDuration`.
    Token huỷ `comment`, `reporter-comment`, `state-change`, `reopened`, `assigned` (và mọi hẹn của
    issue bị xoá); `closeAfter` kiểm lại itsaplan lúc tới hạn (mốc `statusSince` của server, đọc lại
    issue ngay trước khi ghi và trước `moveTo`); yêu cầu huỷ tới lúc hẹn đang chạy được đánh dấu và
    mọi lệnh ghi của `ctx.tracker` dừng (`TimerCancelled`, `ctx.assertActive()`, `ctx.freshIssue()`);
    hẹn lại lúc đang chạy được xếp hàng. Hẹn ghi định danh hành động (`id` tường minh hoặc loại +
    thời hạn): lệch thì hẹn bị bỏ; `after` từ chối `key` thiếu `{issue}`. `backoffice.reporter` là
    BẮT BUỘC cho `closeAfter`/`reporter-comment` (itsaplan không trả người báo; `anyHumanIsReporter`
    để chọn "mọi người comment là người báo"). `TimerContext.llm`. `RuleContext` thêm `step`, `timers`; `Rule.watches`; `RuleEngine.fireTimer`,
    `hasTimers()`; `requiredEvents()` gồm cả sự kiện chỉ để huỷ hẹn. Hẹn at-least-once, thử lại
    5 lần với backoff.
  - `ensureRuleWebhook` + `WebhookPermissionError`: đăng ký webhook theo `rules`, chỉ trên dự án
    của bot, không sửa webhook URL khác, không bật lại webhook bị tắt (báo `disabled`, health
    `degraded`), liệt kê lại sau khi tạo và xoá bản vừa tạo của mình nếu trùng (khởi động đồng
    thời), gửi `ITSAPLAN_WEBHOOK_SECRET` khi tạo nếu API nhận và cảnh báo khi secret lệch.
  - `bot`: `createBot` nhận `dataDir`, `store`, `scheduler`, `webhook.url`, `webhook.autoRegister`;
    biến `BOT_DATA_DIR`, `BOT_TIMEZONE`, `BOT_WEBHOOK_AUTO_REGISTER`, `BOT_WEBHOOK_URL`,
    `ITSAPLAN_WEBHOOK_KEY`; `Bot.store`; `health().components.scheduler|store`.
    Tự đăng ký webhook mặc định TẮT; thiếu quyền thì `start()` ném lỗi rõ ràng.
  - `testing`: `FakeItsaplan` có endpoint webhook (`agentCanManageWebhooks`, `webhookKey`,
    `webhookSecretMode`) và `statusSince` của issue.
  - Docs: how-to "Lịch chạy và hẹn giờ"; cập nhật RFC (trạng thái các mục M2), config-env, bot-kit.
  - Chưa có: runtime lễ tân (2b), `X-Itsaplan-Event-Id` xuống handler, thử lại riêng từng luật.
- **Bot kit, milestone 1** (RFC `docs/rfc/0001-bot-kit.md`). Additive; không đổi API hiện có.
  - `core`: `defineEnv`, `secret`, `mergeEnv`, `loadConfig`, `ConfigError`, `REDACTED`, `createScrubber`,
    `redactUrlCredentials` — env có
    kiểu (zod), kiểm tra một lần, lỗi gom đủ, secret che trong `redacted`/log, `.env` chỉ nạp khi
    truyền `envFile` và không ghi ngược `process.env`.
  - `itsaplan` (`agent-runs`): `AgentRunsClient` (`claim`, `heartbeat`, `report`, `appendEvents`; tham
    số dạng object), `isTransientError`, `findIssueByIdentifier(…, { strict })`,
    `AgentRunWorker`/`createAgentRunWorker` (polling, heartbeat, backoff, concurrency, dừng êm,
    `RunLedger` chống chạy lại khi báo kết quả lỗi), `RunTrace` (trace AG-UI), kiểu giao thức. Giao
    thức: `docs/reference/agent-runs.md`.
  - `backoffice` (subpath mới): handler theo trigger (`mention`, `delegation`, `field`, `schedule`,
    `manual`, `status`, `event`), `RunContext`, tracker khoá theo dự án (`createScopedTracker`),
    `parseMentionPrompt`, luật `event → điều kiện → hành động` (`whenColumn`, `whenResolved`,
    `whenDone`, `whenCommentCreated`, `actions.{comment,moveTo,assign,setPriority}`, `RuleEngine`).
    Export tường minh, không `export *`.
  - `bot` (subpath mới): `defineBot`, `createBot` (`start`/`stop`/`health`/`handleEvent`),
    `runBot`, `startHealthServer` (`/healthz`).
  - `testing` (subpath mới): `FakeItsaplan`, itsaplan giả trên HTTP thật cho test bot.
  - `tracker: { team, project }` bắt buộc: `team` là slug, `project` là `KEY` in hoa; mọi lời gọi
    itsaplan dùng ref đủ `<team>.<KEY>` (`ctx.tracker.ref`), `defineBot` kiểm định dạng; `FakeItsaplan`
    từ chối khoá trần (`allowBareKeys` để bật lại).
  - Độ bền (sau review độc lập): lỗi tạm thời của itsaplan (5xx/429/mạng) trong handler thành
    `retry`, lượt cuối thành `failed` kèm lý do; lệnh ĐỌC của tracker thử lại, lệnh GHI không;
    chỉ 404 nghĩa là "không thuộc dự án"; ranh giới dự án theo `projectId`; `ctx.attempt`,
    `ctx.maxAttempts`, `ctx.prompt`; `ctx.comment` chỉ cho `mention`; `reply` khoá theo số lần gọi;
    tracker của run từ chối ghi sau khi huỷ; worker: vỏ ngoài chặn lỗi bất ngờ (kể cả ledger),
    `stop()` có hạn trên, run bị giao lại được nhận lượt mới, 401/403 chỉ chết sau 3 lần liên
    tiếp; `runBot` thoát mã 1 khi lỗi chết, hạn thoát = `bot.stopBudgetMs`, drain mặc định 5 s
    (đổi từ 30 s); luật chỉ đánh dấu đã thấy sau thành công, bỏ `issue.column_changed`; che secret
    theo giá trị và mật khẩu trong URL; webhook ngoài loopback bắt buộc có secret; biến env rỗng
    không che `.env`; kiểm tuỳ chọn chu kỳ; team có thể là id số.
  - ví dụ `examples/minimal-bot`; `bun test` của core chạy thêm ví dụ này.
  - chưa có (milestone 2): runtime lễ tân, lịch cron do bot giữ, `closeAfter`, ledger bền,
    đăng ký webhook theo `rules`.
- Moved into the `ticket` monorepo (`packages/core`, consumed via `workspace:*`);
  scrubbed internal fixtures (hosts, IPs, phone numbers, chat/user IDs, staff names
  and handles, personal paths) and removed the old standalone-repo docs.
- **Tiểu Linh adoption — behaviour lifted from the app into the library** (the app
  now consumes `@vuihoc/bot-core`; see `docs/adoption/tieulinh-iris.md`). All
  additive, defaults unchanged for other bots:
  - `core`: `isInternalCallbackToken` / `INTERNAL_CALLBACK_TOKENS` (TECH-1148);
    `stripChannelEnvelope` now drops `callback_data: noop|none|ignore|nil` instead of
    keeping it as the user's words.
  - `core`: `makeOpenLazyDb({ onOpenError: "throw" })` for callers that have their
    own fallback; default stays the ADR-0003 `:memory:` degrade.
  - `itsaplan`: `listProjectIssues({ page })`; typed `listComments` (`author`,
    `createdAt`, `id` coerced to number, bad-typed fields become `undefined`);
    `ensureItsaplanWebhook(client, key, url, { events })` so a bot registers only the
    events it handles (default stays `REQUIRED_WEBHOOK_EVENTS`).
  - `itsaplan`: fix `resolveFriendlyStatusName("", …)` returning `""` — falls back to
    "Chờ xử lý" again (intake used `||`).
  - Options so a frozen legacy bot can keep exact old behaviour while the library
    keeps its better defaults (all default to the previous library behaviour):
    `ItsaplanClient` `timeoutMs <= 0` = no timeout and `strictResponses: false`
    (empty 2xx body -> `{}`, non-JSON -> text); `ensureItsaplanWebhook`
    `reactivateDisabled` / `repointSameHost`; `uploadAttachments` `maxBytes`
    (`Infinity` allowed); `formatAttachmentMarkdown` / `spliceAttachmentsIntoDescription`
    `{ escape }`; `stripChannelEnvelope` `keepSoleEnvelopeBlock` /
    `keepTextAfterEnvelopeBlock` / `stripPastedEnvelopeFences`; `stripBotMentions`
    `knownHandles` / `stripBotSuffixHandles`; `setToolFailureOptions({ useDeclaredErrorCode })`.
  - `identity`: `saveUserIdentity` now treats an empty string as "absent" (`||`, as
    intake did) so it no longer overwrites stored values with `""`. Library-wide.
  - tests: `isLoopback`, MCP server error-as-`loi` result, Telegram transport
    error policies / multipart / file download.

## 0.8.0 — 2026-10-19

Hai hạng mục nền tảng (từng ở Out of Scope, nay trừu tượng được phần CHUNG).
Additive — không module nào đang shim bị đụng; shadow-parity 862/27/0, hash
intake-agents không đổi.

- **A2 — Deploy / sync workspace / build binary (`@vuihoc/bot-core/openclaw`).**
  Ba thao tác CHUNG, THUẦN (không chạy lệnh host, không I/O ở lõi — bot thực hiện
  I/O từ kế hoạch lib trả):
  - `planWorkspaceSync(desired, current)` + `summarizeSyncPlan` — tính kế hoạch
    create/update/unchanged idempotent cho bộ file workspace (IDENTITY/SOUL/
    AGENTS/bot.json…); chạy lại khi đã khớp → toàn `unchanged`, không ghi gì.
  - `spliceConfigBlock` / `removeConfigBlock` — chèn/thay/gỡ một khối config giữa
    marker, idempotent, KHÔNG nhân đôi khi deploy nhiều lần (lỗi codex-home splice
    của Sales). `mergeJsonConfig` cho openclaw.json (JSON không có comment).
  - `buildBinaryCommand` dựng argv `bun build --compile`; `checkCompileReadiness`/
    `isCompileReady` kiểm hai luật chống phình nhị phân (readFileSync lookup →
    block; import runtime nặng trong entrypoint MCP → warn). Không chạy build —
    script deploy của bot (host-specific) tự spawn.
- **A3 — Eval harness TS (`@vuihoc/bot-core/eval`).** Thống nhất MỘT ngôn ngữ = TS
  (bỏ nhánh Python của Sales/CM). `runConversation(runner, scenario)` chạy một kịch
  bản nhiều lượt qua `ConversationRunner` do bot tiêm, thu transcript; `scoreRun`/
  `scoreRuns` chấm theo `Check` do bot tiêm (tiêu chí là nội dung bot). Kèm check
  dựng sẵn thuần: `replyContains`, `createdTicketWithPrefix`, `noTicketCreated`,
  `turnHasButton`. Khung chạy–bắt–chấm chung; bộ chấm riêng từng bot.

## 0.7.0 — 2026-10-19

Hai hạng mục nền tảng tiếp theo, additive, opt-in/nullable — OP không đổi hành vi;
shadow-parity giữ 862/27/0, hash intake-agents không đổi.

- **B1 — Outbox opt-in đảm-bảo-gửi (`@vuihoc/bot-core/intake` notify).** Decorator
  `OutboxChannelPort` bọc quanh một `ChannelPort`: gửi THẲNG trước (đường thành công
  không chậm thêm), chỉ khi lỗi mới xếp vào hàng đợi SQLite `notify_outbox`;
  `SqliteOutboxStore.drain(channel)` gửi lại có GIỚI HẠN số lần (`maxAttempts`, mặc
  định 5) + backoff mũ có trần. Hết lượt → `failed` (log), không kẹt vô hạn.
  **Mặc định TẮT** — không bọc thì gửi thẳng như cũ. Dành cho bot cần không mất tin;
  bot realtime (OP) để thẳng cho nhanh. ADR-0003: outbox là cache cục bộ, mất chỉ
  mất một tin thông báo, không mất ticket. `outboxApplySchema` áp qua lazy-db hook.
- **A1 — Vòng đời đổi tài khoản Telegram, nhất quán lưu-theo-user-id
  (`@vuihoc/bot-core/identity`).** `relinkIdentityAndBindings(repo, bindings, input,
  options)` nối `relinkIdentity` (đổi name_code → user id mới, giữ guard chống chiếm
  danh) với `ChannelBindingStore.rebindReporterUserId(old, new)` — chuyển MỌI binding
  ticket đang gắn user id cũ sang id mới, nên `getLatestBindingByUserId` vẫn đúng và
  lịch sử ticket giữ theo NGƯỜI (name_code + id mới), không phụ thuộc tài khoản cũ.
  `bindings` tùy chọn: không truyền thì chỉ relink định danh (`reboundBindings = 0`).
  Không đụng `chat_id` (tin mới tự cập nhật chat).

## 0.6.0 — 2026-10-19

Platform-hardening: bốn bổ sung để `@vuihoc/bot-core` làm NỀN cho mọi bot, rút từ
bài học dựng OP. Tất cả **additive** — bot cũ (OP) không đổi hành vi; shadow-parity
giữ 862/27/0, hash intake-agents không đổi. Trường DB mới nullable, DB cũ được
ALTER bù cột tự động, không cần migration tay.

- **`TelegramNotifyChannel` (`@vuihoc/bot-core/telegram`)** — hiện thực `ChannelPort`
  của notify cho Telegram (`sendComment` / `sendStateChange` + nút "Đã ổn" ADR-0006 /
  `clearInteractiveButtons`). Trước đây mỗi bot tự ghép lớp nối notify ↔ Telegram
  (đúng chỗ OP phải tự chế). Nhãn nút + payload callback do bot tiêm, không literal
  tiếng Việt trong lib. Khác `TelegramChannelSender` (dành cho engine/hội thoại).
- **Lưu người báo theo USER ID** — `ChannelBindingStore` + `ticket_bindings` thêm
  `reporterUserId` (= user id kênh, Telegram `from.id`), khóa định danh bền hơn
  username/tên hiển thị. `getLatestBindingByUserId(userId, prefix?)` tra ticket theo
  người, độc lập chat. `CreateTicketRequest.reporter.userId` truyền xuống binding.
  Cột `reporter_user_id` nullable + index; `intakeApplySchema`/`notifyApplySchema`
  ALTER bù cột cho DB cũ. `normalizeUserId` bóc tiền tố `telegram:`.
- **`inspectBindingDb` + `startIntakeWorker({ dbPath })` (`@vuihoc/bot-core/core`)** —
  chốt chặn lỗi OP 16/10 (worker đọc nhầm `data/op.db` rỗng do path tương đối + CWD
  khác → nuốt mọi comment lặng lẽ). Lúc khởi động, lib resolve path tuyệt đối, đếm
  `ticket_bindings`, cảnh báo khi rỗng/thiếu bảng. Chỉ-đọc, không ném.
- **`auditBootstrapReadiness` / `isBootstrapSafe` (`@vuihoc/bot-core/openclaw`)** —
  guard thuần chống bot OpenClaw mới chạy onboarding với người thật (lộ cơ chế nội
  bộ — sự cố `@vhops_bot` 18/10). Phát hiện `BOOTSTRAP.md` còn, persona rỗng/template,
  AGENTS.md kiểu "home/first run"; `block` vs `warn`. Bot gọi lúc khởi động để từ
  chối phục vụ khi chưa seed.
- **Doc tốc độ realtime** (`docs/WORKER.md` §Nền tảng dùng chung): các knob tốc độ
  (ack-trước-handler, `TelegramTransport.timeoutMs`/`maxRetries`, `confirm.minConfirmDelayMs`)
  đã có và inject được — không hardcode. Không thêm code knob, chỉ chỉ ra cách cấu hình.

## 0.5.2 — 2026-10-17

One additive option, distilled from the OP bot (`operationbot`), which had to put a hand-written
TCP proxy in front of the webhook server because the server was hard-wired to `127.0.0.1` while
Itsaplan runs on another LAN machine.

- **`ItsaplanWebhookServerOptions.listenHost`** (default `"127.0.0.1"` — behaviour unchanged for every
  existing caller). A bot whose Itsaplan is on another host sets `"0.0.0.0"` (or the LAN IP) and the
  server receives webhooks directly; no proxy needed. `startIntakeWorker` forwards it through
  `config.server`. Binding off loopback WARNS when no `itsaplanSecrets` are set (anyone on the
  network could post a forged webhook); the loopback-only `/internal/*` endpoints still check the
  caller's address, so they stay loopback-only whatever the bind address. New `server.host()`
  reports the bound address.
- No other behaviour changed; shadow-parity unchanged.

## 0.5.1 — 2026-10-16

Three hardening fixes distilled from running the OP pilot's reverse channel
(comment → Telegram) end to end. All three are failure modes that stayed SILENT
in production — the webhook returned 200, the chat stayed quiet, and nothing in
the logs said why. Parity holds at 862/27/0; the existing layers' behaviour is
unchanged, only new log lines and one idempotency branch were added.

- **`ensureItsaplanWebhook` is now idempotent against a same-host, wrong-port webhook.**
  Previously, if a stale webhook pointed at the same host but a dead port and prune did not
  run, ensure would CREATE a brand-new webhook every start — leaking a growing pile of
  dead-port hooks. Now ensure detects a same-host hook whose URL only differs by port/path,
  rewrites it to the correct URL and reuses its id (keeping id/secret stable) instead of
  creating another. A hook on a *different* host is still left alone (another machine may
  serve the same project).
- **New `resolveDbPath(dbPath, base?)` in core.** A relative SQLite path (`data/op.db`)
  resolves against the process CWD — and the ticket-creation path and the worker ran under
  *different* CWDs, so each read/wrote a *different* `op.db`: the worker opened an empty DB
  with no bindings and silently dropped every comment. `resolveDbPath` returns an absolute
  path and WARNS on a relative input; `:memory:` and `file:` URIs pass through untouched.
- **The dispatcher no longer swallows a comment with no binding in silence.** `handleComment`
  and `handleStateChange` now log a WARN naming the issue id and pointing at the likely cause
  ("is the worker pointed at the DB that holds ticket_bindings?") before skipping, instead of
  a bare `return` that left no trace. This is what turned the OP reverse-channel diagnosis
  from guesswork into a one-line read.



New subpath `@vuihoc/bot-core/worker`: `startIntakeWorker(config)` assembles the
reverse-notification worker (webhook server + ensure/prune webhook + dispatcher +
reply-router) that every intake bot needs, distilled from standing up the OP pilot
end to end. A bot wires it with one call; see `docs/WORKER.md`.

- **Webhook URL can no longer drift from the listen port.** New `deriveWebhookUrl({host,
  port,...})` builds the registered URL from the port the server actually listens on, and
  `startIntakeWorker` uses it — removing the two-variable mismatch that sent OP's webhook to
  a dead port (`WEBHOOK_URL` said :3102 while the listener was :3104). The `ensureItsaplanWebhook`
  function itself was correct; the fix removes the operator's chance to pass a mismatched URL.
- New `pruneForeignWebhooks(client, projectKey, canonicalUrl)` removes a project's active
  webhooks that point at the same host but a different (dead) port, so a leftover from an
  earlier run cannot double-fire. `startIntakeWorker` prunes before registering (opt-out via
  `pruneStaleWebhooks: false`).
- Pure/injected: `startIntakeWorker` reads no `process.env`, binds the server on port 0 in
  tests, and takes the Itsaplan client, `ChannelPort`, stores and copy as arguments. Parity
  holds at 862/27/0; nothing in the existing layers changed behaviour.

### Verified live on the OP pilot
Project `OP` on Itsaplan (isolated from TECH), agent `op-agent` on
`op-deepseek/deepseek-v4.1-flash` (endpoint probed, 200 Anthropic), bot `@vhops_bot`. A chat
created ticket OP-1 with the correct verbatim description (inspected in the Itsaplan UI); a
staff comment fired the webhook and reached the worker's Telegram send — the only stop was
"chat not found" because the ticket was bound to a CLI session, not a real Telegram chat.
Comment/image two-way still needs a real Telegram message to bind a chat.

## 0.4.2 — 2026-10-16

Pays the 0.1.0 debt (CM's technical-detail leak hardening). `describeToolFailure` can now
hide the raw technical detail from the user-facing message via opt-in
`setToolFailureOptions({ hideDetailFromUser: true })`. **Default is `false`**, so the message
still carries the detail exactly as before (intake behaviour and its asserted strings
unchanged — parity stays 862/27/0). When enabled, the user sees only the error code and the
screenshot instruction; `chi_tiet` and the log line keep the full detail, and the injected
admin alert still receives it. A bot that does not want to show "Itsaplan 503", table names
or stack fragments to end users flips this on at startup.

## 0.4.1 — 2026-10-16

`core/lazy-db` now obeys ADR-0003 (SQLite is an ephemeral local cache; Itsaplan is the
source of truth): opening a corrupt/locked/undersized DB file no longer throws out of the
bot. It logs via the core logger and falls back to an empty in-memory SQLite with the
schema applied, so the bot runs on as "nothing known yet, ask again". New `isDegradedDb(db)`
tells a caller that a connection is the fallback. The path cache is kept, so a corrupt file
is not re-opened on every call. Read paths already return not-found/null for an empty table,
so the ask-again branch is reached with no further change. Parity still 862/27/0.

## 0.4.0 — 2026-10-16

New layer `identity` (gap-analysis A1): the register / approve / reject / relink
lifecycle, merged from intake `lib/storage/identity*` + `mcp/shared/tools/identity.ts`
and CM's hardened relink.
Shadow parity holds at **862/27/0** with 32 modules replaced; intake-agents hash unchanged.

- `IdentityService`: `checkUserApproval` (admin + `requireApproval` + prefix auto-approve +
  rejected handling), `registerIdentity` (name-code validation, anti-spoof when a code is
  bound to another user, auto-approve rules), `approveUser`/`rejectUser`, name-code
  normalize/extract/validateFormat/extractFromText. **Copy-free:** returns structured results
  with reason codes; the caller renders user-facing text. `nameCodePattern` is configurable
  (intake default). No Vietnamese strings in `src/identity`.
- `relinkIdentity`: rebind a name-code to a new `userId` preserving history, carrying CM's
  anti-account-takeover guard — the approver must pass an injected `isAuthorizedApprover`
  predicate (not a free string), never relink onto a protected admin id, and only a numeric
  id may take the primary key.
- `SqliteIdentityRepository` + `IdentityRepository` port, library-owned schema via the core
  lazy-db `applySchema` hook. **Channel-neutral:** the TS field is `userId` (for Telegram
  bots = telegram user id); the SQLite column stays `telegram_user_id`, so intake's schema is
  byte-identical and no bot migration is needed.
- `identityTools` factory (check/register/approve/reject/relink) on the core MCP scaffold,
  with the service and a copy renderer injected. Tiểu Linh's Vietnamese copy lives in
  `examples/tieulinh/identity-copy.ts`.
- Not shimmed (documented in A1): intake's `identity.service.ts` (reached only via its
  binding-fused MCP tool) and `mcp/shared/tools/identity.ts` (fuses binding+draft lookups and
  a telegram-specific input the library tool omits). The load-bearing `identity-repository.ts`
  is shimmed and holds parity.

## 0.3.0 — 2026-10-16

The user-facing half of Tiểu Linh: what Telegram actually shows and how replies flow
back. Mined from intake-agents history (83 of 249 commits touch Telegram, markdown,
media or buttons); every captured rule has a test named after its commit. Audit tables
(commit → rule → source → library location, or why left out) are in tickets 12–14.

**Parity:** shadow copy of Tiểu Linh with **31** modules replaced (26 earlier + Telegram
transport/buttons/alert, `lib/media.ts`, webhook pure helpers) → **862 pass / 27 skip /
0 fail**, identical to the live bot; intake-agents status hash unchanged.

### New layer `telegram` (tickets 12, 13)
- `TelegramTransport`: injected token/base URL/fetch (resolved lazily so test fetch swaps
  work); Telegram rejecting entities ("can't parse entities") → resend once as plain text,
  never lose the message (`40f7062`); 429 `retry_after` with floor + cap (CM); typed errors;
  `tryCall` never throws.
- `sendMessage` with safe inline buttons (invalid/oversized callback data dropped, message
  still sent — reuses `openclaw` pending-buttons); `ackReaction` 👀 (`4595d00`);
  `splitForTelegram` 4096 limit, UTF-16/surrogate safe (CM R7E-B1).
- `Alerter`: admin alerts via injected transport + admin ids, deduped.
- Inbound media finder (intake `9ea827b` ∪ CM) with path-traversal hardening, image type
  sniffing, size cap; adapters for the intake engine (`TelegramChannelSender`,
  `inboundMediaResolver`).
- `render`: tracker → Telegram (Itsaplan highlight HTML `<mark>/<span>/<video>` from
  `5bf501e`, escaping `_ * [ ]` so names like `PO_UserC` don't break Markdown, link/image
  handling, plain fallback) and Telegram → tracker (verbatim text with line breaks
  `7323bc7`, envelope by content `d0d1ed9`, machine button payloads dropped `4aabc54`,
  bot mentions stripped). 300 random names never leave unbalanced entity markers.

### `itsaplan/webhook` + `intake/notify` (ticket 14)
- Webhook front door: 1 MB body cap, HMAC `t=,v1=` over `${t}.${body}` with 5-minute
  tolerance and multiple secrets, Telegram `secret_token`, dedupe by event+issue+comment+ts
  (`a6275e7`), durable SQLite dedupe with conditional upsert (CM), project-lock before any
  side effect (`837fb08`).
- Dispatcher: human comments go to the bound chat, bot comments skipped (`isBotComment`),
  optional mention-only mode (`4cea3c9`), per-project state copy injected.
- Reply router: a reply to a notification becomes a comment on that ticket and never
  reaches the agent (`25c68db`); "OK" is a comment, never a state change; the bot never
  closes (ADR-0006); message routes scoped by chat id (`fd48c6e`).
- No Telegram/OpenClaw import in these modules — all through ports.

### Left in the bots (with reason, see tickets)
- Live `getFile` download (needs token + network), per-bot button catalogs,
  `getLastActiveChatId`, hardcoded pending dir, env-based `alertAdmin` facade.
- Intake's stateful `ItsaplanWebhookServer`, `notification-dispatcher`, `ticket-closure`
  (bound to intake schema, Notifier and KG side effects) — rules carried by the library,
  wiring stays in the bot. CM `outbox-dispatcher` (bound to CM schema).

## 0.2.0 — 2026-10-16

All five layers. Per-function provenance (intake / CM / Bot-Sales) and drift
decisions were recorded in the original standalone repo's tickets.

**Parity:** a shadow copy of Tiểu Linh with 26 modules replaced by this library
runs its own suite at **862 pass / 27 skip / 0 fail**, identical to the live bot
(`docs/parity/REPORT.md`, `bun run scripts/shadow-parity.ts`). The conversation
engine reproduces 13 `pipeline.flow` scenarios (`docs/parity/ENGINE.md`).

### `core` (ticket 03)
- MCP server scaffold: stdio + streamable HTTP that refuses non-loopback bind and
  unauthenticated requests (`createMcpServer`, intake's `createIntakeMcpServer` kept).
- PII redactor, env loader (Bot-Sales + CM), channel-envelope (CM superset of intake),
  generic formatting, lazy SQLite with injected schema, `memoByKey`, test-preload
  credential scrubber.
- **Bot-comment marker:** the written marker stays `<!-- intake-bot -->` by default;
  other bots call `setBotCommentMarker` (CM: `<!-- cm-bot -->`). `isBotComment`
  recognises every marker ever written. Changing the written marker would make live
  workers treat bot comments as human (KG learning, echo loops).

### `itsaplan` (ticket 04)
- One client: CM typed errors (`ItsaplanApiError`, `ItsaplanMalformedResponseError`,
  `isRetryableItsaplanError`), bounded retry on 429/5xx, plus intake metadata and the
  whole Itsaplan upgrade of intake `5bf501e` (teamRef URL, identifier match, digit keys).
- Project/status/attachments (media via injected resolver)/ticket-state/sync-labels/
  ensure-webhook/project-lock. Constructor-only config, no baked URLs.

### `intake` (tickets 05, 08, 09)
- Pure gate (catalog, budgets, one question per turn) and priority floor/ceiling engine,
  plus `resolveRequestedPriority`.
- Write path: ports (tracker, copy catalog, clock, bindings, media), revisioned SQLite
  draft store with atomic claim, per-chat lock, confirmation protocol
  (`minConfirmDelayMs` 5000, `confirmStaleMs` 120000), idempotent `createTicket`
  (verbatim description, marked bot comment), Itsaplan tracker adapter.
- `IntakeEngine.step()`: identifier-conflict park (TECH-928), full-report park, preview +
  button for every write to an existing ticket (ADR-0008), identifiers never overwritten
  (TECH-956), own-ticket edits only, envelope never in tickets (TECH-924), caps, `/new`,
  draft expiry. KG/similar is an optional post-create hook. Tiểu Linh copy/config in
  `examples/tieulinh/`.

### `openclaw` (ticket 07)
- Per-turn identity token (HMAC, expiry, replay store), agent gating, both
  context-injection strategies, Telegram token from `openclaw.json`, typed pending-button
  file contract (directory injected). Plugins vendor a bundle (ADR-0002).

### `prose` (ticket 06)
- `AGENTS.shared.md`, `LAYERS.md`, `skills/confirm-before-create`. Four cross-bot
  conflicts (address form, mirroring, greeting, multi-message) are left as bot overrides.

### Docs
- `docs/adoption/` guides for Tiểu Linh/Iris, CM, Bot-Sales (no bot was modified).
- Known risk recorded for the Bot-Sales owner: raw parent phone numbers in a plugin's
  JSONL log (`docs/adoption/bot-sales.md` §3).

## 0.1.0 — 2026-10-16

First slice: the `core` layer with `logger` and `tool-error`, merged from the
two reference bots. Where intake and CM diverged, the library takes the **union
of fixes**; on a behavioural conflict intake (the reference) wins unless CM is a
strict superset. Provenance per function:

### `core/logger`

| Export | Origin | Notes |
|---|---|---|
| `LogLevel` | both | identical in both sources |
| `IntakeLogger` interface | **intake** | primary API; kept so Tiểu Linh switches with no call-site change |
| `getLogger` / `setLogger` | **intake** | signatures are intake's; `setLogger` accepts any `IntakeLogger` |
| default console shim | **intake** | dependency-free default (keeps `bun build --compile` small) |
| `redactSecrets` | **CM** | added verbatim — Telegram/Bearer/`sk-`/GitHub tokens, kv password pairs, legacy password; recurses objects/arrays |
| `LogEntry` | **CM** | added |
| `Logger` class (level filtering, trace id, JSON emit, auto-redaction) | **CM** | added; now `implements IntakeLogger`, so `setLogger(new Logger(...))` works |

**Conflict resolved:** both sources exported `getLogger`/`setLogger` with
different types. CM's `setLogger(logger: Logger)` was narrowed into intake's
`setLogger(next: IntakeLogger)` (the primary API); the CM `Logger` class
satisfies that interface, so no behaviour is lost.

### `core/tool-error`

| Export | Origin | Notes |
|---|---|---|
| `ToolFailure` | **intake** | shape is intake's; `chi_tiet` doc note carried from CM |
| `newErrorCode` | both | identical |
| `describeToolFailure` | **intake** | intake's signature + its message body (raw `detail` echoed into `thong_bao_cho_nguoi_dung`, which intake's test asserts) |
| `CodedError` | **CM** | added |
| `errorCodeFor` | **CM** | added — a declared `code` like `E_TICKET_RATE_LIMITED` is kept as `ma_loi` |
| `ToolFailureAlert` + `setToolFailureAlert` | **new (replaces intake's import)** | intake imported `alertAdmin` from `./telegram/alert`; the library imports no Telegram. The admin alert is now an **injected hook** the host wires at startup |

**Conflicts resolved:**
- Admin alert: intake hard-imported Telegram; CM dropped the alert entirely. The
  library keeps the alert **behaviour** (intake) but via an injected hook, so
  `core` imports no Telegram — satisfying the "MCP imports pure code only" rule.
- Error code: intake used only random codes; CM added stable declared codes. The
  library keeps **both** via `errorCodeFor` (CM's superset).
- User-facing message: intake echoes the raw detail into
  `thong_bao_cho_nguoi_dung`; CM's later fix removed it to avoid leaking
  technical strings. intake is the reference and its suite asserts the echo, so
  **intake's message body is kept** for 0.1.0. The CM leak-hardening is a
  behaviour change deferred to a later version (noted here so it is not lost).
  **Resolved in 0.4.2** via opt-in `setToolFailureOptions({ hideDetailFromUser: true })`.
