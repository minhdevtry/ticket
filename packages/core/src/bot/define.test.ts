import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineEnv } from "../core/config";
import { actions, whenColumn } from "../backoffice";
import type { FieldCatalog, FieldExtractorPort, FieldSpec, TechReviewPolicy } from "../intake";
import { createCatalog } from "../intake/gate/catalog";
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

  it("id chấp nhận chữ thường, số, gạch ngang và gạch dưới (vd cm_support, bot-v2)", () => {
    const base = {
      tracker: { team: "tech", project: "TECH2" },
      backoffice: { on: { mention: handler } },
    };
    expect(validateBotDefinition({ ...base, id: "cm_support" } as any)).toEqual([]);
    expect(validateBotDefinition({ ...base, id: "bot-v2" } as any)).toEqual([]);
    expect(validateBotDefinition({ ...base, id: "a_b_c" } as any)).toEqual([]);
    expect(validateBotDefinition({ ...base, id: "1bot" } as any).map((i) => i.path)).toEqual([
      "id",
    ]);
    expect(validateBotDefinition({ ...base, id: "Bot" } as any).map((i) => i.path)).toEqual(["id"]);
  });

  it("BotDefinition chấp nhận trường name tuỳ chọn và bảo toàn khi đóng băng", () => {
    const def = defineBot({
      id: "cm_support",
      name: "CM Support Bot",
      tracker: { team: "cm", project: "CM" },
      backoffice: { on: { mention: handler } },
    });
    expect(def.name).toBe("CM Support Bot");
    expect(def.id).toBe("cm_support");
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

  it("backoffice.inbound: chỉ nhận hàm đã biết; một mình nó đủ làm vai hậu cần", () => {
    expect(() =>
      defineBot({
        id: "inb-ok",
        tracker: { team: "tech", project: "TECH" },
        backoffice: { inbound: { telegramUpdate: async () => {} } },
      }),
    ).not.toThrow();
    let issues: Array<{ path: string }> = [];
    try {
      defineBot({
        id: "inb-bad",
        tracker: { team: "tech", project: "TECH" },
        backoffice: { inbound: { reporterOk: "x", reporterRely: () => {} } as any },
      });
    } catch (err) {
      issues = (err as BotDefinitionError).issues as any;
    }
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("backoffice.inbound.reporterOk");
    expect(paths).toContain("backoffice.inbound.reporterRely");
  });

  it("on.schedule dạng bản đồ cron chỉ sang backoffice.schedule", () => {
    const issues = validateBotDefinition({
      id: "sched",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { on: { schedule: { "0 8 * * *": handler } as any } },
    });
    expect(issues[0]?.message).toContain("backoffice.schedule");
  });

  it("backoffice.schedule hợp lệ: chỉ cần lịch là đủ vai hậu cần", () => {
    expect(() =>
      defineBot({
        id: "cron-only",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          schedule: {
            "0 8 * * *": handler,
            "*/5 * * * *": { run: handler, missed: "catch-up-once" },
          },
          scheduleOptions: { timezone: "UTC", missed: "skip", graceMs: 1000 },
        },
      }),
    ).not.toThrow();
  });

  it("backoffice.schedule sai: gom đủ lỗi cron, múi giờ, chính sách, handler, lịch trùng", () => {
    const issues = validateBotDefinition({
      id: "bad-sched",
      tracker: { team: "tech", project: "TECH" },
      backoffice: {
        schedule: {
          "0 25 * * *": handler,
          "* * *": handler,
          "0 8 * * *": "không phải hàm" as any,
          "0 9 * * *": { run: handler, missed: "nope" as any },
          "0 10 * * *": handler,
          "0  10 * * *": handler,
        },
        scheduleOptions: { timezone: "Mars/Olympus", missed: "x" as any, graceMs: -1 },
      },
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('backoffice.schedule["0 25 * * *"]');
    expect(paths).toContain('backoffice.schedule["* * *"]');
    expect(paths).toContain('backoffice.schedule["0 8 * * *"]');
    expect(paths).toContain('backoffice.schedule["0 9 * * *"].missed');
    expect(paths).toContain('backoffice.schedule["0  10 * * *"]');
    expect(paths).toContain("backoffice.scheduleOptions.timezone");
    expect(paths).toContain("backoffice.scheduleOptions.missed");
    expect(paths).toContain("backoffice.scheduleOptions.graceMs");
    expect(issues.find((i) => i.path.endsWith('["0 25 * * *"]'))?.message).toContain("giờ");
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

  it("chỉ lễ tân cũng hợp lệ (pack MCP và skill)", () => {
    expect(() =>
      defineBot({
        id: "recep",
        tracker: { team: "tech", project: "TECH" },
        receptionist: {
          catalog: createCatalog({
            fields: {
              nhanh: {
                default: {
                  truong: { desc: { bat_buoc: true, kieu: "text" } },
                },
              },
            },
          }),
          priorityRules: {
            levels: ["low", "high"],
            floors: [{ when: { urgent: true }, minLevel: "high", reason: "Khẩn" }],
            ceilings: [],
          },
          extractor: {
            extract: async () => ({ userIntent: "report_issue", title: "t", rawText: "" }),
          },
          techReviewPolicy: "checklist",
        },
      }),
    ).not.toThrow();
  });

  it("gom mọi lỗi catalog, luật ưu tiên, chính sách soát vào BotDefinitionError", () => {
    let error: unknown;
    try {
      defineBot({
        id: "recep-bad",
        tracker: { team: "tech", project: "TECH" },
        receptionist: {
          catalog: {
            maxRetries: 2,
            maxQuestionsPerTurn: 1,
            variants: {
              default: {
                key: "default",
                name: "Default",
                fields: {
                  enumField: {
                    name: "enumField",
                    type: "enum:missing_enum",
                    required: false,
                    canAsk: true,
                    askOptional: false,
                    isMultiValue: false,
                    inferFromContext: false,
                  },
                  patternField: {
                    name: "patternField",
                    type: "text",
                    pattern: "(unclosed",
                    required: false,
                    canAsk: true,
                    askOptional: false,
                    isMultiValue: false,
                    inferFromContext: false,
                  },
                  reqIfField: {
                    name: "reqIfField",
                    type: "text",
                    requiredIf: "invalid syntax",
                    required: false,
                    canAsk: true,
                    askOptional: false,
                    isMultiValue: false,
                    inferFromContext: false,
                  },
                },
                oneOf: ["unknown_field"],
                recapFields: ["unknown_recap"],
                budgetGroups: [{ countFields: ["unknown_budget"], exhaustFields: [], max: 1 }],
                status: { complete: "OK", incomplete: "Need info" },
              },
            },
            enums: {},
            autoLabels: {},
            recapBlocklist: [],
            icons: {},
            synonyms: {},
            buttonLabels: {},
            enforceValueRules: false,
          },
          priorityRules: {
            levels: ["low"],
            floors: [{ when: {}, minLevel: "unknown_level", reason: "" }],
            ceilings: [{ when: {}, maxLevel: "unknown_level", reason: "" }],
          },
          techReviewPolicy: "invalid_policy" as unknown as TechReviewPolicy,
          extractor: {} as unknown as FieldExtractorPort,
        },
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(BotDefinitionError);
    const paths = (error as BotDefinitionError).issues.map((i) => i.path);
    expect(paths).toContain("receptionist.catalog.variants.default.fields.enumField.type");
    expect(paths).toContain("receptionist.catalog.variants.default.fields.patternField.pattern");
    expect(paths).toContain("receptionist.catalog.variants.default.fields.reqIfField.requiredIf");
    expect(paths).toContain("receptionist.catalog.variants.default.oneOf");
    expect(paths).toContain("receptionist.catalog.variants.default.recapFields");
    expect(paths).toContain("receptionist.catalog.variants.default.budgetGroups");
    expect(paths).toContain("receptionist.priorityRules.levels");
    expect(paths).toContain("receptionist.techReviewPolicy");
    expect(paths).toContain("receptionist.extractor");
  });

  it("receptionist rỗng không có cấu hình bị chặn", () => {
    const issues = validateBotDefinition({
      id: "recep-empty",
      tracker: { team: "tech", project: "TECH" },
      receptionist: {},
    });
    expect(issues.map((i) => i.path)).toContain("receptionist");
  });
});
