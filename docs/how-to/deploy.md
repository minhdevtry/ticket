# Deploy và đẩy secret qua SSH

Bot chạy như một dịch vụ trên máy chủ. **Code lấy từ git, secret đẩy qua SSH**, không bao giờ đi qua git (ADR-0003 cấp repo, xem [chỉ mục ADR](/explanation/adr-index)). Repo công khai nên đây là ranh giới cứng: xem [Bảo mật repo công khai](/explanation/public-repo-security).

## Nguyên tắc

- Repo chỉ chứa `.env.example` (tên biến, giá trị mẫu). File `.env` thật nằm ở máy maintainer.
- Secret được đẩy lên máy chạy bằng `deploy/push-secrets.sh` qua SSH, quyền `600`, đặt **ngoài** thư mục repo trên máy chạy.
- Repo không bao giờ cần secret để build hay test; test chạy với env đã bị xoá sạch.
- Máy chạy phụ (ví dụ Colab để chạy test) không bao giờ nhận secret.

Danh sách biến cần đặt: [Cấu hình và biến môi trường](/reference/config-env).

## Lần đầu trên máy chạy

```bash
git clone https://github.com/minhdevtry/ticket.git ~/apps/ticket
cd ~/apps/ticket && bun install --production
```

## Đẩy secret từ máy maintainer

```bash
deploy/push-secrets.sh <ssh-host> apps/tieulinh-legacy/.env tieulinh
# kết quả: <ssh-host>:~/.config/ticket/tieulinh.env, chmod 600
```

Script (`deploy/push-secrets.sh`) làm đúng bốn việc: tạo `~/.config/ticket` với `umask 077`, `scp` file lên tên tạm `.env.tmp`, `chmod 600` rồi `mv` sang tên cuối (đổi tên nguyên tử, nên tiến trình đọc không bao giờ thấy file dở dang). Tên app chỉ nhận chữ thường, số và dấu gạch ngang.

Đổi secret không cần commit: đẩy lại rồi khởi động lại dịch vụ.

## Cập nhật code

```bash
ssh <ssh-host> 'cd ~/apps/ticket && git pull --ff-only && bun install --production && systemctl --user restart <unit>'
```

`--ff-only` làm lệnh dừng thay vì trộn lung tung nếu máy chạy có commit lạ.

## Chạy dưới systemd

Bot chạy dưới dạng **systemd user service**; unit đọc secret qua `EnvironmentFile=` trỏ vào `~/.config/ticket/<app>.env` (ADR-0003).

::: warning Đang viết
Repo hiện **chưa** chứa file unit hay template unit, và chưa có quy trình rollback hay kiểm sức khoẻ sau deploy được viết ra. Khi có, chúng sẽ nằm trong `deploy/` và trang này sẽ mô tả. Đừng suy diễn từ đây rằng có sẵn unit để dùng.
:::

## Kiểm sau khi deploy

Những gì kiểm được từ code hiện có:

- Worker lên: `GET /health` trên cổng `WEBHOOK_PORT` trả `{"status":"ok"}`.
- Webhook itsaplan đang bật: `GET /projects/<KEY>/webhooks` thấy webhook `isActive`.
- Worker không trỏ nhầm DB: log lúc khởi động của `startIntakeWorker` (khi truyền `dbPath`) in file DB thật và số binding; số 0 gần như chắc chắn là trỏ nhầm.
