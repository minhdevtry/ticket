# Đóng góp

## Quy trình

1. Tạo nhánh từ `main`: `feat/<chủ-đề>`, `fix/<chủ-đề>`, `chore/<chủ-đề>`, `docs/<chủ-đề>`.
2. Commit theo [Conventional Commits](https://www.conventionalcommits.org): `feat(tieulinh): ...`, `fix(core): ...`, `docs: ...`. Scope là tên package: `core`, `tieulinh`, `deploy`, `ci`.
3. Chạy `bun run verify` trước khi đẩy (có gồm kiểm docs nhanh).
4. Mở Pull Request vào `main`. CI phải xanh (`verify`, `secrets`, `docs`, `docs-required`). Squash merge.

## Quy ước code

- TypeScript strict, chạy bằng Bun. Format và lint bằng Biome (`bun run format`).
- Test đặt cạnh file nguồn: `foo.ts` → `foo.test.ts`. Test không được gọi dịch vụ thật; `test-preload.ts` xoá biến môi trường thật trước khi chạy.
- Config đọc từ biến môi trường, kiểm tra khi khởi động; thiếu thì dừng với thông báo rõ ràng.
- Thay đổi `packages/core` là thay đổi cho mọi bot: thêm test, ghi vào `packages/core/CHANGELOG.md`, cập nhật docs.
- Quyết định kiến trúc quan trọng → viết ADR ngắn trong `docs/adr` (bối cảnh, quyết định, hệ quả, phương án đã loại).

## Tài liệu

Site docs (VitePress, tiếng Việt, định danh code giữ tiếng Anh) nằm ở `docs/` và được publish lên GitHub Pages khi `main` đổi. Docs sai còn tệ hơn không có docs, nên độ tươi của docs do CI giữ chứ không dựa vào thiện chí.

### Quy tắc

- **Mọi thay đổi hành vi hoặc API công khai cập nhật docs trong cùng PR.** Gồm `packages/*/src`, các file hành vi của app (`mcp`, `worker`, `lib`, `skills`, `openclaw`, `openclaw-plugin`) và `deploy/`. Đổi API của `packages/core` thì ghi thêm `packages/core/CHANGELOG.md`.
- Docs theo [Diátaxis](https://diataxis.fr): `guide/` (học), `how-to/` (làm một việc), `reference/` (tra cứu), `explanation/` (hiểu vì sao). Đặt trang đúng chỗ, và thêm vào sidebar trong `docs/.vitepress/config.ts` (CI báo lỗi trang mồ côi).
- **Không chép tay thứ code đã biết.** Chữ ký hàm, kiểu, tham số: để TypeDoc sinh (viết TSDoc ở code). Danh sách CopyKey sinh từ code. Biến môi trường, sự kiện webhook, subpath thì ghi ở trang tra cứu tương ứng và CI đối chiếu với code.
- Trang chưa viết được vì API chưa có thì ghi rõ "đang viết" hoặc "đang thiết kế", đừng đoán chữ ký.
- Ví dụ trong docs dùng dữ liệu giả (`10.0.0.x`, `*.example.com`, chat ID `-1000000000001`, số `0900000000`...). `bun run scan` quét cả docs.
- Nhãn **`no-docs`** chỉ dành cho refactor thuần và thay đổi chỉ trong test (hành vi không đổi). Đừng dùng để né việc cập nhật docs; maintainer sẽ gỡ nhãn khi dùng sai.

### Mẫu code có kiểm

Mọi khối ```` ```ts ```` trong `docs/` phải có đúng một cờ sau tên ngôn ngữ, nếu không CI đỏ:

| Cờ | Ý nghĩa |
|---|---|
| ```` ```ts check ```` | Được trích ra và typecheck với package thật (`@vuihoc/bot-core/*` ánh xạ từ `exports`). Mẫu phải tự đứng được: import đầy đủ, dùng `declare const x: T;` cho thứ ví dụ chỉ giả định có sẵn. |
| ```` ```ts run ```` | Typecheck rồi chạy bằng Bun; thoát khác 0 (ví dụ `assert` sai) là lỗi. Dùng khi muốn khẳng định giá trị. Không gọi mạng hay dịch vụ thật. |
| ```` ```ts no-check ```` | Minh hoạ không biên dịch được (giả mã). Dùng rất ít, và đừng dùng chỉ để qua mặt CI. |

Chạy riêng: `bun run docs:snippets`.

### Xem trước và kiểm

```bash
bun run docs:dev       # sinh trang tự động rồi mở site ở máy bạn
bun run docs:build     # build site (link chết là lỗi; TypeDoc có cảnh báo là lỗi)
bun run docs:check     # build + mẫu code + đối chiếu docs với code (giống CI)
```

`bun run verify` chỉ chạy phần nhanh (`docs:snippets`, `docs:refs`, test của script docs). Build site và TypeDoc nặng hơn nên chỉ chạy đầy đủ ở job `docs` của CI và ở `docs:check`. Máy dev yếu thì chạy `docs:check` trên máy khác như mục dưới.

### CI kiểm gì

| Job hoặc bước | Fail khi |
|---|---|
| `docs` > `vitepress build` | Có link chết (không đặt `ignoreDeadLinks`) |
| `docs` > TypeDoc (`docs/typedoc.json`) | Có cảnh báo: kiểu được tham chiếu mà không export, `{@link}` hỏng |
| `docs` > `scripts/check-doc-snippets.ts` | Mẫu `ts check` hoặc `ts run` lỗi kiểu hoặc lỗi chạy; khối `ts` thiếu cờ |
| `docs` > `scripts/check-docs-refs.ts` | Đường dẫn trong docs không tồn tại; subpath lạ hoặc subpath mới chưa mô tả; biến môi trường hoặc sự kiện webhook lệch code; trang không có trong sidebar |
| `docs-required` > `scripts/check-docs-touched.ts` | PR đổi file hành vi công khai mà không đụng `docs/**` hay `CHANGELOG.md`, và không có nhãn `no-docs` |

Gắn hoặc gỡ nhãn `no-docs` tự chạy lại job `docs-required`.

## Chạy việc nặng ngoài máy dev

Máy dev yếu có thể đẩy `bun install`/`bun test` sang máy khác (ví dụ Colab qua `crun`). Chỉ code được đồng bộ; secret và DB không bao giờ rời máy dev. Với docs: `bun install && bun run verify && bun run docs:check` trên máy đó.
