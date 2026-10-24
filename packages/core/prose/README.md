# prose

Tầng markdown dùng chung cho lớp hướng dẫn của các bot VUIHOC. Chỉ chứa những gì
trung lập về nghiệp vụ — không tên bot, không project key, không sản phẩm, không
số điện thoại.

## Có gì ở đây

- `AGENTS.shared.md` — quy tắc vận hành chung (một lượt một tin, cấm nghĩ thành
  tiếng, không bịa, hỏi gộp một lần, kỷ luật icon, không khẳng định khi tool
  chưa xác nhận, danh tính là của hệ thống, bảo mật thắng nguyên văn).
- `skills/confirm-before-create/SKILL.md` — skill an toàn: xác nhận trước khi tạo
  bản ghi mới.

## Bot nạp prose thế nào

Package này publish `prose/` qua subpath export `./prose/*` trong `package.json`.
Sau khi một bot workspace cài `@vuihoc/bot-core`, một script đồng bộ của bot sao
chép các tệp từ:

```
node_modules/@vuihoc/bot-core/prose/
```

vào đúng chỗ lớp markdown của bot đó (ví dụ chép `AGENTS.shared.md` thành phần
nền của `AGENTS.md`, và `skills/confirm-before-create/` vào thư mục skills của
bot). Prose là nguồn chung; bot chỉ sao chép, không sửa tại chỗ trong
`node_modules`.

## Ranh giới

Phần **riêng từng bot** — `IDENTITY.md`, `SOUL.md`, và các playbook sản phẩm —
**ở lại trong chính bot đó**, không đưa vào đây. Prose chỉ giữ phần dùng chung.

Mô hình năm lớp của một bot và phép thử tool-vs-skill: xem trang [Năm lớp của một bot](https://minhdevtry.github.io/ticket/explanation/layers) trong site docs (nguồn `docs/explanation/layers.md`).
