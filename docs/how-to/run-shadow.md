# Chạy shadow

"Shadow" là chạy cái mới song song với cái đang chạy thật để so kết quả mà không để cái mới tác động. Repo hiện có một công cụ shadow, và chế độ shadow cho bot chạy thật thì chưa có.

## Đã có: harness shadow-parity (công cụ của maintainer)

`packages/core/scripts/shadow-parity.ts` kiểm chứng việc thay module của một bot bằng module của thư viện: chép bot đang chạy thật ra thư mục tạm, thay các module được chọn bằng shim re-export từ thư viện, chạy `bun test` trong bản chép rồi so với baseline đã ghi. Bản thật chỉ được **đọc**, không bao giờ bị cài đặt hay ghi.

```bash
cd packages/core
bun run scripts/shadow-parity.ts                       # chạy shadow + so baseline
bun run scripts/shadow-parity.ts --no-baseline         # bỏ lần chạy baseline
bun run scripts/shadow-parity.ts --lib /path/to/lib    # đổi đường dẫn thư viện
bun run scripts/shadow-parity.ts --engine              # thêm đối chiếu kịch bản của engine hội thoại
```

Biến môi trường (tuỳ chọn): `PARITY_REPOS_DIR` (thư mục chứa các bản checkout bot thật), `PARITY_SRC` (bot cần shadow), `PARITY_SCRATCH` (thư mục tạm, mặc định `/tmp`).

::: warning Giới hạn
Đây là công cụ của maintainer: nó cần các bản checkout bot nằm ngoài repo này (kho riêng, không công khai), nên người ngoài không chạy lại được. Nó phục vụ đợt chuyển Tiểu Linh sang thư viện (xem [Chuyển Tiểu Linh sang bot-core](/how-to/migrate-tieulinh)). Kết quả được ghi vào `packages/core/docs/parity/REPORT.md` và `packages/core/docs/parity/ENGINE.md`; coi chúng là ảnh chụp tại thời điểm chạy, không phải trạng thái hiện tại.
:::

Báo cáo gần nhất: [REPORT.md](https://github.com/minhdevtry/ticket/blob/main/packages/core/docs/parity/REPORT.md) và [ENGINE.md](https://github.com/minhdevtry/ticket/blob/main/packages/core/docs/parity/ENGINE.md).

## Đã có cho Tiểu Linh 2: chạy bóng song song với bot đang live

Tiểu Linh 2 chạy bóng trên Colab: nhận bản sao mỗi tin mà Tiểu Linh 1 nhận, không có kênh Telegram nên không nhắn người dùng thật, rồi ghép hai câu trả lời để so. Cách dựng, mô hình an toàn và cách cài plugin: [Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2).

## Đang viết: shadow dùng chung cho mọi bot

::: warning Đang viết
Chế độ shadow dùng chung cho bot dựng trên thư viện (nhận cùng sự kiện nhưng không gửi tin, không ghi ticket, chỉ log việc nó sẽ làm) chưa tồn tại. Nó gắn với `defineBot` và vai hậu cần, hai thứ còn **đang thiết kế**, nên trang này chưa mô tả cách bật. Phần chạy bóng Tiểu Linh 2 ở trên là giải pháp riêng cho một bot, không phải chế độ chung đó.
:::

Trong khi chờ, có hai cách an toàn gần với shadow đã có sẵn trong code:

- `RELATED_CURATOR=dry` (mặc định) ở worker Tiểu Linh: chỉ log kế hoạch chốt ticket tương tự, không ghi vào itsaplan. Xem [biến môi trường](/reference/config-env).
- Test dispatcher không cần mạng, xem [Dựng worker báo ngược](/how-to/notify-worker).
