# Đặc tả: Nâng tầm kiến trúc @vuihoc/bot-core — Starter Kit 15 phút & Tài liệu Tam Giác Vàng

## Context

Repo: `minhdevtry/ticket`. Nhiệm vụ kiến trúc nền tảng: Biến `@vuihoc/bot-core` thành framework tăng tốc dựng bot ("Zero-Friction Bot Builder") chuẩn mực cho toàn bộ các bot sau này tại VuiHoc (Tiểu Linh, OP Bot, PO Bot, CM Bot...).

- **Tam giác vàng bất biến**:
  1. **Intake (Kênh tiếp nhận)**: 99% dùng **Telegram** (người dùng/nhân viên nhắn tin).
  2. **Host (Nơi Agent chạy)**: Bắt buộc là **OpenClaw** cắm các mảnh ghép qua chuẩn: **MCP + Tools + Skills**.
  3. **Tracker (Quản trị)**: **Itsaplan v1.8** (Team, Project, Rules, Agent-Runs, Webhook).
- **Mục tiêu tối thượng**: Hoàn tất Tiểu Linh là phải có một thư viện xịn. Kỹ sư hoặc Agent khi dựng bot mới cho bất kỳ phòng ban nào chỉ mất **15 phút cấu hình** là có ngay một con bot cơ bản chạy được 100% (Telegram + OpenClaw + Itsaplan), sau đó chỉ việc tập trung viết nghiệp vụ riêng!

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `docs/explanation/bot-kit.md`, `packages/core/README.md`.
- `packages/core/src/bot/define.ts`, `create.ts`.
- `packages/core/examples/minimal-bot/`.

---

## Deliverables (Các thành phẩm bắt buộc)

### 1. Starter Kit chuẩn mực 15 phút (`packages/core/examples/starter-bot/`)
Dựng một bot mẫu hoàn chỉnh, chuẩn chỉnh từ A–Z để làm phôi cho mọi bot mới sau này:
- `bot.ts`: Khai báo 1 file nghiệp vụ duy nhất qua `defineBot`:
  - `id`: `"starter-bot"`.
  - `tracker`: `{ team: "tech", project: "TECH2" }`.
  - `persona`: Định nghĩa bộ câu chữ xưng hô chuẩn mực qua `makeCopyCatalog`.
  - `receptionist`: Cấu hình danh mục sự cố mẫu (`catalog`: 2 hệ thống, 2 lỗi, câu hỏi trường thiếu).
  - `backoffice`: Cấu hình handler phản hồi `@mention` và trigger `on.rule`.
- `main.ts`: Khởi chạy bot qua `createBot(bot, ...)` và `runBot(...)`.
- `starter.test.ts`: Bộ test tự động kiểm chứng 100% vòng đời của starter-bot:
  - Khai báo hợp lệ, `defineBot` pass không ném `BotDefinitionError`.
  - Xuất gói skill qua `exportSkillPack` ra đủ cấu trúc OpenClaw (`bot.json`, `AGENTS.md`, `skills/`).
  - Lễ tân chạy thử một lượt `intake_step` qua FakeLlm trả về kết quả cấu trúc chuẩn.
- `README.md`: Hướng dẫn ngắn gọn 3 bước để copy starter-bot này sang một app mới (`apps/<new-bot>`) và đổi tên thành bot phòng ban khác trong 15 phút.

### 2. Tài liệu Kiến trúc Tam Giác Vàng (`docs/explanation/bot-core-architecture.md`)
Soạn thảo tài liệu giải thích sâu về kiến trúc monorepo và bộ kit bot:
- **Định vị Stack**: Mô hình Tam Giác Vàng (Telegram + OpenClaw + Itsaplan v1.8) kèm biểu đồ Mermaid rõ nét.
- **4 Khối Tăng Tốc (Accelerators)**:
  1. *Telegram Accelerator*: Bóc phong bì tin nhắn, quản lý nút bấm inline, chống bấm đúp, khoá nút tự động.
  2. *Itsaplan Accelerator*: Kết nối Team/Project, nhận webhook HMAC, claim job `agent-runs`, xử lý heartbeat và retry có giới hạn.
  3. *OpenClaw Pack Generator*: Tự động sinh `openclaw.json`, nạp MCP tool, đồng bộ Skill Pack (Markdown persona/soul).
  4. *Bot Factory Framework*: API 1-file `defineBot` và `createBot`.
- **Nguyên tắc Ranh Giới 3 Lớp (The Boundary Test)**:
  - Cái gì thuộc Core (tất định, generic, tái sử dụng cho mọi bot).
  - Cái gì thuộc App (catalog riêng, copy xưng hô, rules riêng của phòng ban).
  - Cái gì thuộc Harness (kênh mạng Telegram, vòng suy luận LLM).

### 3. Cẩm nang 15 phút dựng Bot mới (`docs/guide/create-new-bot.md`)
Cẩm nang hướng dẫn thực hành step-by-step cho kỹ sư và coding agent:
- Bước 1: 15 phút Brainstorm & Khảo sát nghiệp vụ riêng (Catalog, Rules, Persona).
- Bước 2: Tạo thư mục `apps/<tên-bot>` từ starter-bot template.
- Bước 3: Khai báo file `bot.ts`.
- Bước 4: Chạy kiểm thử cục bộ và nạp vào OpenClaw.

### 4. Test Ranh Giới Kiến Trúc Deep Modules (`packages/core/src/core/boundary.test.ts`)
Viết một bộ test kiểm tra tự động để bảo vệ tính thuần khiết của thư viện:
- Kiểm tra toàn bộ mã nguồn trong `packages/core/src/`:
  - Tuyệt đối không import ngược từ `apps/**` vào core (`expect(src).not.toMatch(/from\s+["'][^"']*\/apps\//)`).
  - Không hardcode tên sản phẩm riêng của Tiểu Linh trong logic lõi (trừ test fixtures và fallback tên bot).
  - Đảm bảo các subpath export của core độc lập và không tạo vòng lặp phụ thuộc (circular dependencies).

---

## Ranh giới & Điều cấm (Worker Constraints)

- **Chỉ sửa trong**: `packages/core/examples/starter-bot/`, `packages/core/src/core/boundary.test.ts`, `docs/explanation/`, `docs/guide/`, `docs/.vitepress/config.mts`, `packages/core/CHANGELOG.md`.
- **CẤM**:
  - Không sửa mã legacy `apps/tieulinh-legacy/**`.
  - Không xoá hoặc làm gãy các test hiện có của `packages/core` hay `apps/tieulinh`.
  - Không hardcode IP nội bộ hay secret.
  - Không commit, không push (Coordinator sẽ thực hiện sau khi review).

---

## Tiêu chí chấp nhận (Acceptance Criteria)

- [ ] Thư mục `packages/core/examples/starter-bot/` hoàn chỉnh (`bot.ts`, `main.ts`, `starter.test.ts`, `README.md`).
- [ ] `starter.test.ts` pass 100%.
- [ ] `packages/core/src/core/boundary.test.ts` pass 100%.
- [ ] Tài liệu `docs/explanation/bot-core-architecture.md` và `docs/guide/create-new-bot.md` được viết đầy đủ, gắn vào sidebar `docs/.vitepress/config.mts`.
- [ ] `bun run docs:check` pass 100% (không dead-links, code snippet hợp lệ).
- [ ] Ghi chú thay đổi vào `packages/core/CHANGELOG.md`.
- [ ] `bun run verify` và `bun run scan` sạch 100%.
