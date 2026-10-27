/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "tl2-local.sh");

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "tl2-local-test-"));
});

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function run(args: string[] = [], env: Record<string, string> = {}) {
  const dummyEnvFile = join(testDir, "test.env");
  if (!env.TL2_ENV_FILE) {
    writeFileSync(dummyEnvFile, "ITSAPLAN_PROJECT_KEY=TECH2\nITSAPLAN_TEAM=tech\n");
  }

  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: {
      ...process.env,
      TL2_LOCAL_DIR: testDir,
      TL2_ENV_FILE: env.TL2_ENV_FILE ?? dummyEnvFile,
      ...env,
    },
  });

  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("deploy/dev/tl2-local.sh", () => {
  it("cú pháp script bash hợp lệ (bash -n)", () => {
    const proc = Bun.spawnSync(["bash", "-n", SCRIPT]);
    expect(proc.exitCode).toBe(0);
  });

  it("hiển thị hướng dẫn sử dụng với --help và thoát mã 0", () => {
    const res = run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Khởi động, giám sát và dừng trọn gói Tiểu Linh 2");
    expect(res.stdout).toContain("deploy/dev/tl2-local.sh");
    expect(res.stdout).toContain("--dry-run");
    expect(res.stdout).toContain("ITSAPLAN_PROJECT_KEY");
  });

  it("status khi chưa có tiến trình chạy trả về mã 0 và thông báo 'chưa chạy'", () => {
    const res = run(["status"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("receptionist: chưa chạy");
    expect(res.stdout).toContain("backoffice: chưa chạy");
  });

  it("status theo từng dịch vụ khi chưa chạy trả về thông tin tương ứng", () => {
    const recRes = run(["status", "receptionist"]);
    expect(recRes.code).toBe(0);
    expect(recRes.stdout).toContain("receptionist: chưa chạy");
    expect(recRes.stdout).not.toContain("backoffice:");

    const backRes = run(["status", "backoffice"]);
    expect(backRes.code).toBe(0);
    expect(backRes.stdout).toContain("backoffice: chưa chạy");
    expect(backRes.stdout).not.toContain("receptionist:");
  });

  it("stop khi chưa có tiến trình chạy trả về mã 0 và thông báo 'không chạy'", () => {
    const res = run(["stop"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("backoffice: không chạy");
    expect(res.stdout).toContain("receptionist: không chạy");
  });

  it("stop theo từng dịch vụ khi chưa chạy", () => {
    const recRes = run(["stop", "receptionist"]);
    expect(recRes.code).toBe(0);
    expect(recRes.stdout).toContain("receptionist: không chạy");

    const backRes = run(["stop", "backoffice"]);
    expect(backRes.code).toBe(0);
    expect(backRes.stdout).toContain("backoffice: không chạy");
  });

  describe("Chốt chặn an toàn (Safety Guard)", () => {
    it("từ chối khi ITSAPLAN_PROJECT_KEY=TECH qua biến môi trường", () => {
      const res = run(["start"], { ITSAPLAN_PROJECT_KEY: "TECH" });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("[CẢNH BÁO AN TOÀN]");
      expect(res.stderr).toContain("production");
    });

    it("từ chối khi chạy lệnh mặc định với ITSAPLAN_PROJECT_KEY=TECH", () => {
      const res = run([], { ITSAPLAN_PROJECT_KEY: "TECH" });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("[CẢNH BÁO AN TOÀN]");
    });

    it("từ chối khi TIEULINH_PROJECT=TECH", () => {
      const res = run(["start"], { TIEULINH_PROJECT: "TECH" });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("[CẢNH BÁO AN TOÀN]");
    });

    it("từ chối khi file cấu hình đặt ITSAPLAN_PROJECT_KEY=TECH", () => {
      const badEnvFile = join(testDir, "bad.env");
      writeFileSync(badEnvFile, "ITSAPLAN_PROJECT_KEY=TECH\n");
      const res = run(["start"], {
        TL2_ENV_FILE: badEnvFile,
        ITSAPLAN_PROJECT_KEY: "",
      });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("[CẢNH BÁO AN TOÀN]");
    });

    it("từ chối khi ITSAPLAN_PROJECT_KEY khác TECH2", () => {
      const res = run(["start"], { ITSAPLAN_PROJECT_KEY: "OTHER_PROJECT" });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("ITSAPLAN_PROJECT_KEY bắt buộc phải là 'TECH2'");
    });
  });

  describe("Chế độ --dry-run", () => {
    it("start --dry-run in đầy đủ kế hoạch khởi động và thoát mã 0", () => {
      const res = run(["start", "--dry-run"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("[dry-run] Kiểm tra cấu hình: ITSAPLAN_PROJECT_KEY=TECH2");
      expect(res.stdout).toContain("[dry-run] Sẽ khởi động lễ tân (OpenClaw)");
      expect(res.stdout).toContain("[dry-run] Sẽ khởi động hậu cần (apps/tieulinh)");
    });

    it("start receptionist --dry-run chỉ in lễ tân", () => {
      const res = run(["start", "receptionist", "--dry-run"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("[dry-run] Sẽ khởi động lễ tân (OpenClaw)");
      expect(res.stdout).not.toContain("hậu cần");
    });

    it("start backoffice --dry-run chỉ in hậu cần", () => {
      const res = run(["start", "backoffice", "--dry-run"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("[dry-run] Sẽ khởi động hậu cần (apps/tieulinh)");
      expect(res.stdout).not.toContain("lễ tân");
    });

    it("stop --dry-run in các bước dừng và thoát mã 0", () => {
      const res = run(["stop", "--dry-run"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("[dry-run] Sẽ dừng dịch vụ backoffice");
      expect(res.stdout).toContain("[dry-run] Sẽ dừng dịch vụ receptionist");
    });
  });

  describe("Xử lý lỗi tham số", () => {
    it("báo lỗi tham số lạ và thoát mã 2", () => {
      const res = run(["--unknown-flag"]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("Tham số không hợp lệ: --unknown-flag");
    });
  });

  describe("Xem nhật ký (logs)", () => {
    it("logs hiển thị thông báo khi chưa có log", () => {
      const res = run(["logs"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("chưa có log");
    });

    it("logs theo dịch vụ hiển thị thông báo chưa có log", () => {
      const recRes = run(["logs", "receptionist"]);
      expect(recRes.code).toBe(0);
      expect(recRes.stdout).toContain("receptionist: chưa có log");

      const backRes = run(["logs", "backoffice"]);
      expect(backRes.code).toBe(0);
      expect(backRes.stdout).toContain("backoffice: chưa có log");
    });
  });

  describe("Nạp cấu hình môi trường và bóc tách ngoặc kép", () => {
    it("cfg_get bóc tách dấu ngoặc kép và nháy đơn thừa", () => {
      const customEnv = join(testDir, "quoted.env");
      writeFileSync(
        customEnv,
        'ITSAPLAN_PROJECT_KEY="TECH2"\nITSAPLAN_TEAM=\'tech\'\nTIEULINH_ONCALL_CHAT_ID=" -100999888 "\n',
      );
      const res = run(["status"], { TL2_ENV_FILE: customEnv });
      expect(res.code).toBe(0);
    });
  });
});
