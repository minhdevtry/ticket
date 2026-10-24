import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHarness, loadEnvFile } from "./harness";

/**
 * Bản thân harness thì chạy được dưới `bun test` — chỉ sáu script dùng nó là
 * không, vì chúng gọi hạ tầng thật.
 */

describe("createHarness", () => {
  test("đếm đúng số lượt đạt và trượt", () => {
    const h = createHarness();
    h.assert("một", true);
    h.assert("hai", false);
    h.assert("ba", true);

    expect(h.passed).toBe(2);
    expect(h.failed).toBe(1);
  });

  test("bắt đầu từ 0, và hai harness đếm độc lập nhau", () => {
    const a = createHarness();
    const b = createHarness();
    a.assert("chỉ của a", false);

    expect(a.failed).toBe(1);
    expect(b.failed).toBe(0);
    expect(b.passed).toBe(0);
  });
});

describe("loadEnvFile", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-env-"));
    file = path.join(dir, "test.env");
    delete process.env.HARNESS_FIXTURE_A;
    delete process.env.HARNESS_FIXTURE_B;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HARNESS_FIXTURE_A;
    delete process.env.HARNESS_FIXTURE_B;
  });

  test("đọc KEY=value, bỏ dòng trống và dòng chú thích", () => {
    fs.writeFileSync(file, "# chú thích\n\nHARNESS_FIXTURE_A=alpha\nHARNESS_FIXTURE_B=beta\n");

    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.HARNESS_FIXTURE_A).toBe("alpha");
    expect(process.env.HARNESS_FIXTURE_B).toBe("beta");
  });

  test("giá trị chứa dấu = vẫn nguyên vẹn, chỉ tách ở dấu = đầu tiên", () => {
    fs.writeFileSync(file, "HARNESS_FIXTURE_A=a=b=c\n");
    loadEnvFile(file);

    expect(process.env.HARNESS_FIXTURE_A).toBe("a=b=c");
  });

  test("mặc định không ghi đè biến đã có sẵn", () => {
    process.env.HARNESS_FIXTURE_A = "có trước";
    fs.writeFileSync(file, "HARNESS_FIXTURE_A=từ file\n");
    loadEnvFile(file);

    expect(process.env.HARNESS_FIXTURE_A).toBe("có trước");
  });

  test("override: true thì ghi đè — đây là điểm ba bản chép tay từng lệch nhau", () => {
    process.env.HARNESS_FIXTURE_A = "có trước";
    fs.writeFileSync(file, "HARNESS_FIXTURE_A=từ file\n");
    loadEnvFile(file, { override: true });

    expect(process.env.HARNESS_FIXTURE_A).toBe("từ file");
  });

  test("file không tồn tại thì trả false, để nơi gọi lùi về nguồn dự phòng", () => {
    expect(loadEnvFile(path.join(dir, "không-có.env"))).toBe(false);
  });
});
