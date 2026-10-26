# Bản đồ ngữ cảnh

Repo này có nhiều ngữ cảnh: mỗi package và app là một ngữ cảnh riêng, dùng chung một số từ nhưng mang nghĩa khác nhau. File này trỏ tới `GLOSSARY.md` của từng ngữ cảnh; đọc glossary của ngữ cảnh đang làm việc trước khi dùng từ.

## Contexts

- [bot-core](./packages/core/GLOSSARY.md): thư viện dùng chung cho mọi bot — bot kit (`defineBot`/`createBot`), pack và harness, engine tiếp nhận, cổng, tờ khai, binding, bản ghi vàng.
- [Tiểu Linh mới](./apps/tieulinh/GLOSSARY.md): app hậu cần — người báo, người xử lý, vòng đời ticket, nút "Đã ổn", ticket trùng, ticket liên quan, quá hạn SLA, kênh gửi tin.
- [Tiểu Linh legacy](./apps/tieulinh-legacy/GLOSSARY.md): bản tham chiếu đóng băng — lễ tân trong `pipeline.ts`, hợp đồng `intake_step`, tờ khai, định danh, gác tờ khai, tách báo cáo, soát thông tin, mức ưu tiên, plugin OpenClaw.
- [tl2-shadow](./tools/tl2-shadow/GLOSSARY.md): bộ chạy bóng — relay, hàng đợi, proxy giữ secret, tunnel, gateway Colab, lớp lệch S0/S1/S2, chỉ số M0–M7.

## Relationships

- **bot-core → Tiểu Linh mới**: app khai báo bot bằng `defineBot`; thứ dùng lại được nhiều bot đẩy vào core thay vì chép sang app.
- **bot-core ↔ Tiểu Linh legacy**: core đang chuyển hành vi lễ tân của legacy vào engine tất định, giữ nguyên hợp đồng `intake_step` để persona và skill cũ không phải sửa.
- **Tiểu Linh legacy → Tiểu Linh mới**: legacy là chân lý để so; cơ chế chống mất hành vi là sổ đối chiếu (mỗi test legacy một dòng) và bản ghi vàng (kịch bản vào/ra).
- **tl2-shadow → cả hai**: bóng chạy bản mới cạnh bản legacy trên tin thật, chấm lệch theo từng lượt; kết quả là thông tin cho chủ quyết định, không phải cổng tự động.
