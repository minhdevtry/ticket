---
layout: home

hero:
  name: VuiHoc Ticket Bots
  text: Tài liệu cho bot-core và các bot xây trên nó
  tagline: Một thư viện chuẩn, hai vai trò cho mỗi bot (lễ tân và hậu cần), một nguồn sự thật là itsaplan.
  actions:
    - theme: brand
      text: Bắt đầu
      link: /guide/
    - theme: alt
      text: Tra cứu API
      link: /reference/
    - theme: alt
      text: Kiến trúc
      link: /explanation/architecture

features:
  - title: Hướng dẫn
    details: Từ con số 0 tới bot chạy được. Trang "Dựng bot đầu tiên" đang viết, chờ API defineBot.
    link: /guide/
  - title: Cách làm
    details: Từng việc cụ thể, có thể làm theo ngay. Viết catalog, thêm kênh, dựng worker báo ngược, deploy và đẩy secret qua SSH.
    link: /how-to/
  - title: Tra cứu
    details: API sinh tự động từ code bằng TypeDoc, biến môi trường, sự kiện webhook itsaplan, danh sách CopyKey.
    link: /reference/
  - title: Giải thích
    details: Vì sao kiến trúc là lễ tân và hậu cần, vì sao repo công khai, các ADR đã chốt.
    link: /explanation/
---

## Docs ở đây không được phép cũ

Docs sai còn tệ hơn không có docs, nên site này được CI giữ tươi chứ không dựa vào thiện chí:

- Link chết làm hỏng build.
- Trang API sinh từ code. TypeDoc có cảnh báo (thiếu export, `@link` hỏng) là CI đỏ.
- Mọi mẫu `ts` trong docs được typecheck với package thật (một số được chạy luôn).
- Biến môi trường, subpath, sự kiện webhook, đường dẫn file trong docs được đối chiếu với code.
- PR đổi hành vi công khai mà không đụng docs bị chặn, trừ khi có nhãn `no-docs`.

Chi tiết quy tắc viết và kiểm tra ở [CONTRIBUTING.md](https://github.com/minhdevtry/ticket/blob/main/CONTRIBUTING.md).
