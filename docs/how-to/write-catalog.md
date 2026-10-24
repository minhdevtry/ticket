# Viết catalog tiếp nhận

Catalog mô tả bot phải hỏi người báo những trường nào, trường nào bắt buộc, hỏi tối đa mấy lần. Gate (`evaluateGate`) đọc catalog và bản ghi đang thu thập rồi trả lời: đủ chưa, nếu chưa thì hỏi gì tiếp. Gate thuần: không I/O, không đồng hồ, không sửa đầu vào. Model chỉ diễn đạt câu hỏi, còn "hỏi gì" do catalog quyết định.

Catalog được soạn bằng JSON theo ngôn ngữ nghiệp vụ (khoá tiếng Việt không dấu như `bat_buoc`, `hoi_lai`), và `createCatalog` chuẩn hoá một lần thành kiểu `FieldCatalog` có kiểu rõ ràng. Bảng được truyền vào dưới dạng **dữ liệu** (bạn `import` file JSON), không đọc từ đĩa, để nhị phân biên dịch vẫn tự chứa.

## Cấu trúc

| Khoá | Ý nghĩa |
|---|---|
| `chung` | Trường dùng chung cho mọi nhánh |
| `nhanh.<khoá>` | Một nhánh (loại tờ khai). Mỗi nhánh có `ten`, `truong`, `recap`, `truong_mo_dau` |
| `truong.<tên>.bat_buoc` | Thiếu thì không được qua gate |
| `truong.<tên>.bat_buoc_neu` | Bắt buộc có điều kiện, dạng `"<trường> in\|matches\|not matches <danh sách>"` |
| `truong.<tên>.nen_hoi` | Hỏi một lượt cho đủ hồ sơ; người báo không có thì vẫn qua |
| `truong.<tên>.duoc_hoi` | `false` cho trường hệ thống tự điền |
| `truong.<tên>.kieu` | `text` hoặc `enum:<tên danh sách>` |
| `truong.<tên>.hoi`, `hoi_lai` | Câu hỏi lần đầu và các câu hỏi lại. Số câu hỏi lại quyết định ngân sách hỏi |
| `mot_trong` | Ít nhất một trong các trường này phải có |
| `_toi_da_hoi_lai`, `_toi_da_truong_moi_luot` | Ngân sách hỏi lại mặc định và số trường hỏi mỗi lượt |
| `_soi_gia_tri` | Bật kiểm giá trị (enum, regex). Mặc định tắt |

`createCatalog` kiểm tính toàn vẹn ngay lúc dựng (ví dụ luật `bat_buoc_neu` trỏ tới danh sách không tồn tại) để lỗi lộ ra khi khởi động chứ không phải giữa một cuộc hội thoại.

## Ví dụ chạy được

Mẫu dưới đây được CI chạy thật (`ts run`): nếu hành vi của gate đổi, trang này làm CI đỏ.

```ts run
import assert from "node:assert/strict";
import { createCatalog, createRecord, evaluateGate } from "@vuihoc/bot-core/intake";

const catalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    chung: {
      tieu_de: { bat_buoc: true, kieu: "text", duoc_hoi: false, nhan: "Tiêu đề" },
    },
    nhanh: {
      loi: {
        ten: "Báo lỗi",
        truong_mo_dau: "van_de",
        recap: ["tieu_de", "van_de", "he_thong"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            nhan: "Vấn đề",
            hoi: "Vấn đề cụ thể là gì ạ?",
          },
          he_thong: {
            nen_hoi: true,
            kieu: "enum:he_thong",
            nhan: "Hệ thống",
            hoi: "Sự cố ở hệ thống nào ạ?",
          },
        },
      },
    },
  },
  enums: { he_thong: ["App", "Web"] },
});

// Chưa có "van_de": gate đòi trường bắt buộc đó và đưa ra câu hỏi.
const first = evaluateGate(catalog, createRecord("loi", { tieu_de: "Không vào được lớp" }));
assert.equal(first.isComplete, false);
assert.deepEqual(first.missingRequired, ["van_de"]);
assert.equal(first.questionText.includes("Vấn đề cụ thể là gì ạ?"), true);

// Có đủ trường bắt buộc: qua gate, trường "nên hỏi" không chặn.
const second = evaluateGate(
  catalog,
  createRecord("loi", { tieu_de: "Không vào được lớp", van_de: "Màn hình trắng sau khi vào" }),
);
assert.equal(second.isComplete, true);
```

## Gợi ý khi viết

- **Chỉ đặt `bat_buoc` cho thứ thiếu thì không thể xử lý.** Cái "nên biết" dùng `nen_hoi`: bot hỏi một lượt rồi đi tiếp.
- **Giữ giá trị enum ngắn.** Giá trị enum thường làm `callback_data` của nút Telegram, mà Telegram giới hạn 64 byte UTF-8 (tiếng Việt có dấu tốn 2-3 byte một chữ). Giá trị dài thì khai nhãn nút ngắn trong `_nhan_nut`; `createCatalog` tự coi nhãn đó là một synonym của giá trị chuẩn.
- **Số câu `hoi_lai` là ngân sách hỏi.** Hết ngân sách mà người báo vẫn không trả lời thì bot dừng hỏi trường đó (dùng `het_luot` làm giá trị mặc định nếu muốn).
- **Không bịa tên trường trong prompt.** Schema tool cho model được sinh từ catalog (`buildFieldSchema`), nên thêm trường vào catalog là đủ.

## Luật ưu tiên

Mức ưu tiên không do bot hay người báo tự đặt: suy ra từ bằng chứng theo bảng luật. `evaluatePriorityRules(rules, proposedLevel, evidence)` nhận bảng luật là dữ liệu (`levels`, `floors`, `ceilings`) và trả mức được phép. Sàn nâng mức lên, trần chặn mức xuống, và sàn thắng khi hai bên xung đột. `resolveRequestedPriority` xử lý trường hợp người báo xin mức cao hơn: chỉ chấp nhận khi có lý do và mức xin cao hơn mức bằng chứng đã cho.

```ts run
import assert from "node:assert/strict";
import { evaluatePriorityRules } from "@vuihoc/bot-core/intake";

const rules = {
  levels: ["low", "medium", "high", "urgent"],
  floors: [{ when: { blocksPayment: true }, minLevel: "urgent", reason: "Chặn giao dịch" }],
  ceilings: [{ when: { hasWorkaround: true }, maxLevel: "medium", reason: "Có cách làm tạm" }],
};

// Chặn giao dịch thì sàn thắng trần, dù có cách làm tạm.
const verdict = evaluatePriorityRules(rules, "low", { blocksPayment: true, hasWorkaround: true });
assert.equal(verdict.allowedLevel, "urgent");
assert.equal(verdict.floorOverrodeCeiling, true);
```

Danh sách chuỗi hiển thị mà engine cần (câu hỏi mở đầu, nút xác nhận, thông báo tạo ticket...) nằm ở [danh sách CopyKey](/reference/copy-keys); bot cung cấp chúng qua `CopyCatalog`.
