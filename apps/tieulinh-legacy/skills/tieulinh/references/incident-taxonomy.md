# Danh Mục Chuẩn Sự Cố Kỹ Thuật (Incident Taxonomy)

Tài liệu tham chiếu chuẩn hoá danh mục cho Tiểu Linh và công cụ `validate_fields`.

## 1. Hệ Thống (System - 15 giá trị chuẩn)

Áp dụng khi điền trường `category` hoặc đối soát hệ thống:

1. `Vuihoc (App/Web_Vuihoc + ERP_DUO)`
2. `App_THPT`
3. `LMS_Vuihoc`
4. `CRM_Vuihoc`
5. `TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)`
6. `Thi thử ĐGNL`
7. `ClassIn`
8. `CARE_Vuihoc`
9. `Bitu Chat`
10. `Survery Platform`
11. `OMS_Vuihoc`
12. `Bizfly_Vuihoc`
13. `K12 Viettel`
14. `VNESCHOOL`
15. `Khác (liên quan bên IT)`

## 2. Sản Phẩm (Product - 9 giá trị chuẩn)

1. `Tự học`
2. `Duo`
3. `Pas`
4. `Tutor`
5. `Exam`
6. `VNESchool`
7. `K12 Viettel`
8. `Smart Media`
9. `Khác`

## 3. Phân Loại Lỗi (Error Category - 11 loại)

1. `Lỗi hệ thống` (sập server, mất kết nối API, 502/504)
2. `Lỗi kỹ thuật` (tính năng không chạy, nút bấm không phản hồi)
3. `Lỗi dữ liệu` (sai số liệu, mất dữ liệu, không lưu kết quả)
4. `Lỗi bên thứ 3` (cổng thanh toán, mạng Viettel, ClassIn gián đoạn)
5. `Lỗi chưa xác định` (chưa đủ thông tin truy nguyên nhân)
6. `Hỗ trợ` (cần can thiệp kỹ thuật mở quyền, reset)
7. `Lỗi cấu hình máy` (camera, micro, phân quyền trình duyệt người dùng)
8. `Cải tiến sản phẩm` (góp ý luồng vận hành)
9. `ND bị nhầm hoặc hiểu sai` (thao tác chưa đúng hướng dẫn)
10. `Lỗi nhập liệu` (nhập sai định dạng trên CRM/OMS)
11. `Khác`

## 4. Thiết Bị & Bộ Phận

- **Thiết bị (`device_type`):** `Điện thoại`, `Máy tính bảng`, `PC`, `Laptop`
- **Bộ phận báo (`reporting_dept`):** `Vận hành`, `Vận đơn`, `CSKH`, `CSHV`, `Chuyên môn`, `Sale`, `Quản lý lớp`

## 5. Quy Chuẩn Name Code Nhân Sự

- **Regex:** `^[A-Z]{2,4}_[A-Za-z0-9_]+$`
- **Ví dụ hợp lệ:** `TE_anh_a`, `CS_user_a`, `PO_user_b`, `VH_admin`
- **Quy tắc:** Bắt đầu bằng 2-4 chữ hoa mã bộ phận, gạch dưới, và tên nhân sự.

## 6. Gợi Ý Thu Thập Thông Tin Theo Ngữ Cảnh

- **LiveClass / Tutor:** Cần mã phòng học (`roomId`) hoặc số điện thoại phụ huynh / mã học sinh (`studentId`).
- **App / Duo / Pas:** Cần thiết bị sử dụng (`device`) và phiên bản hệ điều hành (`device_os`).
- **Web / LMS / CRM:** Cần tài khoản người dùng gặp lỗi.
- **Sự cố toàn hệ thống (Server sập, 502):** Không yêu cầu tài khoản cá nhân.

## 7. Trạng Thái Ticket (Thuần Việt cho Người Dùng Non-Tech)

Các trạng thái hiển thị tới người dùng, tuyệt đối không dùng tiếng Anh kỹ thuật hay icon:

1. **Mới tiếp nhận:** Ticket vừa được tạo, đang nằm trong hàng đợi tiếp nhận.
2. **Chờ xử lý:** Đã ghi nhận và chuẩn bị đưa vào ca xử lý.
3. **Đang xử lý:** Kỹ thuật viên đang trực tiếp điều tra và khắc phục sự cố.
4. **Đã xử lý:** Kỹ thuật đã xử lý xong và gửi thông báo về. Người báo kiểm tra lại; ổn thì bấm "👍 Đã ổn" (chỉ ghi nhận ý kiến), chưa ổn thì nhắn lại. Ticket vẫn nằm ở đây chờ chuyên viên kiểm tra.
5. **Hoàn tất:** Chuyên viên đã kiểm tra và đóng ticket. Chỉ chuyên viên mới đóng ticket; bot và người báo không tự đóng.
6. **Đã hủy:** Ticket bị hủy do trùng lặp hoặc người báo thao tác nhầm.
