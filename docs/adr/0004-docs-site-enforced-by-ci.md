# ADR-0004: Site docs tiếng Việt, độ tươi do CI giữ

- Trạng thái: chấp nhận
- Ngày: 2026-10-25

## Bối cảnh

Tài liệu rải rác ở bốn nơi (README package, `packages/core/docs`, `apps/tieulinh-legacy/docs`, `prose`), nhiều file mô tả quy trình đã bỏ (ghim tag git của repo cũ) hoặc chứa mẫu code sai (`new ItsaplanClient({ baseUrl, apiKey })` trong khi hàm tạo là `(baseUrl, apiKey, opts)`; `TelegramTransport({ token })` trong khi tham số là `botToken`). Docs sai còn tệ hơn không có docs.

## Quyết định

- Một site VitePress ở `docs/`, deploy lên GitHub Pages khi `main` đổi. Nội dung tiếng Việt; định danh code giữ tiếng Anh. Cấu trúc theo Diátaxis: hướng dẫn, cách làm, tra cứu, giải thích.
- Tài liệu API sinh bằng TypeDoc và `typedoc-plugin-markdown` từ các subpath của `packages/core`, lúc build, không commit. Danh sách CopyKey và chỉ mục ADR cũng sinh từ code.
- Độ tươi do CI giữ, không dựa vào thiện chí: build site với kiểm link chết; TypeDoc coi cảnh báo là lỗi; mọi khối `ts` trong docs phải khai cờ `check`, `run` hoặc `no-check` và được typecheck (hoặc chạy) với package thật; script đối chiếu đường dẫn, subpath, biến môi trường, sự kiện webhook với code; PR đổi hành vi công khai mà không đụng docs bị chặn, trừ nhãn `no-docs`.
- Phần chưa viết được vì API chưa có (`defineBot`, hậu cần) được ghi rõ "đang viết" hoặc "đang thiết kế", không đoán chữ ký.

## Hệ quả

- Thêm một job CI (`docs`) và một job nhẹ (`docs-required`). Build docs tốn thêm vài phút trên CI.
- Docs TypeDoc cần TypeScript 5.x, trong khi repo dùng TypeScript 7 cho typecheck: package `docs` khoá TypeScript 5.9.3 riêng cho TypeDoc.
- Mỗi PR đổi hành vi phải đi kèm docs; nhãn `no-docs` là lối thoát duy nhất và chỉ cho refactor thuần và test.
- Báo cáo parity sinh bởi harness (`packages/core/docs/parity`) và ADR của package/app ở lại cạnh code; site chỉ liên kết tới.

## Phương án đã loại

- Giữ docs rải rác và nhắc nhau cập nhật: chính cách này đã sinh ra mẫu code sai.
- Chép chữ ký API vào văn xuôi: lệch ngay khi code đổi; TypeDoc sinh từ code.
- Chỉ kiểm link mà không kiểm mẫu code: link đúng vẫn có thể dẫn tới mẫu sai.
