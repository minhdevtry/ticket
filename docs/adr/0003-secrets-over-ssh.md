# ADR-0003: Secret và config máy chạy đẩy qua SSH

- Trạng thái: chấp nhận
- Ngày: 2026-10-24

## Quyết định

Repo chỉ chứa `.env.example` (tên biến, giá trị mẫu). File `.env` thật nằm ở máy maintainer, được đẩy lên máy chạy bằng `deploy/push-secrets.sh` qua SSH, với quyền `600`, đặt ngoài thư mục repo trên máy chạy. Unit systemd đọc nó qua `EnvironmentFile=`.

## Hệ quả

- Repo không bao giờ cần secret để build hay test. Test chạy với env đã bị xoá sạch.
- Đổi secret không cần commit.
- Máy chạy phụ (ví dụ Colab dùng để chạy test) không bao giờ nhận secret.
