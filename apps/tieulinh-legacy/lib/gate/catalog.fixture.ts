/**
 * A small catalog for the tests, exercising each shape the modules branch on:
 * a free-text field, a single-choice enum, a multi-value enum, a system-filled
 * field, and a field blocked from the recap.
 */
import { createCatalog } from "@vuihoc/bot-core/intake";
import type { FieldCatalog } from "@vuihoc/bot-core/intake";

export const fixtureCatalog: FieldCatalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    _nhan_tu_sinh: { nhom: "Nhóm" },
    cam_in_trong_recap: { truong: ["ghi_chu_noi_bo"] },
    chung: {
      tieu_de: { bat_buoc: true, kieu: "text", duoc_hoi: false, nhan: "Tiêu đề" },
    },
    nhanh: {
      "1": {
        ten: "Order tính năng",
        truong_mo_dau: "van_de",
        recap: ["tieu_de", "nhom", "van_de", "phong_ban", "he_thong", "ghi_chu_noi_bo"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Vấn đề",
            hoi: "Vấn đề cụ thể là gì ạ?",
          },
          phong_ban: {
            bat_buoc: true,
            kieu: "enum:phong_ban",
            duoc_hoi: true,
            nhan: "Bộ phận",
            hoi: "Anh/chị ở bộ phận nào ạ?",
          },
          he_thong: {
            bat_buoc: false,
            nen_hoi: true,
            kieu: "enum:he_thong",
            nhieu_gia_tri: true,
            duoc_hoi: true,
            nhan: "Hệ thống",
            hoi: "Liên quan tới hệ thống nào ạ?",
          },
          ghi_chu_noi_bo: {
            bat_buoc: false,
            kieu: "text",
            duoc_hoi: false,
            nhan: "Ghi chú nội bộ",
          },
        },
      },
      "3": {
        ten: "Cải tiến",
        truong_mo_dau: "van_de",
        recap: ["tieu_de", "van_de", "tan_suat", "quy_mo"],
        mot_trong: { truong: ["tan_suat", "quy_mo"] },
        truong: {
          van_de: { bat_buoc: true, kieu: "text", duoc_hoi: true, nhan: "Vấn đề" },
          tan_suat: {
            bat_buoc: false,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Tần suất",
            hoi: "Việc này lặp lại bao lâu một lần ạ?",
          },
          quy_mo: {
            bat_buoc: false,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Quy mô",
            hoi: "Bao nhiêu người đang chịu ảnh hưởng ạ?",
          },
        },
      },
      "2": {
        ten: "Báo lỗi",
        truong_mo_dau: "van_de",
        recap: ["tieu_de", "van_de"],
        truong: {
          van_de: { bat_buoc: true, kieu: "text", duoc_hoi: true, nhan: "Sự cố" },
        },
      },
    },
  },
  enums: {
    phong_ban: ["CS", "Vận hành", "Marketing"],
    he_thong: ["LiveClass", "App VUIHOC", "Trang quản trị nội bộ"],
  },
  icons: { CS: "🎧", "Vận hành": "⚙️", LiveClass: "🎥" },
  synonyms: { CS: ["bên cs", "chăm sóc khách hàng"] },
});
