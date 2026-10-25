# Năm lớp của một bot

Mô hình phân lớp cho phần hướng dẫn của một bot chạy trên OpenClaw. Mỗi bot là bốn tệp markdown xếp chồng, cộng một server MCP làm phần máy móc tất định.

| Lớp | File | Chứa gì |
|---|---|---|
| 1. Khai sinh | `IDENTITY.md` | Tên, vai trò, kênh, project key: danh tính riêng của bot |
| 2. Tâm hồn | `SOUL.md` | Giọng, xưng hô, độ dài: phong cách riêng của bot |
| 3. Kỷ luật vận hành | `AGENTS.md` | Cấm nghĩ thành tiếng, một lượt một tin... (nạp từ `prose/AGENTS.shared.md`) |
| 4. Cẩm nang nghiệp vụ | `skills/*/SKILL.md` | Mẫu câu thoại, quy trình nghiệp vụ; người phụ trách sản phẩm tự sửa được |
| 5. Máy móc | `mcp/` | Logic tất định, có test chặn |

Ba lớp riêng của từng bot: lớp 1, lớp 2 và phần playbook riêng của lớp 4. Lớp 3 và các skill trung lập (ví dụ `confirm-before-create`) dùng chung và nằm trong `packages/core/prose/`.

## Phép thử: cái gì là tool, cái gì là skill

Hỏi: *hai model khác nhau chạy cái này, có buộc phải ra cùng kết quả không?*

- **Phải**: viết thành **MCP tool**. Ngân sách hỏi lại, khử PII, sàn và trần mức ưu tiên, soi định dạng, ghi tracker. Giao thức chuẩn, host nào cũng nhận nguyên xi.
- **Không**: viết thành **skill**. Diễn đạt sao cho ấm, an ủi người đang cuống, phán đoán một tình huống là của riêng ai hay của cả hệ thống.

Đẩy càng nhiều *hành vi* xuống MCP càng tốt: lớp markdown mỗi host nạp một kiểu, còn MCP thì không.

## Bot nạp prose dùng chung thế nào

`@vuihoc/bot-core` mở thư mục `prose/` qua subpath `@vuihoc/bot-core/prose/*`. Một script đồng bộ của bot sao chép các tệp từ `node_modules/@vuihoc/bot-core/prose/` vào đúng chỗ lớp markdown của bot (ví dụ `AGENTS.shared.md` thành phần nền của `AGENTS.md`, `skills/confirm-before-create/` vào thư mục skills). Prose là nguồn chung: bot chỉ sao chép, không sửa tại chỗ trong `node_modules`. Với Tiểu Linh, việc đồng bộ chạy bằng `bun run --cwd apps/tieulinh-legacy openclaw:sync`.

Prose chỉ giữ phần trung lập về nghiệp vụ: không tên bot, không project key, không sản phẩm, không số điện thoại. Phần riêng của từng bot ở lại trong bot đó.
