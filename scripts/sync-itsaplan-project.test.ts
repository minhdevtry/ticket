import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { ItsaplanClient } from "../packages/core/src/itsaplan/index";
import { parseArgs, runCli, syncItsaplanProject } from "./sync-itsaplan-project";

interface MockColumn {
  id: number;
  name: string;
  stateType: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  position: number;
  color?: string;
}

interface MockLabel {
  id: number;
  name: string;
  color?: string;
}

interface MockProject {
  id: number;
  key: string;
  name: string;
  columns: MockColumn[];
  labels: MockLabel[];
}

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

let server: Server;
let baseUrl: string;
let nextId = 100;
let projects = new Map<string, MockProject>();
const recordedRequests: RecordedRequest[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      let body: unknown;
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        const text = await req.text();
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
      }

      recordedRequests.push({ method, path, body });

      // GET /projects/:key
      const getProjMatch = path.match(/^\/projects\/([^/]+)$/);
      if (method === "GET" && getProjMatch) {
        const key = decodeURIComponent(getProjMatch[1] ?? "");
        const proj = projects.get(key);
        if (!proj) {
          return new Response(JSON.stringify({ error: `Project ${key} not found` }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return Response.json(proj);
      }

      // POST /projects
      if (method === "POST" && path === "/projects") {
        const payload = body as { key: string; name: string };
        const newProj: MockProject = {
          id: nextId++,
          key: payload.key,
          name: payload.name,
          columns: [],
          labels: [],
        };
        projects.set(payload.key, newProj);
        return Response.json(newProj);
      }

      // POST /projects/:key/columns
      const createColMatch = path.match(/^\/projects\/([^/]+)\/columns$/);
      if (method === "POST" && createColMatch) {
        const key = decodeURIComponent(createColMatch[1] ?? "");
        const proj = projects.get(key);
        if (!proj) return new Response("Not found", { status: 404 });
        const payload = body as {
          name: string;
          stateType: MockColumn["stateType"];
          color?: string;
          position?: number;
        };
        const newCol: MockColumn = {
          id: nextId++,
          name: payload.name,
          stateType: payload.stateType,
          color: payload.color,
          position: payload.position ?? proj.columns.length,
        };
        proj.columns.push(newCol);
        return Response.json(newCol);
      }

      // PATCH /projects/:key/columns/:id
      const patchColMatch = path.match(/^\/projects\/([^/]+)\/columns\/(\d+)$/);
      if (method === "PATCH" && patchColMatch) {
        const key = decodeURIComponent(patchColMatch[1] ?? "");
        const colId = Number(patchColMatch[2]);
        const proj = projects.get(key);
        if (!proj) return new Response("Not found", { status: 404 });
        const col = proj.columns.find((c) => c.id === colId);
        if (!col) return new Response("Column not found", { status: 404 });
        const payload = body as { stateType?: MockColumn["stateType"]; color?: string };
        if (payload.stateType) col.stateType = payload.stateType;
        if (payload.color !== undefined) col.color = payload.color;
        return Response.json(col);
      }

      // POST /projects/:key/columns/reorder
      const reorderMatch = path.match(/^\/projects\/([^/]+)\/columns\/reorder$/);
      if (method === "POST" && reorderMatch) {
        const key = decodeURIComponent(reorderMatch[1] ?? "");
        const proj = projects.get(key);
        if (!proj) return new Response("Not found", { status: 404 });
        const payload = body as { orderedIds: number[] };
        const idMap = new Map(proj.columns.map((c) => [c.id, c]));
        const reordered: MockColumn[] = [];
        for (const id of payload.orderedIds) {
          const c = idMap.get(id);
          if (c) reordered.push(c);
        }
        proj.columns = reordered;
        return Response.json(proj.columns);
      }

      // POST /projects/:key/labels
      const createLabelMatch = path.match(/^\/projects\/([^/]+)\/labels$/);
      if (method === "POST" && createLabelMatch) {
        const key = decodeURIComponent(createLabelMatch[1] ?? "");
        const proj = projects.get(key);
        if (!proj) return new Response("Not found", { status: 404 });
        const payload = body as { name: string; color?: string };
        const newLabel: MockLabel = {
          id: nextId++,
          name: payload.name,
          color: payload.color,
        };
        proj.labels.push(newLabel);
        return Response.json(newLabel);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function createTestClient(): ItsaplanClient {
  return new ItsaplanClient(baseUrl, "test-api-key", {
    retryOptions: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
  });
}

function initSourceProject(): void {
  projects.set("TECH", {
    id: 1,
    key: "TECH",
    name: "Tech Support Production",
    columns: [
      { id: 10, name: "Backlog", stateType: "backlog", position: 0, color: "#9CA3AF" },
      { id: 11, name: "Chờ xử lý", stateType: "unstarted", position: 1, color: "#F59E0B" },
      { id: 12, name: "Đang xử lý", stateType: "started", position: 2, color: "#3B82F6" },
      { id: 13, name: "Đã giải quyết", stateType: "completed", position: 3, color: "#10B981" },
      { id: 14, name: "Đã hủy", stateType: "canceled", position: 4, color: "#6B7280" },
    ],
    labels: [
      { id: 20, name: "Lỗi kỹ thuật", color: "#E54D2E" },
      { id: 21, name: "Lỗi dữ liệu", color: "#F59E0B" },
      { id: 22, name: "IT Support", color: "#10B981" },
    ],
  });
}

beforeEach(() => {
  projects = new Map();
  recordedRequests.length = 0;
  nextId = 100;
  initSourceProject();
});

describe("scripts/sync-itsaplan-project", () => {
  test("Ca 1: Target chưa tồn tại -> tạo project, tạo đủ cột và nhãn", async () => {
    const client = createTestClient();
    const result = await syncItsaplanProject(
      {
        source: "TECH",
        target: "TECH2",
        name: "Tech Sandbox",
      },
      client,
    );

    expect(result.projectCreated).toBe(true);
    expect(result.columnsCreated.length).toBe(5);
    expect(result.labelsCreated.length).toBe(3);
    expect(result.dryRun).toBe(false);

    // Kiểm tra state project TECH2 trên mock server
    const targetProj = projects.get("TECH2");
    expect(targetProj).toBeDefined();
    expect(targetProj?.name).toBe("Tech Sandbox");
    expect(targetProj?.columns.length).toBe(5);
    expect(targetProj?.columns.map((c) => c.name)).toEqual([
      "Backlog",
      "Chờ xử lý",
      "Đang xử lý",
      "Đã giải quyết",
      "Đã hủy",
    ]);
    expect(targetProj?.labels.length).toBe(3);
    expect(targetProj?.labels.map((l) => l.name)).toEqual([
      "Lỗi kỹ thuật",
      "Lỗi dữ liệu",
      "IT Support",
    ]);

    // Bảo đảm 100% không có mutation nào gọi lên source TECH
    const sourceMutations = recordedRequests.filter(
      (r) =>
        (r.path === "/projects/TECH" || r.path.startsWith("/projects/TECH/")) && r.method !== "GET",
    );
    expect(sourceMutations).toHaveLength(0);
  });

  test("Ca 2: Target đã tồn tại một phần -> chỉ tạo bổ sung cột/nhãn thiếu và sửa cột lệch", async () => {
    // Tạo sẵn TECH2 với 2 cột (1 cột đúng, 1 cột lệch stateType và color) và 1 nhãn
    projects.set("TECH2", {
      id: 2,
      key: "TECH2",
      name: "Existing Tech Sandbox",
      columns: [
        { id: 50, name: "Backlog", stateType: "backlog", position: 0, color: "#9CA3AF" },
        // Chờ xử lý bị lệch: stateType là started (đúng ra unstarted), color là #000000 (đúng ra #F59E0B)
        { id: 51, name: "Chờ xử lý", stateType: "started", position: 1, color: "#000000" },
      ],
      labels: [{ id: 60, name: "Lỗi kỹ thuật", color: "#E54D2E" }],
    });

    const client = createTestClient();
    const result = await syncItsaplanProject(
      {
        source: "TECH",
        target: "TECH2",
      },
      client,
    );

    expect(result.projectCreated).toBe(false);
    // Thiếu 3 cột: Đang xử lý, Đã giải quyết, Đã hủy
    expect(result.columnsCreated).toEqual(["Đang xử lý", "Đã giải quyết", "Đã hủy"]);
    // Cập nhật 1 cột: Chờ xử lý
    expect(result.columnsUpdated).toHaveLength(1);
    expect(result.columnsUpdated[0]?.name).toBe("Chờ xử lý");
    expect(result.columnsUpdated[0]?.stateType).toBe("unstarted");
    expect(result.columnsUpdated[0]?.color).toBe("#F59E0B");

    // Thiếu 2 nhãn: Lỗi dữ liệu, IT Support
    expect(result.labelsCreated).toEqual(["Lỗi dữ liệu", "IT Support"]);

    // Kiểm tra state sau sync
    const targetProj = projects.get("TECH2");
    expect(targetProj?.columns.length).toBe(5);
    const updatedCol = targetProj?.columns.find((c) => c.name === "Chờ xử lý");
    expect(updatedCol?.stateType).toBe("unstarted");
    expect(updatedCol?.color).toBe("#F59E0B");
    expect(targetProj?.labels.length).toBe(3);

    // Không có POST /projects
    const projectCreates = recordedRequests.filter(
      (r) => r.method === "POST" && r.path === "/projects",
    );
    expect(projectCreates).toHaveLength(0);

    // Source không bị mutation
    const sourceMutations = recordedRequests.filter(
      (r) =>
        (r.path === "/projects/TECH" || r.path.startsWith("/projects/TECH/")) && r.method !== "GET",
    );
    expect(sourceMutations).toHaveLength(0);
  });

  test("Ca 3: Target đã đồng nhất -> không thực hiện mutation thừa (idempotent)", async () => {
    // Tạo sẵn TECH2 với cấu hình y hệt TECH
    projects.set("TECH2", {
      id: 2,
      key: "TECH2",
      name: "Tech Sandbox",
      columns: [
        { id: 70, name: "Backlog", stateType: "backlog", position: 0, color: "#9CA3AF" },
        { id: 71, name: "Chờ xử lý", stateType: "unstarted", position: 1, color: "#F59E0B" },
        { id: 72, name: "Đang xử lý", stateType: "started", position: 2, color: "#3B82F6" },
        { id: 73, name: "Đã giải quyết", stateType: "completed", position: 3, color: "#10B981" },
        { id: 74, name: "Đã hủy", stateType: "canceled", position: 4, color: "#6B7280" },
      ],
      labels: [
        { id: 80, name: "Lỗi kỹ thuật", color: "#E54D2E" },
        { id: 81, name: "Lỗi dữ liệu", color: "#F59E0B" },
        { id: 82, name: "IT Support", color: "#10B981" },
      ],
    });

    const client = createTestClient();
    const result = await syncItsaplanProject(
      {
        source: "TECH",
        target: "TECH2",
      },
      client,
    );

    expect(result.projectCreated).toBe(false);
    expect(result.columnsCreated).toHaveLength(0);
    expect(result.columnsUpdated).toHaveLength(0);
    expect(result.columnsReordered).toBe(false);
    expect(result.labelsCreated).toHaveLength(0);

    // Kiểm tra toàn bộ requests gửi đi: TUYỆT ĐỐI KHÔNG có mutation nào (POST/PATCH/PUT/DELETE)
    const mutations = recordedRequests.filter((r) => r.method !== "GET");
    expect(mutations).toHaveLength(0);

    // Chỉ có các request GET để đọc trạng thái
    expect(recordedRequests.length).toBeGreaterThan(0);
    for (const req of recordedRequests) {
      expect(req.method).toBe("GET");
    }
  });

  test("Ca 4: Cờ --dry-run -> không gửi bất kỳ POST/PATCH/PUT/DELETE nào", async () => {
    // Target chưa tồn tại
    const client = createTestClient();
    const result = await syncItsaplanProject(
      {
        source: "TECH",
        target: "TECH2",
        dryRun: true,
      },
      client,
    );

    expect(result.dryRun).toBe(true);
    expect(result.projectCreated).toBe(true);
    expect(result.columnsCreated.length).toBe(5);
    expect(result.labelsCreated.length).toBe(3);

    // Target vẫn chưa được tạo trên mock server
    expect(projects.has("TECH2")).toBe(false);

    // Toàn bộ request gửi lên server đều là GET
    const mutations = recordedRequests.filter((r) => r.method !== "GET");
    expect(mutations).toHaveLength(0);
  });

  test("Ca 5: Target trùng với Source -> chặn an toàn ngay lập tức", async () => {
    const client = createTestClient();

    // Source trùng target (cùng chữ hoa)
    await expect(syncItsaplanProject({ source: "TECH", target: "TECH" }, client)).rejects.toThrow(
      "Target project cannot be identical to source project",
    );

    // Source trùng target (khác hoa thường)
    await expect(syncItsaplanProject({ source: "tech", target: "TECH" }, client)).rejects.toThrow(
      "Target project cannot be identical to source project",
    );

    // Tuyệt đối không gửi request mutation nào
    const mutations = recordedRequests.filter((r) => r.method !== "GET");
    expect(mutations).toHaveLength(0);
  });

  test("Ca 6: Dự án nguồn không tồn tại -> báo lỗi rõ ràng", async () => {
    const client = createTestClient();
    await expect(
      syncItsaplanProject({ source: "NON_EXISTENT", target: "TECH2" }, client),
    ).rejects.toThrow('Source project "NON_EXISTENT" not found or inaccessible');
  });

  test("Ca 7: Reorder cột khi thứ tự cột trên target bị đảo", async () => {
    // Target có đủ 5 cột nhưng thứ tự ngược
    projects.set("TECH2", {
      id: 2,
      key: "TECH2",
      name: "Tech Sandbox",
      columns: [
        { id: 74, name: "Đã hủy", stateType: "canceled", position: 0, color: "#6B7280" },
        { id: 73, name: "Đã giải quyết", stateType: "completed", position: 1, color: "#10B981" },
        { id: 72, name: "Đang xử lý", stateType: "started", position: 2, color: "#3B82F6" },
        { id: 71, name: "Chờ xử lý", stateType: "unstarted", position: 3, color: "#F59E0B" },
        { id: 70, name: "Backlog", stateType: "backlog", position: 4, color: "#9CA3AF" },
      ],
      labels: [
        { id: 80, name: "Lỗi kỹ thuật", color: "#E54D2E" },
        { id: 81, name: "Lỗi dữ liệu", color: "#F59E0B" },
        { id: 82, name: "IT Support", color: "#10B981" },
      ],
    });

    const client = createTestClient();
    const result = await syncItsaplanProject(
      {
        source: "TECH",
        target: "TECH2",
      },
      client,
    );

    expect(result.columnsReordered).toBe(true);

    // Kiểm tra reorder endpoint đã được gọi
    const reorderReq = recordedRequests.find((r) => r.path === "/projects/TECH2/columns/reorder");
    expect(reorderReq).toBeDefined();
    const reorderBody =
      reorderReq &&
      typeof reorderReq.body === "object" &&
      reorderReq.body !== null &&
      "orderedIds" in reorderReq.body
        ? (reorderReq.body.orderedIds as number[])
        : [];
    expect(reorderBody).toEqual([70, 71, 72, 73, 74]);
    // Kiểm tra thứ tự trên mock server
    const targetProj = projects.get("TECH2");
    expect(targetProj?.columns.map((c) => c.id)).toEqual([70, 71, 72, 73, 74]);
  });

  test("CLI: parseArgs hỗ trợ các định dạng cờ", () => {
    const defaultArgs = parseArgs([]);
    expect(defaultArgs.source).toBe("TECH");
    expect(defaultArgs.target).toBe("TECH2");
    expect(defaultArgs.name).toBe("Tech Sandbox");
    expect(defaultArgs.team).toBe("tech");
    expect(defaultArgs.dryRun).toBe(false);
    expect(defaultArgs.help).toBe(false);

    const customArgs = parseArgs([
      "--source",
      "PROD",
      "--target=STAGING",
      "--name",
      "Staging Project",
      "--team=dev",
      "--dry-run",
    ]);
    expect(customArgs.source).toBe("PROD");
    expect(customArgs.target).toBe("STAGING");
    expect(customArgs.name).toBe("Staging Project");
    expect(customArgs.team).toBe("dev");
    expect(customArgs.dryRun).toBe(true);

    const helpArgs = parseArgs(["-h"]);
    expect(helpArgs.help).toBe(true);
  });

  test("CLI: runCli xử lý thiếu biến môi trường", async () => {
    const code = await runCli([], {});
    expect(code).toBe(1);
  });

  test("CLI: runCli xử lý cờ --help thành công", async () => {
    const code = await runCli(["--help"], {});
    expect(code).toBe(0);
  });

  test("CLI: runCli chạy trọn vẹn với customClient", async () => {
    const client = createTestClient();
    const code = await runCli(["--dry-run"], {}, client);
    expect(code).toBe(0);
  });
});
