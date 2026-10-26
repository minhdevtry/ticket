import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFixture } from "@vuihoc/bot-core/testing";
import { GOLDEN_DIR, recordGolden } from "./record";
import { SCENARIOS } from "./scenarios";

describe("ghi bản ghi vàng từ pipeline legacy", () => {
  test("ghi hai lần cho cùng từng byte (đồng hồ giả, itsaplan giả, không LLM)", async () => {
    const first = await recordGolden();
    const second = await recordGolden();
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [name, content] of first) expect(second.get(name)).toBe(content);
  });

  test("fixture trong repo đúng bằng bản ghi mới (legacy đóng băng: lệch nghĩa là hành vi legacy đã đổi)", async () => {
    const recorded = await recordGolden();
    const onDisk = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"));
    expect(onDisk.sort()).toEqual([...recorded.keys()].sort());
    for (const [name, content] of recorded) {
      expect(
        readFileSync(join(GOLDEN_DIR, name), "utf8"),
        `${name}: chạy bun run golden:record`,
      ).toBe(content);
    }
  });

  test("mỗi kịch bản ra một fixture hợp lệ, có đủ lượt và ghi nguồn test legacy", async () => {
    const recorded = await recordGolden();
    expect(recorded.size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      const fixture = parseFixture(recorded.get(`${s.scenario}.json`)!);
      expect(fixture.turns).toHaveLength(s.turns.length);
      expect(fixture.source).toContain("pipeline.flow.test.ts");
    }
  });
});
