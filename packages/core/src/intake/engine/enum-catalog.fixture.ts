/**
 * Catalog có trường enum để kiểm tra NÚT cho câu hỏi: trường bắt buộc
 * `he_thong` với danh mục kín, hỏi bằng nút bấm.
 */
import { createCatalog } from "../gate/catalog";
import type { FieldCatalog } from "../gate/types";

export const enumTestCatalog: FieldCatalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Tech incident",
        truong_mo_dau: "he_thong",
        recap: ["he_thong"],
        truong: {
          he_thong: {
            bat_buoc: true,
            kieu: "enum:he_thong",
            duoc_hoi: true,
            nhan: "System",
            hoi: "Which system?",
          },
        },
      },
    },
  },
  enums: { he_thong: ["CRM", "Duo"] },
});
