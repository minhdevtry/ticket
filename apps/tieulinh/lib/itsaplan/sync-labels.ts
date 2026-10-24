import { ItsaplanClient } from "./client";
import { getLogger } from "../logger";

export interface LabelDefinition {
  name: string;
  color: string;
}

/**
 * 18 nhãn chuẩn từ Huly Workspace (tracker:category:Other).
 */
export const HULY_STANDARD_LABELS: LabelDefinition[] = [
  { name: "Lỗi kỹ thuật", color: "#E54D2E" },
  { name: "Lỗi dữ liệu", color: "#F59E0B" },
  { name: "Lỗi hệ thống", color: "#EF4444" },
  { name: "Lỗi bên thứ 3", color: "#F97316" },
  { name: "Lỗi cấu hình máy", color: "#6366F1" },
  { name: "Lỗi chưa xác định", color: "#9CA3AF" },
  { name: "Chưa phân loại", color: "#6B7280" },
  { name: "Hỗ trợ", color: "#3B82F6" },
  { name: "IT Support", color: "#10B981" },
  { name: "ND bị nhầm hoặc hiểu sai", color: "#EC4899" },
  { name: "Lỗi nhập liệu", color: "#8B5CF6" },
  { name: "Khác", color: "#94A3B8" },
  { name: "Feature request", color: "#3B82F6" },
  { name: "Cải tiến sản phẩm", color: "#10B981" },
  { name: "Opportunity Brief", color: "#F59E0B" },
  { name: "Product Insight", color: "#8B5CF6" },
  { name: "Sổ liên lạc", color: "#06B6D4" },
  { name: "Home 4.0", color: "#14B8A6" },
];

/**
 * Đồng bộ toàn bộ các nhãn chuẩn từ Huly sang dự án trên Itsaplan nếu chưa tồn tại.
 */
export async function syncHulyLabelsToItsaplan(
  client: ItsaplanClient,
  projectKey: string,
): Promise<{ added: string[]; existing: string[] }> {
  const project = await client.getProject(projectKey);
  const existingLabels = project.labels ?? [];
  const existingNames = new Set(existingLabels.map((l) => l.name.trim().toLowerCase()));

  const added: string[] = [];
  const existing: string[] = [];

  for (const item of HULY_STANDARD_LABELS) {
    const norm = item.name.trim().toLowerCase();
    if (existingNames.has(norm)) {
      existing.push(item.name);
    } else {
      try {
        await client.createLabel(project.key ?? projectKey, {
          name: item.name,
          color: item.color,
        });
        added.push(item.name);
      } catch (err: any) {
        getLogger().warn(`[syncLabels] Không thể tạo nhãn "${item.name}": ${err.message}`);
      }
    }
  }

  getLogger().info(
    `[syncLabels] Đồng bộ nhãn Huly sang Itsaplan [${projectKey}]: Thêm mới ${added.length}, Đã có ${existing.length}`,
  );
  return { added, existing };
}
