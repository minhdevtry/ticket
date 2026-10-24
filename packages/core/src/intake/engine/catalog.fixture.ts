/**
 * A minimal single-variant catalog for engine tests — the "tech" incident
 * flow: one required free-text problem field (`van_de`) plus an optional
 * department. Enough to exercise the gate's complete/incomplete branch through
 * the engine seam without pulling in Tiểu Linh's full domain config (that lives
 * in `examples/tieulinh/`).
 */
import { createCatalog } from "../gate/catalog";
import type { FieldCatalog } from "../gate/types";

export const engineTestCatalog: FieldCatalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Tech incident",
        truong_mo_dau: "van_de",
        recap: ["van_de", "bo_phan"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Problem",
            hoi: "What's the problem?",
          },
          bo_phan: {
            bat_buoc: false,
            nen_hoi: false,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Department",
            hoi: "Which team?",
          },
        },
      },
    },
  },
});
