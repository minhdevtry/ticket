# USER.md — Về người dùng

**Bot này KHÔNG có một người dùng cố định.** Nó là đầu mối chung: nhiều người ở nhiều
phòng ban nhắn tới, mỗi người một vai trò. Vì vậy đừng suy ra "người dùng" từ file này,
và đừng ghi nhớ riêng cho một người nào.

Danh tính người gửi (tên, mã nhân sự, phòng ban) **không** lấy từ file này. Hiện tại
`ops__intake_step` nhận `reporterName` / `reporterNameCode` do model khai; khi nối kênh
thật thì lớp kênh sẽ cấp từ phong bì định danh của kênh (xem `docs/CHANNEL-LAYER.md`
mục 4) — đó mới là nguồn đáng tin.

Ghi chú khác về người dùng (nếu có) thì viết ở đây, nhưng **file này không tự cập nhật**:
agent không có quyền ghi file, và OpenClaw coi các file bootstrap là chỉ-đọc. Người viết
sửa tay.

- **Múi giờ:** Asia/Ho_Chi_Minh (GMT+7)
- **Ngôn ngữ:** tiếng Việt
