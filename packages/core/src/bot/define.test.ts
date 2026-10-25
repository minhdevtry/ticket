import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineEnv } from "../core/config";
import { actions, whenColumn } from "../backoffice";
import { BotDefinitionError, defineBot, validateBotDefinition } from "./define";

const handler = async () => "ok";

describe("defineBot", () => {
  it("nhận khai báo hợp lệ, đóng băng, và suy ra kiểu config từ env", () => {
    const env = defineEnv({
      GREETING: z.string().default("chào"),
      LIMIT: z.coerce.number().default(3),
    });
    const def = defineBot({
      id: "demo-bot",
      tracker: { team: "tech", project: "TECH2" },
      env,
      backoffice: {
        agent: "demo",
        on: {
          mention: async (ctx) => {
            // kiểu: ctx.config.LIMIT là number, GREETING là string
            const n: number = ctx.config.LIMIT;
            const g: string = ctx.config.GREETING;
            return `${g}${n}`;
          },
        },
        rules: [whenColumn("Cần phân loại").do(actions.setPriority("high"))],
      },
    });
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.id).toBe("demo-bot");
  });

  it("gom mọi lỗi vào một BotDefinitionError", () => {
    let error: unknown;
    try {
      defineBot({
        id: "Sai ID",
        tracker: { team: "Sai Team", project: "1x" },
        backoffice: { on: { mentionn: handler, delegation: "không phải hàm" } as any },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BotDefinitionError);
    const paths = (error as BotDefinitionError).issues.map((i) => i.path);
    expect(paths).toContain("id");
    expect(paths).toContain("tracker.team");
    expect(paths).toContain("tracker.project");
    expect(paths).toContain("backoffice.on.mentionn");
    expect(paths).toContain("backoffice.on.delegation");
    expect((error as Error).message).toContain("(5 lỗi)");
  });

  it("tracker bắt buộc team (slug) và mã dự án IN HOA", () => {
    const base = { id: "tk", backoffice: { on: { mention: handler } } };
    const paths = (tracker: unknown) =>
      validateBotDefinition({ ...base, tracker } as any).map((i) => i.path);
    expect(paths({ project: "TECH2" })).toEqual(["tracker.team"]); // thiếu team
    expect(paths({ team: "tech" })).toEqual(["tracker.project"]);
    expect(paths({ team: "Tech", project: "TECH2" })).toEqual(["tracker.team"]); // hoa
    expect(paths({ team: "t", project: "TECH2" })).toEqual(["tracker.team"]); // quá ngắn
    expect(paths({ team: "tech-", project: "TECH2" })).toEqual(["tracker.team"]);
    expect(paths({ team: "tech", project: "tech2" })).toEqual(["tracker.project"]); // thường
    expect(paths({ team: "tech", project: "TECH_2" })).toEqual(["tracker.project"]);
    expect(paths({ team: "tech", project: "2TECH" })).toEqual(["tracker.project"]);
    expect(paths({ team: "cm-support", project: "CM2" })).toEqual([]);
    // team chưa có slug: itsaplan dùng id số trong ref `<id>.<KEY>`
    expect(paths({ team: "12", project: "TECH2" })).toEqual([]);
    expect(paths({ team: "12a", project: "TECH2" })).toEqual(["tracker.team"]);
  });

  it("kiểm các tuỳ chọn chu kỳ: heartbeat phải nhỏ hơn nửa lease, số không âm/không nguyên", () => {
    const paths = (runs: unknown) =>
      validateBotDefinition({
        id: "iv",
        tracker: { team: "tech", project: "TECH" },
        backoffice: { on: { mention: handler }, runs: runs as any },
      }).map((i) => i.path);
    expect(paths({ heartbeatIntervalMs: 60_000, pollIntervalMs: 0, runTimeoutMs: 1000 })).toEqual(
      [],
    );
    expect(paths({ heartbeatIntervalMs: 200_000 })).toEqual([
      "backoffice.runs.heartbeatIntervalMs",
    ]);
    expect(paths({ heartbeatIntervalMs: 0 })).toEqual(["backoffice.runs.heartbeatIntervalMs"]);
    expect(paths({ pollIntervalMs: -1 })).toEqual(["backoffice.runs.pollIntervalMs"]);
    expect(paths({ runTimeoutMs: 0 })).toEqual(["backoffice.runs.runTimeoutMs"]);
    expect(paths({ concurrency: 1.5 })).toEqual(["backoffice.runs.concurrency"]);
    expect(paths({ maxAttempts: 0 })).toEqual(["backoffice.runs.maxAttempts"]);
    expect(paths({ heartbeatIntervalMs: Number.NaN })).toEqual([
      "backoffice.runs.heartbeatIntervalMs",
    ]);
  });

  it("cần ít nhất một vai và ít nhất một handler/luật", () => {
    expect(() => defineBot({ id: "no-role", tracker: { team: "tech", project: "TECH" } })).toThrow(
      /ít nhất một vai/,
    );
    expect(() =>
      defineBot({ id: "empty-back", tracker: { team: "tech", project: "TECH" }, backoffice: {} }),
    ).toThrow(/ít nhất một handler/);
  });

  it("schedule dạng bản đồ cron báo là milestone 2", () => {
    const issues = validateBotDefinition({
      id: "sched",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { on: { schedule: { "0 8 * * *": handler } as any } },
    });
    expect(issues[0]?.message).toContain("milestone 2");
  });

  it("chặn tên luật trùng và luật không hợp lệ", () => {
    const rule = whenColumn("A").do(actions.setPriority("low"));
    const issues = validateBotDefinition({
      id: "dup",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { rules: [rule, rule, {} as any] },
    });
    expect(issues.map((i) => i.path)).toEqual(["backoffice.rules[1]", "backoffice.rules[2]"]);
  });

  it("chỉ lễ tân cũng hợp lệ (chạy ở milestone 2)", () => {
    expect(() =>
      defineBot({
        id: "recep",
        tracker: { team: "tech", project: "TECH" },
        receptionist: { channels: [{ kind: "telegram" }] },
      }),
    ).not.toThrow();
  });
});
