# Ma Trận Xác Định Mức Ưu Tiên (Priority Matrix)

Tài liệu tham chiếu bảng luật và chứng cứ đối soát cho công cụ `assess_priority`.

## 1. Các Mức Ưu Tiên

Bốn mức chuẩn: `Low`, `Medium`, `High`, `Urgent`.

## 2. Các Bằng Chứng Thu Thập (Evidence)

| Bằng chứng | Kiểu | Ý nghĩa kiểm tra |
| :--- | :---: | :--- |
| `scope` | `single_user` \| `group` \| `entire_system` | Lỗi ảnh hưởng 1 người, một nhóm hay toàn hệ thống. |
| `blocksPayment` | boolean | Người dùng không thể hoàn tất giao dịch nạp tiền / thanh toán. |
| `blocksLearning` | boolean | Học sinh đã thanh toán nhưng không vào học được hoặc chưa được xếp lớp. |
| `dataLoss` | boolean | Dữ liệu bị mất hoặc sai lệch không thể khôi phục lại. |
| `reconciliationMismatch` | boolean | Tiền đã chạy nhưng lệch số liệu doanh thu / đối soát kế toán. |
| `hasWorkaround` | boolean | Có phương án tạm thời để đi vòng (tạo tay, chờ đồng bộ). |
| `singleDeviceOnly` | boolean | Đổi thiết bị hoặc mạng khác thì hết lỗi (chỉ bị trên 1 máy cá nhân). |

## 3. Quy Tắc Sàn (Floors - Tối Thiểu)

Khi thỏa mãn điều kiện, mức ưu tiên không được thấp hơn mức sàn:

- `blocksPayment: true` -> **Tối thiểu Urgent** (Dòng tiền bị chặn).
- `blocksLearning: true` -> **Tối thiểu Urgent** (Học sinh bị chặn học).
- `dataLoss: true` -> **Tối thiểu Urgent** (Mất mát dữ liệu không lùi lại được).
- `scope: "entire_system"` -> **Tối thiểu Urgent** (Cả hệ thống bị ảnh hưởng).
- `reconciliationMismatch: true` -> **Tối thiểu High** (Lệch số liệu kế toán cần xử lý trong ngày).

## 4. Quy Tắc Trần (Ceilings - Tối Đa)

Ngăn chặn việc gán mức Urgent bừa bãi khi người dùng giục giã nhưng thực tế không nghiêm trọng:

- `singleDeviceOnly: true` VÀ `hasWorkaround: true` -> **Tối đa Low** (Chỉ là lỗi cấu hình thiết bị cá nhân và có cách đi vòng).
- `scope: "single_user"` VÀ `hasWorkaround: true` -> **Tối đa High** (Vấn đề của một người và vẫn có cách xử lý tạm thời).

## 5. Nguyên Tắc Sàn Thắng Trần

Nếu xung đột giữa sàn và trần (ví dụ: bị chặn thanh toán nhưng chỉ một người bị và có cách thử lại), **Sàn luôn thắng Trần** -> Ticket vẫn được xếp mức **Urgent**.
