#!/usr/bin/env bun
/**
 * scripts/sync-itsaplan-project.ts — Đồng bộ cấu hình project từ nguồn (mặc định TECH)
 * sang đích (mặc định TECH2) trên Itsaplan.
 *
 * An toàn tuyệt đối:
 *  - Project nguồn (source) TUYỆT ĐỐI CHỈ ĐỌC (READ-ONLY 100%).
 *  - Chặn ngay nếu target trùng với source.
 *  - Cờ --dry-run: Chỉ kiểm tra và in kế hoạch thay đổi, không gửi mutation.
 *  - Idempotent: Chạy nhiều lần cho cùng kết quả, không tạo trùng cột/nhãn.
 */
import {
  ItsaplanApiError,
  ItsaplanClient,
  type ItsaplanProject,
  type ProjectColumn,
} from "../packages/core/src/itsaplan/index";

export interface CliArgs {
  source: string;
  target: string;
  name: string;
  team: string;
  dryRun: boolean;
  help: boolean;
}

export interface SyncOptions {
  source: string;
  target: string;
  name?: string;
  team?: string;
  dryRun?: boolean;
}

export interface SyncResult {
  sourceKey: string;
  targetKey: string;
  targetName: string;
  team: string;
  projectCreated: boolean;
  columnsCreated: string[];
  columnsUpdated: Array<{ name: string; stateType?: string; color?: string }>;
  columnsReordered: boolean;
  labelsCreated: string[];
  dryRun: boolean;
}

export const HELP_TEXT = `Usage: bun run scripts/sync-itsaplan-project.ts [options]

Đồng bộ cấu hình project từ source sang target trên Itsaplan.

Options:
  --source <key>     Project nguồn để đọc cấu hình (mặc định: TECH)
  --target <key>     Project đích để đồng bộ sang (mặc định: TECH2)
  --name <text>      Tên của project đích nếu phải tạo mới (mặc định: "Tech Sandbox")
  --team <slug>      Team slug (mặc định: tech)
  --dry-run          Chỉ kiểm tra và in báo cáo, không ghi lên server
  --help, -h         Hiển thị hướng dẫn sử dụng
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    source: "TECH",
    target: "TECH2",
    name: "Tech Sandbox",
    team: "tech",
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--source") {
      const val = argv[++i];
      if (val !== undefined) args.source = val;
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--target") {
      const val = argv[++i];
      if (val !== undefined) args.target = val;
    } else if (arg.startsWith("--target=")) {
      args.target = arg.slice("--target=".length);
    } else if (arg === "--name") {
      const val = argv[++i];
      if (val !== undefined) args.name = val;
    } else if (arg.startsWith("--name=")) {
      args.name = arg.slice("--name=".length);
    } else if (arg === "--team") {
      const val = argv[++i];
      if (val !== undefined) args.team = val;
    } else if (arg.startsWith("--team=")) {
      args.team = arg.slice("--team=".length);
    }
  }

  return args;
}

function isNotFoundError(err: unknown): boolean {
  if (err instanceof ItsaplanApiError && err.status === 404) {
    return true;
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    return err.status === 404;
  }
  return false;
}

/**
 * Đồng bộ cấu hình dự án nguồn sang dự án đích.
 */
export async function syncItsaplanProject(
  options: SyncOptions,
  client: ItsaplanClient,
): Promise<SyncResult> {
  const sourceKey = options.source.trim();
  const targetKey = options.target.trim();
  const targetName = options.name?.trim() || "Tech Sandbox";
  const teamSlug = options.team?.trim() || "tech";
  const dryRun = Boolean(options.dryRun);

  if (!sourceKey || !targetKey) {
    throw new Error("Source and target project keys cannot be empty");
  }

  if (sourceKey.toUpperCase() === targetKey.toUpperCase()) {
    throw new Error("Target project cannot be identical to source project");
  }

  console.log(
    `[sync-project] Bắt đầu đồng bộ: ${sourceKey} -> ${targetKey} (team: ${teamSlug}, dryRun: ${dryRun})`,
  );

  // 1. Đọc dự án nguồn (READ-ONLY 100%)
  console.log(`[sync-project] Đọc cấu hình dự án nguồn "${sourceKey}"...`);
  let sourceProject: ItsaplanProject;
  try {
    sourceProject = await client.getProject(sourceKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Source project "${sourceKey}" not found or inaccessible: ${msg}`);
  }

  const sourceColumns = (sourceProject.columns ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);
  const sourceLabels = sourceProject.labels ?? [];

  console.log(
    `[sync-project] Dự án nguồn "${sourceKey}": ${sourceColumns.length} cột, ${sourceLabels.length} nhãn.`,
  );

  // 2. Kiểm tra & tạo dự án đích nếu chưa có
  console.log(`[sync-project] Kiểm tra dự án đích "${targetKey}"...`);
  let targetProject: ItsaplanProject | null = null;
  let projectCreated = false;

  try {
    targetProject = await client.getProject(targetKey);
  } catch (err) {
    if (isNotFoundError(err)) {
      targetProject = null;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Error checking target project "${targetKey}": ${msg}`);
    }
  }

  if (!targetProject) {
    if (dryRun) {
      console.log(
        `[sync-project] [DRY-RUN] Dự án đích "${targetKey}" chưa tồn tại -> sẽ tạo mới (name: "${targetName}", preset: "empty").`,
      );
      projectCreated = true;
    } else {
      console.log(
        `[sync-project] Dự án đích "${targetKey}" chưa tồn tại. Đang tạo mới (name: "${targetName}", preset: "empty")...`,
      );
      targetProject = await client.createProject({
        key: targetKey,
        name: targetName,
        preset: "empty",
      });
      projectCreated = true;
      console.log(`[sync-project] Đã tạo dự án đích "${targetKey}".`);
    }
  } else {
    console.log(`[sync-project] Dự án đích "${targetKey}" đã tồn tại.`);
  }

  // 3. Đồng bộ cột trạng thái
  console.log(`[sync-project] Kiểm tra và đồng bộ cột trạng thái...`);
  const targetColumns: ProjectColumn[] = targetProject?.columns
    ? targetProject.columns.slice()
    : [];

  const columnsCreated: string[] = [];
  const columnsUpdated: Array<{ name: string; stateType?: string; color?: string }> = [];

  for (const srcCol of sourceColumns) {
    const normSrcName = srcCol.name.trim().toLowerCase();
    const existingCol = targetColumns.find((c) => c.name.trim().toLowerCase() === normSrcName);

    if (!existingCol) {
      if (dryRun) {
        console.log(
          `[sync-project] [DRY-RUN] Sẽ tạo cột mới: "${srcCol.name}" (stateType: ${srcCol.stateType}, color: ${srcCol.color ?? "none"}, position: ${srcCol.position})`,
        );
        columnsCreated.push(srcCol.name);
      } else {
        console.log(
          `[sync-project] Tạo cột mới: "${srcCol.name}" (stateType: ${srcCol.stateType}, color: ${srcCol.color ?? "none"}, position: ${srcCol.position})...`,
        );
        const newCol = await client.createColumn(targetKey, {
          name: srcCol.name,
          stateType: srcCol.stateType,
          color: srcCol.color,
          position: srcCol.position,
        });
        columnsCreated.push(srcCol.name);
        targetColumns.push(newCol);
      }
    } else {
      // Cột đã có: kiểm tra stateType và color
      const patch: {
        stateType?: ProjectColumn["stateType"];
        color?: string;
      } = {};

      if (existingCol.stateType !== srcCol.stateType) {
        patch.stateType = srcCol.stateType;
      }
      if (srcCol.color !== undefined && existingCol.color !== srcCol.color) {
        patch.color = srcCol.color;
      }

      if (patch.stateType !== undefined || patch.color !== undefined) {
        if (dryRun) {
          console.log(
            `[sync-project] [DRY-RUN] Sẽ cập nhật cột "${existingCol.name}" (id: ${existingCol.id}): ${JSON.stringify(patch)}`,
          );
          columnsUpdated.push({ name: existingCol.name, ...patch });
        } else {
          console.log(
            `[sync-project] Cập nhật cột "${existingCol.name}" (id: ${existingCol.id}): ${JSON.stringify(patch)}...`,
          );
          const updated = await client.updateColumn(targetKey, existingCol.id, patch);
          columnsUpdated.push({ name: existingCol.name, ...patch });
          existingCol.stateType = updated.stateType;
          existingCol.color = updated.color;
        }
      }
    }
  }

  // Sắp xếp thứ tự các cột trạng thái
  let columnsReordered = false;
  if (targetColumns.length > 0) {
    const desiredOrderIds: number[] = [];
    for (const srcCol of sourceColumns) {
      const normSrcName = srcCol.name.trim().toLowerCase();
      const match = targetColumns.find((c) => c.name.trim().toLowerCase() === normSrcName);
      if (match && typeof match.id === "number") {
        desiredOrderIds.push(match.id);
      }
    }
    // Giữ lại các cột thừa trên target (nếu có) ở cuối danh sách
    for (const col of targetColumns) {
      if (typeof col.id === "number" && !desiredOrderIds.includes(col.id)) {
        desiredOrderIds.push(col.id);
      }
    }

    const currentOrderIds = targetColumns
      .map((c) => c.id)
      .filter((id): id is number => typeof id === "number");

    const orderMatches =
      desiredOrderIds.length === currentOrderIds.length &&
      desiredOrderIds.every((id, idx) => id === currentOrderIds[idx]);

    if (!orderMatches && desiredOrderIds.length > 0) {
      if (dryRun) {
        console.log(
          `[sync-project] [DRY-RUN] Sẽ sắp xếp lại thứ tự cột: [${desiredOrderIds.join(", ")}]`,
        );
        columnsReordered = true;
      } else {
        console.log(`[sync-project] Sắp xếp lại thứ tự cột: [${desiredOrderIds.join(", ")}]...`);
        await client.reorderColumns(targetKey, desiredOrderIds);
        columnsReordered = true;
      }
    }
  } else if (dryRun && sourceColumns.length > 0) {
    columnsReordered = true;
  }

  // 4. Đồng bộ nhãn (Labels)
  console.log(`[sync-project] Kiểm tra và đồng bộ nhãn...`);
  const targetLabels = targetProject?.labels ? targetProject.labels.slice() : [];
  const existingLabelNames = new Set(targetLabels.map((l) => l.name.trim().toLowerCase()));
  const labelsCreated: string[] = [];

  for (const label of sourceLabels) {
    const normName = label.name.trim().toLowerCase();
    if (!existingLabelNames.has(normName)) {
      if (dryRun) {
        console.log(
          `[sync-project] [DRY-RUN] Sẽ tạo nhãn mới: "${label.name}" (color: ${label.color ?? "none"})`,
        );
        labelsCreated.push(label.name);
        existingLabelNames.add(normName);
      } else {
        console.log(
          `[sync-project] Tạo nhãn mới: "${label.name}" (color: ${label.color ?? "none"})...`,
        );
        await client.createLabel(targetKey, {
          name: label.name,
          color: label.color,
        });
        labelsCreated.push(label.name);
        existingLabelNames.add(normName);
      }
    }
  }

  return {
    sourceKey,
    targetKey,
    targetName,
    team: teamSlug,
    projectCreated,
    columnsCreated,
    columnsUpdated,
    columnsReordered,
    labelsCreated,
    dryRun,
  };
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  customClient?: ItsaplanClient,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const baseUrl = env.ITSAPLAN_BASE_URL;
  const apiKey = env.ITSAPLAN_API_KEY;

  if (!customClient && (!baseUrl || !apiKey)) {
    console.error(
      "Lỗi: Thiếu biến môi trường ITSAPLAN_BASE_URL hoặc ITSAPLAN_API_KEY.\n" +
        "Vui lòng thiết lập biến môi trường trước khi chạy script:\n" +
        '  export ITSAPLAN_BASE_URL="https://itsaplan.example.com/api"\n' +
        '  export ITSAPLAN_API_KEY="your-api-key"',
    );
    return 1;
  }

  const client = customClient ?? new ItsaplanClient(baseUrl ?? "", apiKey ?? "");

  try {
    const result = await syncItsaplanProject(args, client);
    console.log(`\n✓ Hoàn tất đồng bộ [${result.sourceKey} -> ${result.targetKey}]:`);
    console.log(`  - Project tạo mới: ${result.projectCreated ? "Có" : "Không"}`);
    console.log(
      `  - Cột tạo mới (${result.columnsCreated.length}): ${result.columnsCreated.join(", ") || "Không"}`,
    );
    console.log(
      `  - Cột cập nhật (${result.columnsUpdated.length}): ${result.columnsUpdated.map((c) => c.name).join(", ") || "Không"}`,
    );
    console.log(`  - Cột sắp xếp lại: ${result.columnsReordered ? "Có" : "Không"}`);
    console.log(
      `  - Nhãn tạo mới (${result.labelsCreated.length}): ${result.labelsCreated.join(", ") || "Không"}`,
    );
    if (result.dryRun) {
      console.log("  * Chế độ --dry-run: Không có thay đổi nào được ghi lên server.");
    }
    return 0;
  } catch (err) {
    console.error(`\n✗ Thất bại: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli();
  if (code !== 0) process.exit(code);
}
