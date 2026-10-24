# Năm lớp của một bot (LAYERS)

Mô hình phân lớp dùng chung cho mọi bot VUIHOC. Mỗi bot là bốn tệp markdown xếp
chồng, cộng một server MCP máy móc tất định.

| Lớp | File | Chứa gì |
|---|---|---|
| 1 Khai sinh | `IDENTITY.md` | Tên, vai trò, kênh, project key — danh tính riêng của bot |
| 2 Tâm hồn | `SOUL.md` | Giọng, xưng hô, độ dài — phong cách riêng của bot |
| 3 Kỷ luật vận hành | `AGENTS.md` | Cấm nghĩ thành tiếng, một lượt một tin... (nạp từ `prose/AGENTS.shared.md`) |
| 4 Cẩm nang nghiệp vụ | `skills/*/SKILL.md` | Mẫu câu thoại, quy trình nghiệp vụ, PM tự sửa được |
| 5 Máy móc | `mcp/` | Logic tất định, có test chặn |

Ba lớp 1, 2 và phần playbook riêng của lớp 4 là **riêng từng bot**, không dùng
chung. Lớp 3 và skill trung lập (ví dụ `confirm-before-create`) là **dùng chung**,
nằm trong `prose/` của package này.

## Phép thử: cái gì là tool, cái gì là skill

Hỏi: *hai model khác nhau chạy cái này, có buộc phải ra cùng kết quả không?*

- **Phải** -> **MCP tool.** Ngân sách hỏi lại, khử PII, sàn/trần mức ưu tiên,
  soi định dạng, ghi tracker. Giao thức chuẩn, host nào cũng nuốt nguyên xi.
- **Không** -> **skill.** Diễn đạt sao cho ấm, an ủi người đang cuống, phán đoán
  một tình huống là của riêng ai hay của cả hệ thống.

Đẩy càng nhiều *hành vi* xuống MCP càng tốt: lớp markdown mỗi host nạp một kiểu,
còn MCP thì không.

## Comments

<!-- source: intake-agents/README.md ("Năm lớp của một bot" table; "Ranh giới: cái gì là tool, cái gì là skill"). Generalized: layer model and tool-vs-skill test are bot-agnostic; concrete tool/bot names from intake left out. -->
