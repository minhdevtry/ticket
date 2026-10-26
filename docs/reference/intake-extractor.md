# Tham chiếu: bộ trích xuất sự cố (`@vuihoc/bot-core/intake`)

Mô-đun trích xuất trường sự cố và chuẩn hoá sau LLM cho engine tiếp nhận (RFC 0002 §1.5 E1–E5, A14). Cung cấp cổng `FieldExtractor`, thực thi luật nghiệp vụ và heuristic tiếng Việt, bảo toàn đường lùi tất định khi LLM không khả dụng hoặc bị lỗi.

Chữ ký chi tiết: xem [API (TypeDoc)](/reference/api/) (subpath `intake`). Trang này giải thích kiến trúc bộ trích xuất, tuỳ chọn cấu hình, các quy tắc heuristic tiếng Việt, và ranh giới phân định giữa core và app.

## `FieldExtractor`

Lớp cổng chính thực thi giao diện `FieldExtractorPort`:

```ts check
import { FieldExtractor } from "@vuihoc/bot-core/intake";

const extractor = new FieldExtractor({
  systemPrompt: "Bạn là trợ lý tiếp nhận sự cố kỹ thuật.",
  domain: {
    products: ["Tự học", "Duo", "Tutor"],
    systems: ["CRM_Vuihoc", "DUO_Vuihoc", "TUTOR_Vuihoc"],
  },
});

declare const message: string;
const result = await extractor.extract(message);
```

### Phương thức `extract`

Phương thức `extract(input)` nhận `ExtractInput` hoặc chuỗi `string`, trả về `ExtractedFields` gồm:
- `userIntent`: ý định chính (`report_issue`, `provide_info`, `confirm`, `cancel`, `chitchat`).
- `title`, `titleExplicit`: tiêu đề sự cố và cờ xác định người báo có yêu cầu sửa rõ ràng hay không.
- `symptoms`, `removeSymptoms`: danh sách triệu chứng cần gom hoặc cần gỡ.
- Các trường định danh: `studentAccount`, `customerId`, `roomCode`, `transactionId`, `assignmentId`.
- Các trường phân loại: `product`, `system`, `errorCategory`, `reportingDept`, `deviceType`, `deviceOs`, `appVersion`, `browser`.
- `reportingDeptUnrecognized`: bộ phận người dùng nêu nhưng không nằm trong danh mục đóng (để engine hỏi lại).
- Bằng chứng ưu tiên: `scope`, `blocksLearning`, `blocksPayment`, `reconciliationMismatch`, `dataLoss`, `hasWorkaround`, `singleDeviceOnly`.

## Tuỳ chọn `FieldExtractorOptions`

Constructor của `FieldExtractor` chấp nhận `FieldExtractorOptions`:

| Thuộc tính | Kiểu | Mô tả |
|---|---|---|
| `llmConfig` | `LlmConfig` | Cấu hình kết nối LLM gồm `baseUrl`, `apiKey`, `model`, và `api` (`openai`, `anthropic`, hoặc `openclaw`). |
| `completeFn` | `CompleteFn` | Hàm gọi LLM tuỳ chỉnh. Mặc định là `defaultComplete` với chuỗi model dự phòng. |
| `domain` | `ExtractorDomainConfig` | Cấu hình danh mục đóng và từ đồng nghĩa theo miền nghiệp vụ của app. |
| `systemPrompt` | `string` | Lời mở đầu xác định vai trò của trợ lý trong prompt hệ thống. Core dùng câu trung tính mặc định. |

## `ExtractorDomainConfig`

Cấu trúc định nghĩa danh mục miền cho bộ trích xuất:

```ts check
import type { ExtractorDomainConfig } from "@vuihoc/bot-core/intake";

export const appDomainConfig: ExtractorDomainConfig = {
  products: ["Tự học", "Duo", "Pas", "Tutor", "Exam"],
  systems: ["CRM_Vuihoc", "DUO_Vuihoc", "TUTOR_Vuihoc", "VH_Tự học", "LMS_Vuihoc"],
  errorCategories: ["Lỗi hệ thống", "Lỗi kỹ thuật", "Lỗi dữ liệu", "Khác"],
  reportingDepts: ["Vận hành", "Vận đơn", "CSKH", "CSHV", "Chuyên môn", "Sale", "Quản lý lớp"],
  deviceTypes: ["Điện thoại", "Máy tính bảng", "PC", "Laptop"],
  systemSynonyms: {
    crm: "CRM_Vuihoc",
    duo: "DUO_Vuihoc",
    tutor: "TUTOR_Vuihoc",
  },
  deptSynonyms: {
    vh: "Vận hành",
    cskh: "CSKH",
  },
};
```

## Các luật Heuristic tiếng Việt

Nhằm đảm bảo các bất biến an toàn và tính đúng đắn khi tiếp nhận sự cố bằng tiếng Việt, bộ trích xuất thực hiện các luật tất định:

1. **Luật số điện thoại (E2)**: Số điện thoại di động Việt Nam 10 chữ số (đầu số 03/05/07/08/09) khi xuất hiện ở trường `customerId` sẽ tự động chuyển sang `studentAccount`. `customerId` chỉ nhận mã khách hàng CRM riêng.
2. **Bộ phận chỉ nhận khi tin nhắn nhắc (E2)**: Giá trị phòng ban do LLM đoán mò sẽ bị loại bỏ nếu trong tin nhắn không có từ ngữ nhắc đến tên bộ phận hoặc từ viết tắt trong `deptSynonyms`.
3. **Bộ phận ngoài danh mục**: Nếu người báo nêu một bộ phận ngoài danh mục đóng (ví dụ "Kế toán"), trường `reportingDeptUnrecognized` được thiết lập để engine lễ tân hỏi lại đúng một lần kèm danh sách bộ phận hợp lệ.
4. **Suy ý định tĩnh không cần LLM (E3)**: Các phản hồi ngắn ("ok", "chuẩn", "đúng rồi") được suy là `confirm`; yêu cầu huỷ ("hủy ticket", "thôi không cần") là `cancel`; cảm ơn/chào hỏi là `chitchat`. Chữ "không" trong câu mô tả lỗi (như "không vào được lớp") không bao giờ bị nhầm thành `cancel`.
5. **Lệnh sửa tường minh A14**: Cú pháp sửa như "sửa tiêu đề thành X" hoặc "bỏ ý Y" đặt cờ `titleExplicit: true` và `removeSymptoms: ["Y"]`, đảm bảo ý định người dùng thắng các giá trị tóm tắt tự động.
6. **Bù bằng chứng mức ưu tiên khi LLM im lặng (E4)**: Nhận diện các cụm từ rõ ràng như "không vào được phòng học", "không thanh toán được", "cả lớp", "toàn bộ hệ thống" để bù bằng chứng cho ma trận ưu tiên kể cả khi LLM không phân loại.
7. **Trích mã CRM và định danh**: Nhận diện mã CRM từ dòng độc lập (7–10 chữ số không bắt đầu bằng số 0) và lấy mã đầu tiên xuất hiện khi có nhiều dòng phù hợp.

## Đường lùi khi LLM chết (E5 / TECH-1146)

1. **Chuỗi model dự phòng**: Tham số `model` trong `LlmConfig` chấp nhận danh sách tên model cách nhau bởi dấu phẩy (ví dụ: `"model-chinh,model-du-phong"`). Khi gặp lỗi 5xx, 429 hoặc lỗi mạng, hệ thống tự động thử model tiếp theo.
2. **Dừng sớm khi lỗi client hoặc bị từ chối**: Khi gặp lỗi HTTP 4xx (khác 429) hoặc khi model kích hoạt bộ lọc nội dung (`LlmContentFilterError`), chuỗi thử lại dừng ngay lập tức để tránh lãng phí chi phí.
3. **Hỏi lại đúng một lần**: Khi model trả về chuỗi không phải JSON hợp lệ hoặc không khớp schema Zod, hệ thống gửi yêu cầu hỏi lại đúng một lần kèm danh sách lỗi cụ thể trước khi chấp nhận thất bại.
4. **Xoá tiêu đề dự phòng (TECH-1146)**: Khi toàn bộ chuỗi model thất bại (LLM exhausted), hệ thống rơi về nhánh trích xuất heuristic và **xoá tiêu đề**, giữ nguyên mô tả và triệu chứng để không bao giờ bịa tiêu đề từ dòng đầu tiên (tránh lấy nhầm tên người báo hoặc mã định danh làm tiêu đề).

## Ranh giới miền (Domain Boundary)

Theo nguyên tắc kiến trúc RFC 0002:
- **Core sở hữu logic và cấu trúc**: engine trạng thái, bộ gộp trường, bộ trích xuất heuristic tiếng Việt chung, và cơ chế chuyển đổi dự phòng.
- **App sở hữu dữ liệu nghiệp vụ**: danh mục sản phẩm, hệ thống, nhóm lỗi, và từ điển từ đồng nghĩa theo miền (`SYSTEM_SYNONYMS`, `DEPT_SYNONYMS`).
- Tại PR 5, core cung cấp sẵn danh mục mặc định tương thích với legacy để phục vụ kiểm thử đối chiếu (parity). App có thể và nên cung cấp `domain` hoàn chỉnh thông qua `FieldExtractorOptions` (sẽ được cấu hình chính thức từ app ở PR 14).
