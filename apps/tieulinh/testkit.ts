/**
 * Dàn test dùng chung: itsaplan giả (dự án TECH2), LLM giả, thư mục dữ liệu tạm, đồng hồ giả và một
 * hàm dựng bot. Chỉ dùng trong test; toàn bộ dữ liệu là giả (chat `-1000000000001`...).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ScopedTracker, createScopedTracker } from "@vuihoc/bot-core/backoffice";
import { type Bot, createBot } from "@vuihoc/bot-core/bot";
import { FakeItsaplan, FakeLlm } from "@vuihoc/bot-core/testing";
import { ItsaplanClient, type ItsaplanWebhookEnvelope } from "@vuihoc/bot-core/itsaplan";
import { readChannelLog } from "@vuihoc/bot-core/intake";
import { type TieulinhBot, type TieulinhBotOptions, tieulinhBot } from "./bot";
import { CHANNEL_LOG_FILE } from "./services";

export const CHAT = "-1000000000001";
export const HOUR = 3_600_000;
export const T0 = Date.parse("2026-10-25T00:00:30Z");

export class FakeClock {
  constructor(public t: number = T0) {}
  now() {
    return this.t;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: quá hạn");
    await sleep(5);
  }
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

export interface Harness {
  fake: FakeItsaplan;
  llm: FakeLlm;
  dir: string;
  clock: FakeClock;
  /** Dựng app + bot (chưa start). `env` ghi đè/ bổ sung; `llm: false` bỏ cấu hình LLM. */
  boot(opts?: { env?: Record<string, string>; llm?: boolean; appOptions?: TieulinhBotOptions }): {
    app: TieulinhBot;
    bot: Bot;
  };
  /** Tracker khoá TECH2 dựng như lúc chạy (cho `recordReporterOk`, kênh vào sau này). */
  tracker(): ScopedTracker;
  /** Các dòng nhật ký của kênh `log`. */
  channelLog(): ReturnType<typeof readChannelLog>;
  stop(): Promise<void>;
}

export function harness(): Harness {
  const fake = new FakeItsaplan({ projectKey: "TECH2", agentUsername: "tieulinh2" });
  fake.start();
  const llm = new FakeLlm();
  llm.start();
  const dir = mkdtempSync(join(tmpdir(), "tieulinh-"));
  const clock = new FakeClock();
  const bots: Bot[] = [];
  const apps: TieulinhBot[] = [];

  return {
    fake,
    llm,
    dir,
    clock,
    boot(opts = {}) {
      const env: Record<string, string> = {
        ITSAPLAN_BASE_URL: fake.baseUrl,
        ITSAPLAN_AGENT_KEY: fake.agentKey,
        BOT_POLL_INTERVAL_MS: "0",
        BOT_DATA_DIR: dir,
        ...(opts.llm === false
          ? {}
          : {
              LLM_BASE_URL: llm.baseUrl("anthropic-messages"),
              LLM_API_KEY: "proxy-injects-the-real-key",
              LLM_MODEL: "MiniMax-M3.1-Flash",
              LLM_MAX_RETRIES: "0",
            }),
        ...opts.env,
      };
      const app = tieulinhBot(env, { clock, ...opts.appOptions });
      apps.push(app);
      const bot = createBot(app.bot, {
        env,
        clock,
        logger: silent,
        worker: {
          minPollIntervalMs: 0,
          drainTimeoutMs: 500,
          errorBackoff: { baseMs: 5, maxMs: 10 },
        },
        scheduler: { tickMs: 20 },
      });
      bots.push(bot);
      return { app, bot };
    },
    tracker: () =>
      createScopedTracker(
        new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
        { team: "tech", project: "TECH2" },
        { clock },
      ),
    channelLog: () => readChannelLog(join(dir, CHANNEL_LOG_FILE)),
    async stop() {
      await Promise.all(bots.splice(0).map((b) => b.stop()));
      for (const a of apps.splice(0)) a.close();
      await fake.stop();
      await llm.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let ts = 1;
export const commentCreated = (
  issue: { id: number },
  body: string,
  extra: { id?: number; actor?: ItsaplanWebhookEnvelope["actor"] } = {},
): ItsaplanWebhookEnvelope => ({
  action: "create",
  type: "Comment",
  event: "comment.created",
  data: { id: extra.id ?? 5000 + ts, issueId: issue.id, body },
  actor: extra.actor ?? { type: "human", id: "staff-1", name: "Chị Lan" },
  createdAt: new Date().toISOString(),
  webhookTimestamp: ts++,
});

export const stateChanged = (
  issue: { id: number; identifier: string },
  column: { id: number; name: string; type: string },
): ItsaplanWebhookEnvelope => ({
  action: "update",
  type: "Issue",
  event: "issue.state_changed",
  data: {
    id: issue.id,
    identifier: issue.identifier,
    projectId: 1,
    columnId: column.id,
    state: { name: column.name, type: column.type },
  },
  actor: { type: "human", id: "staff-1", name: "Chị Lan" },
  createdAt: new Date().toISOString(),
  webhookTimestamp: ts++,
});

export const RESOLVED = { id: 4, name: "Resolved", type: "completed" };
export const DONE = { id: 5, name: "Done", type: "completed" };
export const INPROGRESS = { id: 3, name: "Đang xử lý", type: "started" };
