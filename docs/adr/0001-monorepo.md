# ADR-0001: Monorepo cho bot-core và các bot

- Trạng thái: chấp nhận
- Ngày: 2026-10-24

## Bối cảnh

`@vuihoc/bot-core` nằm ở repo riêng. Các bot tiêu thụ nó bằng tag git qua SSH. Thực tế cho thấy:

- Mỗi lần sửa thư viện phải tag, bump, và cài lại ở từng bot. Bun hay báo `no commit matching` do cache.
- Các bot chép tay một số module của thư viện thay vì import (logger, tool-error, buttons), nên bản chép trôi dần khỏi bản gốc.
- Tiểu Linh, bot lớn nhất, chưa dùng thư viện. Bài thử parity (thay 32 module) đã pass hoàn toàn nhưng chưa được áp dụng.

## Quyết định

Gộp thư viện và các bot vào một monorepo Bun workspaces:

- `packages/core` chứa thư viện.
- `apps/<bot>` chứa từng bot, phụ thuộc `"@vuihoc/bot-core": "workspace:*"`.

Tiểu Linh là bot đầu tiên. OP, PO, CM sẽ chuyển vào sau.

## Hệ quả

- Sửa thư viện và bot trong cùng một PR. CI chạy test của cả hai.
- Không còn tag git cho thư viện. Phiên bản thư viện chỉ còn ý nghĩa ghi chép (CHANGELOG).
- Các bot cũ ngoài repo (operationbot) vẫn ghim `vhitsaplanbot#v0.8.0` cho đến khi chuyển vào đây.

## Phương án đã loại

- Giữ repo riêng và publish lên npm: thêm khâu phát hành, mà mỗi thay đổi vẫn phải đi qua hai repo.
- Git submodule: khó dùng và dễ lệch commit.
