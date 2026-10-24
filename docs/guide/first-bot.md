# Dựng bot đầu tiên

::: warning Đang viết
Trang này chưa có hướng dẫn từng bước. Lý do: cách dựng một bot sẽ đi qua `defineBot({...})`, API này **đang thiết kế** và chưa có chữ ký ổn định. Viết hướng dẫn trước khi API chốt là tạo ra docs sai, nên chúng tôi để trống thay vì đoán.
:::

## Trang này sẽ gồm

Khi `defineBot` chốt, trang sẽ dẫn một người mới từ thư mục trống tới một bot chạy được, theo thứ tự:

1. Khai báo bot: tên, project itsaplan, kênh chat.
2. Vai lễ tân: viết catalog trường cần hỏi, bộ chuỗi `CopyCatalog`, luật ưu tiên.
3. Vai hậu cần: trigger và rule đầu tiên.
4. Chạy thử không dịch vụ thật (shadow), rồi deploy.

Mỗi bước sẽ có mẫu code được CI typecheck (xem [quy ước mẫu code](https://github.com/minhdevtry/ticket/blob/main/CONTRIBUTING.md)), nên lúc trang được viết thì nó đã đúng với API thật.

## Làm được gì hôm nay

Chưa có khai báo một dòng, nhưng từng mảnh đã dùng được và được mô tả ở [Cách làm](/how-to/):

| Việc | Trang |
|---|---|
| Mô tả các trường bot phải hỏi, kiểm tra đủ/thiếu | [Viết catalog tiếp nhận](/how-to/write-catalog) |
| Nối một kênh chat mới vào engine và báo ngược | [Thêm kênh chat](/how-to/add-channel) |
| Chạy webhook itsaplan, báo ngược về chat, reply thành comment | [Dựng worker báo ngược](/how-to/notify-worker) |
| Đưa bot lên máy chạy, đẩy secret an toàn | [Deploy và đẩy secret qua SSH](/how-to/deploy) |

Bản thiết kế tổng thể (hai vai, trigger, rule) ở [Kiến trúc: lễ tân và hậu cần](/explanation/architecture).
