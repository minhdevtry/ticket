# Lịch chạy và hẹn giờ

Trang này hướng dẫn cho bot hậu cần hai việc cần có đồng hồ: chạy theo lịch cron (nhắc việc 8 giờ sáng, tổng hợp cuối ngày) và hẹn giờ cho một ticket cụ thể (Resolved 48 giờ không ai phản hồi thì đóng). Cả hai đều ghi vào kho SQLite của bot nên sống qua restart. Thiết kế và các câu hỏi đã chốt: [RFC 0001](/rfc/0001-bot-kit); nền tảng bot kit: [Bot kit](/explanation/bot-kit).

## Chọn lịch nào

| | Lịch do bot giữ (`backoffice.schedule`) | Lịch tạo trên itsaplan (`backoffice.on.schedule`) |
|---|---|---|
| Ai tạo | code của bot, khai trong `defineBot` | người vận hành tạo trên itsaplan |
| Chạy ở đâu | trong process của bot, bằng kho SQLite | server itsaplan tạo run `schedule`, bot claim như run khác |
| Cần quyền itsaplan | không | quyền quản lý lịch (thường là key của người) |
| Độ phân giải | tick 1 giây | theo phút |

Hai cách dùng song song được. Trang này nói về cách thứ nhất và về hẹn giờ của luật.

## Bước 1: bật kho bền

Đặt `BOT_DATA_DIR` (hoặc tuỳ chọn `dataDir` của `createBot`) trỏ tới một thư mục ghi được, nên là đường dẫn tuyệt đối. Bot mở file `<thư mục>/<bot.id>.sqlite` (WAL, schema có phiên bản). Khi có kho bền:

- kết quả run đã tính xong mà chưa báo được lên itsaplan nằm trong ledger bền, nên sau restart bot báo lại thay vì chạy handler lần nữa;
- khoá chống trùng của comment (`reply#1`, `reply#2`, khoá của luật và của hẹn giờ) và các sự kiện webhook mà luật đã xử lý xong được nhớ qua restart;
- mốc cron và hẹn giờ của luật được lưu.

Không đặt thì mọi thứ nằm trong bộ nhớ như milestone 1 (mặc định của test). Lịch và hẹn giờ vẫn chạy trong lúc bot sống, nhưng mất khi process chết. Không mở được thư mục thì `createBot` ném lỗi nêu đường dẫn, không âm thầm hạ xuống bộ nhớ: nếu bạn đã yêu cầu kho bền thì mất kho là lỗi cấu hình, không phải chuyện nên che.

Mỗi bot một file; hai bot khác `id` dùng chung thư mục được. Hai process cùng `id` và cùng thư mục là cách chạy dự phòng hợp lệ: kho bảo đảm chỉ một bên chạy mỗi mốc và mỗi hẹn giờ (xem "Chạy hai process" dưới đây).

## Bước 2: khai báo lịch cron

```ts check
import { defineBot } from "@vuihoc/bot-core/bot";

export default defineBot({
  id: "nhac-viec",
  tracker: { team: "tech", project: "TECH" },
  backoffice: {
    agent: "nhacviec",
    schedule: {
      // 8 giờ sáng các ngày làm việc (giờ Việt Nam)
      "0 8 * * MON-FRI": async (ctx) => {
        const issues = await ctx.tracker.listIssues({ limit: 100 });
        ctx.logger.info(`${ctx.bot.ref}: ${issues.length} issue lúc ${ctx.timezone}`);
      },
      // 18 giờ mỗi ngày; nếu bot tắt qua giờ thì vẫn chạy bù một lần
      "0 18 * * *": {
        missed: "catch-up-once",
        run: async (ctx) => {
          ctx.logger.info(ctx.missed ? `chạy bù ${ctx.missedCount} mốc` : "đúng giờ");
        },
      },
    },
    scheduleOptions: { timezone: "Asia/Ho_Chi_Minh", missed: "skip" },
  },
});
```

Mỗi khoá là một biểu thức cron 5 trường `phút giờ ngày-trong-tháng tháng thứ`. Bộ phân tích tự viết, không phụ thuộc thư viện:

- mỗi trường nhận `*`, số, khoảng `a-b`, bước (`*/15`, `0-30/10`), danh sách `a,b,c`; tháng và thứ nhận tên tiếng Anh viết tắt (`JAN`, `MON-FRI`); thứ nhận 0–7 (0 và 7 là Chủ nhật); có bí danh `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`;
- ngày-trong-tháng và thứ cùng bị giới hạn thì khớp một trong hai (như cron cổ điển);
- sai cú pháp, múi giờ lạ hoặc lịch không bao giờ chạy (`0 0 30 2 *`) làm `defineBot` ném `BotDefinitionError` nêu rõ trường sai, nên lỗi lộ ngay khi nạp module.

Handler nhận `ScheduleContext`: `tracker` khoá vào dự án của bot (cùng ranh giới với handler run), `logger`, `config`, `signal` (huỷ khi bot đang tắt quá hạn drain), `clock`, `scheduledFor` (mốc lịch đại diện), `missed`/`missedCount`, `timezone` và `idempotencyKey` (`cron:<biểu thức>:<mốc>`) để thao tác ghi chống trùng. Kiểu đầy đủ: [API](/reference/api/). Giá trị handler trả về bị bỏ qua; ném lỗi thì ghi log và mốc đó không chạy lại.

### Múi giờ

Mặc định `Asia/Ho_Chi_Minh`. Thứ tự ưu tiên: `timezone` của riêng một lịch (`{ run, timezone }`), rồi `scheduleOptions.timezone`, rồi biến `BOT_TIMEZONE`, rồi mặc định. Tên múi giờ là tên IANA. Giờ không tồn tại khi chuyển giờ mùa hè bị bỏ qua; múi giờ không có giờ mùa hè như Việt Nam không gặp chuyện này.

```ts run
import { strict as assert } from "node:assert";
import { parseCron } from "@vuihoc/bot-core/backoffice";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const t = Date.parse("2026-10-25T00:00:00Z");

// 8 giờ sáng giờ Việt Nam là 01:00 UTC
assert.equal(iso(parseCron("0 8 * * *").next(t)), "2026-10-25T01:00:00.000Z");
// cùng biểu thức, múi giờ khác
assert.equal(iso(parseCron("0 8 * * *", "UTC").next(t)), "2026-10-25T08:00:00.000Z");
// 2026-10-25 là Chủ nhật: lịch ngày làm việc nhảy sang thứ Hai
assert.equal(iso(parseCron("0 9 * * MON-FRI", "UTC").next(t)), "2026-10-26T09:00:00.000Z");
// biểu thức sai bị từ chối kèm lý do
assert.throws(() => parseCron("0 25 * * *"), /giờ.*25/);
```

### Mốc bị lỡ

Mỗi lịch nhớ mốc đã xử lý gần nhất. Lần đầu bot thấy một lịch, mốc gốc là lúc đó: thêm lịch mới không "bù" quá khứ. Mỗi tick, bot tìm các mốc từ mốc đã xử lý tới giờ. Mốc gần nhất trễ không quá `graceMs` (mặc định 2 phút, đủ cho tick chậm hoặc restart nhanh) là đúng giờ và chạy bình thường; các mốc cũ hơn bị gộp. Nếu trễ hơn, chính sách quyết định:

| Chính sách | Hành vi khi bot tắt qua giờ chạy | Hợp với |
|---|---|---|
| `skip` (mặc định) | bỏ các mốc đã lỡ, ghi log, chạy từ mốc kế tiếp | "đúng giờ hoặc thôi": nhắc 8 giờ sáng mà tới trưa mới bật máy thì không nhắc nữa |
| `catch-up-once` | chạy bù đúng MỘT lần cho mốc gần nhất, dù đã lỡ bao nhiêu mốc; `ctx.missed` là `true`, `ctx.missedCount` là số mốc đã gộp | "ít nhất một lần mỗi chu kỳ": tổng hợp cuối ngày |

Đặt chính sách chung ở `scheduleOptions.missed`, hoặc riêng từng lịch ở `{ run, missed }`.

### Bảo đảm chạy

Bot chiếm mốc trong kho TRƯỚC khi chạy handler, nên mỗi mốc chạy tối đa một lần (at-most-once): handler sập giữa chừng thì mốc đó không tự chạy lại. Hãy viết handler idempotent (dùng `ctx.idempotencyKey` cho thao tác ghi) và nếu mốc nào tuyệt đối không được mất, để handler tự kiểm "việc đã làm chưa" từ itsaplan.

### Chạy hai process

Hai process cùng `id` và cùng `BOT_DATA_DIR` (cùng file kho) dùng được làm dự phòng nóng. Mỗi mốc chỉ một bên chiếm được (cập nhật có điều kiện trong transaction `IMMEDIATE`). Mỗi lịch còn có một lease (hàng trong bảng `leases`, gia hạn khi handler còn chạy): nếu handler chạy lâu hơn chu kỳ thì process kia không chạy chồng mốc kế tiếp mà chờ lease nhả; process giữ lease sập thì lease hết hạn sau 2 phút và bên kia tiếp quản. Hai process phải thấy cùng một file (cùng máy hoặc cùng ổ đĩa chia sẻ có khoá file đúng); đừng đặt file kho trên chia sẻ mạng không bảo đảm khoá.

```ts run
import { strict as assert } from "node:assert";
import type { IntakeLogger } from "@vuihoc/bot-core/core";
import { BotScheduler, BotStore, parseCron } from "@vuihoc/bot-core/backoffice";

const logger: IntakeLogger = { debug() {}, info() {}, warn() {}, error() {} };
const clock = {
  t: Date.parse("2026-10-25T00:30:00Z"),
  now() {
    return this.t;
  },
};
const cron = parseCron("0 8 * * *");
const fired: string[] = [];
const store = BotStore.memory();
const scheduler = new BotScheduler({
  store,
  clock,
  logger,
  entries: [
    {
      id: cron.expression,
      cron,
      missed: "skip",
      run: async (info) => void fired.push(new Date(info.scheduledFor).toISOString()),
    },
  ],
});

await scheduler.tick(); // đăng ký lịch, chưa tới 8 giờ
clock.t = Date.parse("2026-10-25T01:00:05Z");
await scheduler.tick();
await scheduler.idle();
await scheduler.tick(); // cùng mốc: không chạy lại
await scheduler.idle();
assert.deepEqual(fired, ["2026-10-25T01:00:00.000Z"]);
store.close();
```

## Bước 3: hẹn giờ cho luật

Luật phản ứng với webhook ngay lập tức. Khi cần làm gì đó SAU một khoảng thời gian, dùng hành động hẹn giờ trong `.do(...)`:

```ts check
import { defineBot } from "@vuihoc/bot-core/bot";
import { actions, whenColumn, whenResolved } from "@vuihoc/bot-core/backoffice";

const rules = [
  // Resolved 48 giờ mà không mở lại và người báo không trả lời thì chuyển sang Done
  whenResolved()
    .named("tu-dong-dong")
    .do(actions.closeAfter("48h", { comment: "Tự đóng vì không có phản hồi trong 48 giờ." })),

  // Vào "Cần phân loại" 4 giờ mà chưa đổi cột thì nhắc
  whenColumn("Cần phân loại")
    .named("nhac-phan-loai")
    .do(
      actions.after(
        "4h",
        async (ctx) => {
          if (ctx.issueId === null) return;
          await ctx.tracker.comment(ctx.issueId, "Ticket chưa được phân loại sau 4 giờ.", {
            idempotencyKey: ctx.idempotencyKey,
          });
        },
        { cancelOn: ["state-change"] },
      ),
    ),
];

export default defineBot({
  id: "tu-dong-dong",
  tracker: { team: "tech", project: "TECH" },
  backoffice: { agent: "tudongdong", rules },
});
```

Cách hoạt động:

1. Luật chạy như thường. Hành động `after`/`closeAfter` ghi một hẹn vào kho: khoá, hạn, tên luật và vị trí hành động trong luật, id issue, các token huỷ.
2. Bộ chạy hẹn giờ (cùng vòng tick với lịch cron) lấy hẹn đến hạn, chiếm nó bằng cập nhật có điều kiện, rồi chạy hành động. Bot khởi động lại thì hẹn chưa tới hạn vẫn còn, hẹn đã quá hạn lúc tắt chạy ngay khi bot lên.
3. Hành động không được ghi vào kho, chỉ vị trí của nó. Vì vậy đừng đổi tên luật hay chèn/xoá hành động trong luật khi còn hẹn đang chờ: hẹn mồ côi bị huỷ kèm log "không còn trong khai báo".
4. Hành động chạy lỗi thì thử lại với backoff (30 giây, nhân đôi) tối đa 5 lần rồi đánh `failed`; sập giữa chừng thì lease hết hạn và lần sau chạy lại. Tức là at-least-once, nên hành động phải chạy lại được: truyền `ctx.idempotencyKey` (`timer:<khoá>#<lần hẹn>`) cho `tracker.comment`.

### Khoá hẹn và khoá huỷ

Một hẹn được định danh bằng **khoá** (mặc định `<tên luật>#<bước>:<id issue>`, đổi bằng `key`, mẫu có `{issue}`, `{rule}`, `{step}`). Cùng khoá thì chỉ có một hẹn đang chờ: webhook giao lại không đẩy lùi hạn (đặt `replace: true` nếu muốn dời hạn kiểu debounce). Hẹn đã xong hoặc đã huỷ thì hẹn lại tạo lần mới (`gen` tăng).

Có ba cách huỷ:

1. **Token huỷ** (`cancelOn`), do webhook của CÙNG issue kích hoạt:

   | Token | Sự kiện nghe | Huỷ khi |
   |---|---|---|
   | `comment` | `comment.created` | có comment của người (không phải bot hay agent) |
   | `reporter-comment` | `comment.created` | comment đó là của người báo |
   | `state-change` | `issue.state_changed` | issue đổi cột, sang đâu cũng huỷ |
   | `reopened` | `issue.state_changed` | issue vào một cột còn mở (không phải Resolved, Done, huỷ) |
   | `assigned` | `issue.assigned` | issue đổi người được giao |

   Mọi hẹn của issue còn bị huỷ khi issue bị xoá (`issue.deleted`). Engine tự nghe các sự kiện cần thiết kể cả khi không luật nào kích hoạt bằng chúng, và `requiredEvents()` (dùng khi tự đăng ký webhook) đã gồm chúng.
2. **Khoá**: `actions.cancelTimer("khoá")` trong một luật khác, hoặc `ctx.timers.cancel(khoá)`.
3. **Kiểm lại lúc tới hạn** (`guard`): trước khi chạy, hành động có thể tự kiểm lại bằng itsaplan và huỷ hẹn nếu điều kiện không còn. Cần vì bot có thể lỡ webhook lúc tắt.

```ts run
import { strict as assert } from "node:assert";
import { BotStore } from "@vuihoc/bot-core/backoffice";

const store = BotStore.memory();
store.armTimer(
  { key: "dong:7", rule: "tu-dong-dong", step: 0, dueAt: 1000, issueId: 7, cancelOn: ["reporter-comment"] },
  0,
);
// comment của người báo trên issue 7 huỷ hẹn; issue khác thì không
assert.equal(store.cancelByToken(8, "reporter-comment", "người báo trả lời", 10), 0);
assert.equal(store.cancelByToken(7, "reporter-comment", "người báo trả lời", 10), 1);
assert.equal(store.getTimer("dong:7")?.state, "cancelled");
// hẹn lại sau khi huỷ là lần hẹn mới
assert.deepEqual(store.armTimer({ key: "dong:7", rule: "tu-dong-dong", step: 0, dueAt: 2000, issueId: 7 }, 20), {
  outcome: "rearmed",
  gen: 2,
});
store.close();
```

### `closeAfter`

`closeAfter("48h")` là "Resolved thì sau 48 giờ chuyển sang Done, trừ khi được mở lại hoặc người báo trả lời". Mặc định huỷ khi đổi cột (`state-change`) hoặc người báo comment (`reporter-comment`). Lúc tới hạn bot đọc lại itsaplan: issue phải còn ở cột Resolved và không có comment của người báo kể từ lúc hẹn, nếu không hẹn bị huỷ và không đóng. Cột đích mặc định là cột đầu tiên thuộc nhóm Done; đổi bằng `to: "Tên cột"`; `comment` ghi một comment (chống trùng theo lần hẹn) trước khi đóng.

**Ai là người báo?** Itsaplan không trả người báo trên issue, và bot lễ tân (giữ liên kết ticket với chat) ở milestone sau. Mặc định bot đọc trường người tạo của issue (`reporterUserId`, `creatorUserId`, `createdByUserId`) nếu có; không có thì coi MỌI người comment (trừ bot) là người báo, tức là thà không đóng còn hơn đóng nhầm. Có cách xác định chính xác hơn thì khai `backoffice.reporter`:

```ts check
import { defineBot } from "@vuihoc/bot-core/bot";
import { actions, whenResolved } from "@vuihoc/bot-core/backoffice";

export default defineBot({
  id: "dong-sau-48h",
  tracker: { team: "tech", project: "TECH" },
  backoffice: {
    agent: "dongsau",
    rules: [whenResolved().named("dong").do(actions.closeAfter("48h"))],
    // Nhân viên trong danh sách này không bao giờ là "người báo".
    reporter: ({ actorId }) => actorId !== null && !["staff-1", "staff-2"].includes(actorId),
  },
});
```

Giới hạn: comment do một agent khác ghi (kể cả bot lễ tân chuyển lời người báo qua key agent) bị engine bỏ qua như mọi sự kiện do agent gây ra (chống vòng lặp), nên không huỷ hẹn bằng webhook. Lúc tới hạn bot vẫn đọc comment từ itsaplan và loại những comment có dấu của bot.

## Bước 4 (tuỳ chọn): tự đăng ký webhook

Luật chỉ chạy khi itsaplan gọi tới webhook của bot. Thay vì tạo webhook tay, bot có thể tự đăng ký đúng những sự kiện mà `rules` cần (kể cả sự kiện chỉ để huỷ hẹn). Tính năng này **mặc định tắt** và cần một key có quyền webhook, thường không phải key agent:

```bash
BOT_WEBHOOK_PORT=3110
BOT_WEBHOOK_URL=https://bot.example.com/webhook   # URL itsaplan gọi tới được
BOT_WEBHOOK_AUTO_REGISTER=true
ITSAPLAN_WEBHOOK_KEY=...                          # key có quyền webhook
ITSAPLAN_WEBHOOK_SECRET=whsec_...                 # secret của webhook, để kiểm chữ ký
```

Khi `start()`, bot đọc webhook của dự án `tracker` (ref đủ `<team>.<KEY>`):

- chưa có webhook nào cùng URL thì tạo; có nhưng thiếu sự kiện hoặc đang tắt thì bổ sung sự kiện (giữ sự kiện sẵn có) và bật lại;
- không bao giờ xoá webhook, không sửa webhook có URL khác, và không đụng dự án khác: bot chỉ gọi endpoint của dự án mình và loại mọi webhook không thuộc `projectId` của dự án;
- key thiếu quyền (401, 403) thì `start()` ném `WebhookPermissionError` nói rõ phải đặt `ITSAPLAN_WEBHOOK_KEY` hoặc tắt tính năng, và bot ở trạng thái `failed`; itsaplan chập chờn (5xx, mạng) chỉ cảnh báo, lần khởi động sau đăng ký lại;
- cấu hình thiếu (không có `BOT_WEBHOOK_URL`, không có `rules`, `webhook: false`) bị chặn ngay ở `createBot`.

Webhook mới tạo mang secret do itsaplan cấp; lấy nó trên itsaplan và đặt `ITSAPLAN_WEBHOOK_SECRET` để bot kiểm chữ ký (log nhắc việc này khi tạo mới).

## Vận hành

- `bot.health().components.scheduler` cho biết số lịch, số hẹn đang chờ, tick gần nhất và lỗi gần nhất; `components.store.durable` cho biết có kho bền không; `components.webhook.autoRegistered` khi bật tự đăng ký.
- `bot.store?.listTimers({ state: "pending" })` liệt kê hẹn (khoá, hạn, issue, token huỷ); `state: "failed"` cho hẹn đã bỏ cuộc kèm `lastError`.
- Schema kho có phiên bản: bot mở file do bản code **mới hơn** tạo ra sẽ từ chối (`BotStoreVersionError`) thay vì ghi đè. Khi nâng cấp, chạy bản mới trước; đừng chạy lại bản cũ trên file đã nâng.
- Itsaplan vẫn là nguồn sự thật ([ADR-0003](/explanation/adr-index)): xoá file kho chỉ làm mất hẹn đang chờ và mốc cron (lịch mới bắt đầu lại từ lúc đó), không làm hỏng dữ liệu ticket. Không commit file kho (`.gitignore` đã loại `*.sqlite`).
- Tắt êm: `bot.stop()` chờ việc lịch đang dở tới hạn drain như run thường, rồi huỷ `ctx.signal`; hẹn bị huỷ giữa chừng được đặt lại ngay để chạy khi bot lên.

## Test

Dùng đồng hồ giả và gọi `tick()` thay vì chờ thật: `BotScheduler` nhận `clock`, và `BotStore.memory()` thay file. Với `createBot`, truyền `clock`, `dataDir` (thư mục tạm) và `scheduler: { tickMs: 20 }`, rồi tăng giờ của đồng hồ giả. `FakeItsaplan` (`@vuihoc/bot-core/testing`) có thêm endpoint webhook với `agentCanManageWebhooks` và `webhookKey` để thử luồng tự đăng ký và lỗi thiếu quyền. Mô phỏng restart bằng cách `stop()` rồi `createBot` lại với cùng `dataDir`.
