import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ItsaplanClient,
  ItsaplanIssue,
  ProjectColumn,
} from "../packages/core/src/itsaplan/index";
import {
  checkTl2LocalStatus,
  loadItsaplanCredentials,
  loadTelegramCredentials,
  maskSecret,
  maskUrl,
  parseArgs,
  parseEnvFile,
  printVisualReport,
  runCli,
  runE2EFlow,
  runPreFlightChecks,
  startTl2LocalServices,
  type TelegramDriver,
  validateSafetyGuard,
} from "./test-e2e-live";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

describe("scripts/test-e2e-live", () => {
  describe("parseArgs", () => {
    it("trả về giá trị mặc định chính xác", () => {
      const opts = parseArgs([]);
      expect(opts.project).toBe("TECH2");
      expect(opts.bot).toBe("@test_ticket123_bot");
      expect(opts.dryRun).toBe(false);
      expect(opts.timeoutMs).toBe(60_000);
      expect(opts.skipTl2Check).toBe(false);
      expect(opts.startServices).toBe(false);
      expect(opts.help).toBe(false);
      expect(opts.incidentMessage).toBeUndefined();
    });

    it("phân tích các cờ dòng lệnh dạng cờ và dạng gán giá trị", () => {
      const opts1 = parseArgs([
        "--dry-run",
        "--skip-tl2-check",
        "--start-services",
        "--project",
        "TECH2",
        "--bot",
        "@custom_bot",
        "--incident",
        "Sự cố kiểm thử",
        "--timeout",
        "30000",
      ]);
      expect(opts1.dryRun).toBe(true);
      expect(opts1.skipTl2Check).toBe(true);
      expect(opts1.startServices).toBe(true);
      expect(opts1.project).toBe("TECH2");
      expect(opts1.bot).toBe("@custom_bot");
      expect(opts1.incidentMessage).toBe("Sự cố kiểm thử");
      expect(opts1.timeoutMs).toBe(30_000);

      const opts2 = parseArgs([
        "--project=TECH2",
        "--bot=@custom_bot2",
        "--incident=Sự cố 2",
        "--timeout=45000",
        "--help",
      ]);
      expect(opts2.project).toBe("TECH2");
      expect(opts2.bot).toBe("@custom_bot2");
      expect(opts2.incidentMessage).toBe("Sự cố 2");
      expect(opts2.timeoutMs).toBe(45_000);
      expect(opts2.help).toBe(true);
    });
  });

  describe("validateSafetyGuard", () => {
    it("chấp nhận projectKey là TECH2 hoặc tech2", () => {
      expect(() => validateSafetyGuard("TECH2")).not.toThrow();
      expect(() => validateSafetyGuard("tech2")).not.toThrow();
      expect(() => validateSafetyGuard("  TECH2  ")).not.toThrow();
    });

    it("chặn cứng và ném lỗi khi trỏ vào TECH production", () => {
      expect(() => validateSafetyGuard("TECH")).toThrow(/Production/);
      expect(() => validateSafetyGuard("tech")).toThrow(/Production/);
      expect(() => validateSafetyGuard(" TECH ")).toThrow(/Production/);
    });

    it("chặn cứng và ném lỗi khi trỏ vào bất kỳ dự án nào khác TECH2", () => {
      expect(() => validateSafetyGuard("PROD")).toThrow(/CHỈ ĐƯỢC PHÉP chạy trên dự án "TECH2"/);
      expect(() => validateSafetyGuard("TECH_TEST")).toThrow(
        /CHỈ ĐƯỢC PHÉP chạy trên dự án "TECH2"/,
      );
      expect(() => validateSafetyGuard("")).toThrow(/CHỈ ĐƯỢC PHÉP chạy trên dự án "TECH2"/);
    });
  });

  describe("maskSecret", () => {
    it("trả về (trống) khi giá trị rỗng hoặc không phải chuỗi", () => {
      expect(maskSecret()).toBe("(trống)");
      expect(maskSecret("")).toBe("(trống)");
      expect(maskSecret("   ")).toBe("(trống)");
    });

    it("che toàn bộ bằng *** khi chuỗi quá ngắn (<= 8 ký tự)", () => {
      expect(maskSecret("1234")).toBe("***");
      expect(maskSecret("12345678")).toBe("***");
    });

    it("giữ 4 ký tự đầu và 4 ký tự cuối khi chuỗi dài", () => {
      expect(maskSecret("abcdefgh12345678")).toBe("abcd...5678");
      expect(maskSecret("token_secret_xyz_9999")).toBe("toke...9999");
    });
  });

  describe("maskUrl", () => {
    it("trả về chuỗi rỗng khi url rỗng", () => {
      expect(maskUrl()).toBe("");
      expect(maskUrl("")).toBe("");
    });

    it("che giấu dải IP nội bộ thành <internal-ip>", () => {
      const privateIp1 = ["192", "168", "1", "100"].join(".");
      const privateIp2 = ["172", "16", "1", "50"].join(".");
      expect(maskUrl(`http://${privateIp1}:3100`)).toBe("http://<internal-ip>:3100");
      expect(maskUrl(`http://${privateIp2}:18998/api`)).toBe("http://<internal-ip>:18998/api");
      expect(maskUrl("https://itsaplan.example.com/projects/TECH2")).toBe(
        "https://itsaplan.example.com/projects/TECH2",
      );
    });
  });
  describe("parseEnvFile", () => {
    const tmp = join(tmpdir(), `test-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    it("đọc key-value, bỏ qua dòng comment và dòng trống, xử lý dấu ngoặc kép", () => {
      mkdirSync(tmp, { recursive: true });
      const envPath = join(tmp, ".env");
      writeFileSync(
        envPath,
        `
# Comment dòng đầu
VAR_A=hello
VAR_B="world with spaces"
VAR_C='single quoted'

# Comment giữa
VAR_D=foo=bar=baz
`,
      );

      const parsed = parseEnvFile(envPath);
      expect(parsed.VAR_A).toBe("hello");
      expect(parsed.VAR_B).toBe("world with spaces");
      expect(parsed.VAR_C).toBe("single quoted");
      expect(parsed.VAR_D).toBe("foo=bar=baz");

      rmSync(tmp, { recursive: true, force: true });
    });

    it("trả về object rỗng nếu file không tồn tại", () => {
      expect(parseEnvFile("/path/not/found/none.env")).toEqual({});
    });
  });

  describe("loadTelegramCredentials", () => {
    const tmp = join(tmpdir(), `test-tg-${Date.now()}`);

    it("ưu tiên biến môi trường hơn file cấu hình", () => {
      mkdirSync(tmp, { recursive: true });
      const file1 = join(tmp, "telegram.env");
      writeFileSync(
        file1,
        "TELEGRAM_BOT_TOKEN=file_token\nTELEGRAM_API_ID=1111\nTELEGRAM_API_HASH=file_hash\nTELEGRAM_SESSION_STRING=file_session\n",
      );

      const creds = loadTelegramCredentials(
        {
          TELEGRAM_BOT_TOKEN: "env_token",
          TELEGRAM_API_ID: "9999",
        },
        [file1],
      );

      expect(creds.botToken).toBe("env_token");
      expect(creds.apiId).toBe(9999);
      expect(creds.apiHash).toBe("file_hash");
      expect(creds.sessionString).toBe("file_session");

      rmSync(tmp, { recursive: true, force: true });
    });

    it("nhận diện TELEGRAM_SESSION_STRING_TE_MINHDN3 khi TELEGRAM_SESSION_STRING trống", () => {
      const creds = loadTelegramCredentials(
        {
          TELEGRAM_SESSION_STRING_TE_MINHDN3: "session_te_minhdn3",
        },
        [],
      );
      expect(creds.sessionString).toBe("session_te_minhdn3");
    });
  });

  describe("loadItsaplanCredentials", () => {
    const tmp = join(tmpdir(), `test-itsa-${Date.now()}`);

    it("ưu tiên biến môi trường và đặt giá trị mặc định hợp lệ", () => {
      mkdirSync(tmp, { recursive: true });
      const cfgPath = join(tmp, "tieulinh2.env");
      writeFileSync(
        cfgPath,
        "ITSAPLAN_BASE_URL=http://file-host:18998\nITSAPLAN_API_KEY=file_key\nITSAPLAN_PROJECT_KEY=TECH2\n",
      );

      const creds = loadItsaplanCredentials(
        {
          ITSAPLAN_BASE_URL: "http://env-host:18998",
          ITSAPLAN_API_KEY: "env_key",
        },
        cfgPath,
      );

      expect(creds.baseUrl).toBe("http://env-host:18998");
      expect(creds.apiKey).toBe("env_key");
      expect(creds.projectKey).toBe("TECH2");
      expect(creds.webUrl).toBe("http://env-host:18998");

      rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe("checkTl2LocalStatus và startTl2LocalServices", () => {
    it("checkTl2LocalStatus trả về false nếu script không tồn tại", () => {
      const status = checkTl2LocalStatus("/nonexistent/tl2-local.sh");
      expect(status.receptionistRunning).toBe(false);
      expect(status.backofficeRunning).toBe(false);
      expect(status.output).toContain("Không tìm thấy");
    });

    it("checkTl2LocalStatus phân tích stdout đang chạy và chưa chạy", () => {
      const mockSpawnRunning = () => ({
        exitCode: 0,
        stdout: "receptionist: đang chạy (pid 100, cổng 18796)\nbackoffice: đang chạy (pid 101)\n",
        stderr: "",
      });
      const st1 = checkTl2LocalStatus(join(TEST_DIR, "test-e2e-live.ts"), mockSpawnRunning);
      expect(st1.receptionistRunning).toBe(true);
      expect(st1.backofficeRunning).toBe(true);

      const mockSpawnStopped = () => ({
        exitCode: 0,
        stdout: "receptionist: chưa chạy\nbackoffice: chưa chạy\n",
        stderr: "",
      });
      const st2 = checkTl2LocalStatus(join(TEST_DIR, "test-e2e-live.ts"), mockSpawnStopped);
      expect(st2.receptionistRunning).toBe(false);
      expect(st2.backofficeRunning).toBe(false);
    });

    it("startTl2LocalServices gọi script với tham số start all", () => {
      let calledCmd: string[] = [];
      const mockSpawn = (cmd: string[]) => {
        calledCmd = cmd;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      };
      const ok = startTl2LocalServices(join(TEST_DIR, "test-e2e-live.ts"), mockSpawn);
      expect(ok).toBe(true);
      expect(calledCmd).toContain("start");
      expect(calledCmd).toContain("all");
    });
  });

  describe("runPreFlightChecks", () => {
    it("ném lỗi nếu kết nối Itsaplan thất bại", async () => {
      const mockClient = {
        baseUrl: "http://127.0.0.1:18998",
        testConnection: async () => false,
      } as unknown as ItsaplanClient;

      await expect(
        runPreFlightChecks(parseArgs(["--project", "TECH2", "--skip-tl2-check"]), {
          itsaplanClient: mockClient,
        }),
      ).rejects.toThrow(/Không thể kết nối tới server Itsaplan/);
    });

    it("vượt qua kiểm tra pre-flight khi kết nối và session hợp lệ", async () => {
      const mockClient = {
        baseUrl: "http://127.0.0.1:18998",
        testConnection: async () => true,
      } as unknown as ItsaplanClient;

      const mockDriver: TelegramDriver = {
        verify: async () => ({
          ok: true,
          user: { id: 12345, username: "te_minhdn3", firstName: "Minh" },
        }),
        sendMessage: async () => ({ ok: true, messageId: 1, text: "msg" }),
        readMessages: async () => ({ ok: true, messages: [] }),
        waitForReply: async () => ({ ok: true }),
        clickButton: async () => ({ ok: true }),
      };

      const res = await runPreFlightChecks(parseArgs(["--project", "TECH2", "--skip-tl2-check"]), {
        itsaplanClient: mockClient,
        telegramDriver: mockDriver,
        statusChecker: () => ({
          receptionistRunning: true,
          backofficeRunning: true,
          output: "all running",
        }),
        env: {
          TELEGRAM_BOT_TOKEN: "123456:fake-token",
          TELEGRAM_SESSION_STRING: "fake_session_123456789",
        },
      });

      expect(res.itsaplanConnected).toBe(true);
      expect(res.projectKey).toBe("TECH2");
      expect(res.telegramSessionValid).toBe(true);
      expect(res.botTokenPresent).toBe(true);
    });
  });

  describe("runE2EFlow", () => {
    it("thực hiện thành công toàn bộ 5 bước của kịch bản E2E", async () => {
      const fakeIssue: ItsaplanIssue = {
        id: 7001,
        projectId: 1,
        sequenceNumber: 123,
        identifier: "TECH2-123",
        title: "Học sinh lớp 8B báo lỗi không vào được phòng học",
        description: "Mô tả sự cố chi tiết",
        priority: "high",
        columnId: 10,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const fakeColumns: ProjectColumn[] = [
        { id: 10, name: "Todo", stateType: "unstarted", position: 1 },
        { id: 20, name: "In Progress", stateType: "started", position: 2 },
        { id: 30, name: "Resolved", stateType: "completed", position: 3 },
      ];

      let issueUpdatedColumnId = 0;
      let addedCommentText = "";

      const mockClient = {
        baseUrl: "http://127.0.0.1:18998",
        listProjectIssues: async () => [fakeIssue],
        listProjectColumns: async () => fakeColumns,
        updateIssue: async (_id: number, patch: { columnId?: number }) => {
          if (patch.columnId) issueUpdatedColumnId = patch.columnId;
          return { ...fakeIssue, columnId: patch.columnId ?? fakeIssue.columnId };
        },
        addComment: async (_id: number, content: string) => {
          addedCommentText = content;
          return { id: 1, body: content };
        },
      } as unknown as ItsaplanClient;

      const sentMessages: string[] = [];
      let clickedButton = "";

      const mockDriver: TelegramDriver = {
        verify: async () => ({ ok: true, user: { id: 1001, username: "te_minhdn3" } }),
        sendMessage: async (_target: string, text: string) => {
          sentMessages.push(text);
          return { ok: true, messageId: sentMessages.length * 10, text };
        },
        readMessages: async () => ({ ok: true, messages: [] }),
        waitForReply: async (_target: string, sinceId: number) => {
          if (sinceId === 10) {
            // Bước 2: Bot hỏi bổ sung và kèm nút
            return {
              ok: true,
              message: {
                id: 15,
                out: false,
                text: "Em đã nhận thông tin. Anh có muốn xác nhận tạo ticket?",
                buttons: [[{ text: "Xác nhận tạo sự cố", data: "confirm" }]],
              },
            };
          }
          if (sinceId === 15 || sinceId === 20) {
            // Bước 3: Bot xác nhận đã tạo ticket
            return {
              ok: true,
              message: {
                id: 25,
                out: false,
                text: "Đã tạo sự cố thành công! Mã ticket: TECH2-123.",
              },
            };
          }
          // Bước 5: Bot thông báo webhook
          return {
            ok: true,
            message: {
              id: 35,
              out: false,
              text: "Thông báo cập nhật: Ticket TECH2-123 đã được chuyển sang trạng thái Resolved.",
            },
          };
        },
        clickButton: async (_target: string, _messageId: number, btn: string | number) => {
          clickedButton = String(btn);
          return { ok: true, clicked: String(btn) };
        },
      };

      const result = await runE2EFlow(parseArgs(["--project", "TECH2", "--timeout", "10000"]), {
        itsaplanClient: mockClient,
        telegramDriver: mockDriver,
        webUrl: "http://itsaplan.example.com",
      });

      expect(result.success).toBe(true);
      expect(result.ticket?.identifier).toBe("TECH2-123");
      expect(result.ticketUrl).toBe("http://itsaplan.example.com/projects/TECH2/issues/123");
      expect(clickedButton).toBe("Xác nhận tạo sự cố");
      expect(issueUpdatedColumnId).toBe(30); // Cột Resolved
      expect(addedCommentText).toBe("");
      expect(result.transcript.length).toBeGreaterThanOrEqual(4);
    });

    it("ném lỗi khi bước 1 gửi tin nhắn thất bại", async () => {
      const mockClient = {} as ItsaplanClient;
      const mockDriver: TelegramDriver = {
        verify: async () => ({ ok: true }),
        sendMessage: async () => ({ ok: false, messageId: 0, text: "", error: "Mạng lỗi" }),
        readMessages: async () => ({ ok: true, messages: [] }),
        waitForReply: async () => ({ ok: true }),
        clickButton: async () => ({ ok: true }),
      };

      await expect(
        runE2EFlow(parseArgs(["--project", "TECH2"]), {
          itsaplanClient: mockClient,
          telegramDriver: mockDriver,
        }),
      ).rejects.toThrow(/Bước 1 thất bại/);
    });

    it("ném lỗi khi bước 2 bot không phản hồi", async () => {
      const mockClient = {} as ItsaplanClient;
      const mockDriver: TelegramDriver = {
        verify: async () => ({ ok: true }),
        sendMessage: async () => ({ ok: true, messageId: 10, text: "msg" }),
        readMessages: async () => ({ ok: true, messages: [] }),
        waitForReply: async () => ({ ok: false, error: "Hết thời gian chờ" }),
        clickButton: async () => ({ ok: true }),
      };

      await expect(
        runE2EFlow(parseArgs(["--project", "TECH2"]), {
          itsaplanClient: mockClient,
          telegramDriver: mockDriver,
        }),
      ).rejects.toThrow(/Bước 2 thất bại/);
    });
  });

  describe("printVisualReport", () => {
    it("in biên bản đối thoại và thông điệp hoàn thành mà không ném lỗi", () => {
      expect(() => {
        printVisualReport(
          {
            success: true,
            transcript: [
              {
                step: "1. Báo sự cố",
                sender: "TE_MINHDN3",
                receiver: "@test_ticket123_bot",
                content: "Báo lỗi kỹ thuật",
                timestamp: new Date().toISOString(),
              },
            ],
            ticketUrl: "http://itsaplan.example.com/projects/TECH2/issues/123",
          },
          "TECH2",
        );
      }).not.toThrow();
    });
  });

  describe("runCli", () => {
    it("trả về 0 khi truyền --help", async () => {
      const code = await runCli(["--help"]);
      expect(code).toBe(0);
    });

    it("trả về 1 khi vi phạm chốt chặn an toàn --project TECH", async () => {
      const code = await runCli(["--project", "TECH"]);
      expect(code).toBe(1);
    });

    it("trả về 1 khi thiếu cấu hình Itsaplan", async () => {
      const code = await runCli([], {}, { configFile: "" });
      expect(code).toBe(1);
    });

    it("trả về 0 khi chạy chế độ --dry-run với mock dependencies", async () => {
      const mockClient = {
        baseUrl: "http://127.0.0.1:18998",
        testConnection: async () => true,
      } as unknown as ItsaplanClient;

      const mockDriver: TelegramDriver = {
        verify: async () => ({ ok: true, user: { id: 10, username: "user" } }),
        sendMessage: async () => ({ ok: true, messageId: 1, text: "" }),
        readMessages: async () => ({ ok: true, messages: [] }),
        waitForReply: async () => ({ ok: true }),
        clickButton: async () => ({ ok: true }),
      };

      const code = await runCli(
        ["--dry-run", "--skip-tl2-check"],
        {},
        {
          itsaplanClient: mockClient,
          telegramDriver: mockDriver,
        },
      );

      expect(code).toBe(0);
    });
  });
});
