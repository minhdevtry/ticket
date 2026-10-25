import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifyBinding } from "../ports";
import { LogChannel, readChannelLog } from "./log-channel";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-channel-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const binding: NotifyBinding = {
  issueId: 7,
  identifier: "TECH2-7",
  chatId: "-1000000000001",
  channelType: "log",
};
const clock = {
  t: Date.parse("2026-10-25T01:00:00Z"),
  now() {
    return this.t;
  },
};

describe("LogChannel", () => {
  it("ghi từng lần gửi thành một dòng JSON và trả id tin giả khác nhau", async () => {
    const file = join(dir, "sub", "shadow.jsonl");
    const ch = new LogChannel({ file, clock });
    const a = await ch.sendComment({
      binding,
      authorName: "KTV",
      text: "Đã xem",
      images: ["u.png"],
    });
    clock.t += 1000;
    const b = await ch.sendStateChange({
      binding,
      message: "TECH2-7 đã xử lý",
      state: "resolved",
      withReporterOkButton: true,
    });
    await ch.clearInteractiveButtons(binding, String(b));
    await ch.sendAlert("quá hạn SLA");

    expect(a).not.toBe(b);
    const records = readChannelLog(file);
    expect(records.map((r) => r.kind)).toEqual(["comment", "state", "clear", "alert"]);
    expect(records[0]).toMatchObject({
      channel: "log",
      messageId: a,
      identifier: "TECH2-7",
      chatId: "-1000000000001",
      authorName: "KTV",
      text: "Đã xem",
      images: ["u.png"],
      at: "2026-10-25T01:00:00.000Z",
    });
    expect(records[1]).toMatchObject({ state: "resolved", withReporterOkButton: true });
    expect(records[2]).toMatchObject({ targetMessageId: b });
    expect(records[3]).toMatchObject({ text: "quá hạn SLA" });
  });

  it("file mode 0600, thư mục do kênh tạo mode 0700", async () => {
    const file = join(dir, "state", "shadow.jsonl");
    await new LogChannel({ file }).sendAlert("x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
  });

  it("channelType tuỳ biến; readChannelLog bỏ dòng hỏng và chịu file chưa có", async () => {
    const file = join(dir, "x.jsonl");
    expect(readChannelLog(file)).toEqual([]);
    const ch = new LogChannel({ file, channelType: "shadow" });
    expect(ch.channelType).toBe("shadow");
    await ch.sendAlert("a");
    appendFileSync(file, '{"at":"dở dang');
    writeFileSync(file, `${await Bun.file(file).text()}\n`);
    expect(readChannelLog(file)).toHaveLength(1);
  });
});
