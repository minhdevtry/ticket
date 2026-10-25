/**
 * Tiểu Linh 2, nửa HẬU CẦN: bot khai báo trên TECH2 (đổi bằng env), agent `tieulinh2`.
 *
 *   @mention ───────────────► answerMention  (chuyển lời về người báo + LLM trả lời, chỉ đọc)
 *   issue.state_changed ────► closure        (báo người báo; Resolved kèm nút "Đã ổn"; KHÔNG tự đóng)
 *   comment.created ────────► relay-comment  (chuyển comment người xử lý về người báo)
 *   comment.created ────────► duplicates     (nhắc mã ticket anh em + LLM phán: gợi ý, hoặc gộp khi bật cờ)
 *   cron (TIEULINH_SLA_CRON) ► slaSweep      (nhắc trực ca khi ticket chưa ai nhận quá hạn)
 *
 * Mọi thứ bền (liên kết người báo, tuyến tin, dấu đã nhắc, nhật ký kênh) nằm trong `BOT_DATA_DIR`.
 * Nửa LỄ TÂN (nhận sự cố qua chat, tạo ticket) chưa có: xem README.
 *
 * Dùng: `const { bot, close } = tieulinhBot(process.env)`; `createBot(bot, { env })`; xong thì `close()`.
 */
import { type BotDefinition, defineBot } from "@vuihoc/bot-core/bot";
import { whenCommentCreated, whenEvent } from "@vuihoc/bot-core/backoffice";
import { loadConfig } from "@vuihoc/bot-core/core";
import { AGENT_USERNAME, type TieulinhConfig, tieulinhEnv } from "./env";
import { detectDuplicate, siblingIdentifiers } from "./duplicates";
import { relayComment } from "./forward";
import { answerMention } from "./mention";
import { reporterResolver } from "./reporter";
import { type ServiceOptions, TieulinhServices } from "./services";
import { slaSweep } from "./sla";

export interface TieulinhBotOptions extends ServiceOptions {
  /** File `.env` bổ sung biến còn thiếu (biến trong `env` thắng). */
  envFile?: string;
}

export interface TieulinhBot {
  /** Khai báo đã kiểm tra; đưa cho `createBot`. */
  bot: Readonly<BotDefinition<typeof tieulinhEnv.shape>>;
  /** Dịch vụ bền (mở lười khi handler đầu tiên chạy). */
  services(): TieulinhServices;
  /** Đóng kho của app. Gọi sau `bot.stop()`. An toàn khi gọi nhiều lần hoặc chưa mở. */
  close(): void;
}

export function tieulinhBot(
  env: Record<string, string | undefined>,
  options: TieulinhBotOptions = {},
): TieulinhBot {
  const config = loadConfig(tieulinhEnv, {
    env,
    envFile: options.envFile,
    context: "tieulinh",
  }).values as TieulinhConfig;

  let svc: TieulinhServices | null = null;
  const services = () => {
    svc ??= new TieulinhServices(config, options);
    return svc;
  };
  const bot = defineBot({
    id: "tieulinh",
    tracker: { team: config.TIEULINH_TEAM, project: config.TIEULINH_PROJECT },
    env: tieulinhEnv,
    backoffice: {
      agent: AGENT_USERNAME,
      on: {
        mention: (ctx) => answerMention(services())(ctx),
      },
      rules: [
        whenEvent<TieulinhConfig>("issue.state_changed")
          .named("closure")
          .do((ctx) => services().closure.onStateChanged(ctx)),
        whenCommentCreated<TieulinhConfig>()
          .named("relay-comment")
          .do((ctx) => relayComment(services())(ctx)),
        whenCommentCreated<TieulinhConfig>(
          (comment, ctx) => siblingIdentifiers(comment.text, ctx.tracker.projectKey).length > 0,
        )
          .named("duplicates")
          .do(detectDuplicate()),
      ],
      schedule: {
        [config.TIEULINH_SLA_CRON]: (ctx) => slaSweep(services())(ctx),
      },
      reporter: (info) => reporterResolver(services())(info),
    },
  });

  return {
    bot,
    services,
    close() {
      svc?.close();
      svc = null;
    },
  };
}
