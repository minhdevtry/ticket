# Script kiểm thử chạy tay

Các file `test-*.ts` trong thư mục này **không** chạy dưới `bun test`, và đó là
chủ ý — không phải sơ suất:

- Tên `test-*.ts` không khớp glob `*.test.ts` của runner, nên `bun test`
  không thấy chúng.
- Chúng gọi thẳng Itsaplan, Onyx và worker đang chạy thật. Để runner tự động
  chạy nghĩa là mỗi lần chạy test là một lần đụng hệ thống production.

Chạy tay khi cần, từ thư mục gốc của repo:

```bash
bun run --cwd apps/tieulinh-legacy live:tieulinh          # Tiểu Linh trên hạ tầng thật
```

Phần khung dùng chung (`assert`, bộ đếm, nạp `.env`) nằm ở [`harness.ts`](./harness.ts),
và **có** test chạy dưới `bun test` tại `harness.test.ts`.

Lưu ý `live:tieulinh` tạo ticket thật trên Itsaplan; ticket vẫn còn lại sau khi chạy.
