# Chuyển Bot-Sales ("Bitu") sang `@vuihoc/bot-core`

Bot thật: `<path-to>/Bot-Sales`. CHỈ ĐỌC — tài liệu mô tả việc chủ
bot sẽ làm, không sửa gì trong repo đó. Dựa trên research `bot-sales.md` + đọc
code thật (các dòng dẫn chứng bên dưới).

Bot-Sales chỉ dùng **`core` + `openclaw`** — không `itsaplan`, không `intake`
engine (nó không có tracker Itsaplan, không có gate/ask-back dạng code). Stack
mỏng: không `lib/`, không `worker/`, không SQLite, không bộ khử PII.

## 1. Thay MCP server tự dựng bằng scaffold của core

`mcp/crm/index.ts` tự tay dựng `McpServer` + `StdioServerTransport`
(`mcp/crm/index.ts:19,20,52,67`) và tự bọc try/catch → `{loi, thongBao}`. Đây là
~90% việc mà `createIntakeMcpServer`/`runOnStdio` của thư viện làm sẵn, kèm
`describeToolFailure` thống nhất (`@vuihoc/bot-core/core`, `src/core/index.ts`:
`createMcpServer`, `createIntakeMcpServer`, `runOnStdio`, `runOnHttp`,
`defineTool`, `describeToolFailure`).

Chủ bot: giữ nguyên các tool CRM (lead-capture `/api/chatbot`, find-contact,
add-note…), chỉ đổi phần dựng server/khung lỗi sang scaffold core — để hình dạng
lỗi khớp các bot khác.

## 2. Một env loader duy nhất

Hiện có HAI bộ đọc env trùng logic:
- `mcp/crm/env.ts` — `parseEnvContent` + `loadEnvFile` (`mcp/crm/env.ts:12,61,67`).
- `plugins/ghi-chu-cuoi-phien/crm-mini.mjs` — `phanTichEnv` + `docEnvFile`
  (`crm-mini.mjs:35,71,76`), cùng logic KEY=VALUE viết lại bằng `.mjs`.

Thay cả hai bằng env loader của thư viện (`@vuihoc/bot-core/core`:
`parseEnvContent`, `loadEnvFile`, `loadEnvDefaults` — `src/core/env.ts`). Lưu ý
ràng buộc ADR-0002: plugin `.mjs` phải được build thành bundle thì mới import
được bare specifier (xem §5).

## 3. Bộ khử PII cho log — RỦI RO THẬT, cần đóng

Bot-Sales **không có bộ khử PII nào** (research §2: grep redact/mask/PII chỉ ra
prose + 1 assertion test). Trong khi đó plugin ghi-chú ghi NGUYÊN VĂN nội dung
note (có số điện thoại phụ huynh) ra file log JSONL:

- `plugins/ghi-chu-cuoi-phien/index.mjs:46-53` — `ghiLog()` `appendFileSync` một
  record `{...dong}` vào `~/.openclaw/ghi-chu-cuoi-phien.log`.
- `index.mjs:279-285` (sự kiện `dry_run_ghi_chu`) và `index.mjs:319-326` (sự kiện
  `ghi_chu_thanh_cong`) đều ghi trường `chunks` vào log đó.
- `chunks` = `splitNoteChunks(taoNoiDungGhiChu(phien, …), 250)` (`index.mjs:268,275`);
  nội dung note dựng từ hội thoại phụ huynh, gồm SĐT phụ huynh
  (`note-builder.mjs:109-111` bắt `SĐT/Số điện thoại … : <10-15 số>`;
  `dong-bo-lead.mjs:191,209,230` mang `phone`/`basePhonenumber`/`fbpsId: bitu_<phone>`).

Nghĩa là **số điện thoại phụ huynh thật đang được ghi thô vào log** mà không
qua lớp khử nào. (CRM client có bình luận "KHÔNG log mật khẩu/token" —
`crm-mini.mjs:11` — nhưng đó chỉ là password/token, không phải SĐT; và không có
hàm redact nào thực thi.)

**Đính chính sau khi đọc kỹ lúc sửa (16/10):** template note (`taoNoiDungGhiChu`)
chỉ ghép Con/Lớp/Môn/Các bước, không ghép SĐT, nên `chunks` thường không mang số.
Chỗ rò thật là trường `sdt` trong các dòng log (`tra_cuu_contact_id_*`,
`bo_qua_khong_co_contact_id`) và các thông điệp logger Gateway trong
`dong-bo-lead.mjs` (`SĐT ${sdt} …`, khoảng dòng 405–752).

**Đã sửa** trên nhánh `fix/sales-pii-log` (commit `5aa9ba4`, chưa merge, chưa push,
chưa deploy): `ghiLog` che mọi chuỗi trong dòng JSONL; logger Gateway được bọc
(`boLocLogger`) nên log của `dong-bo-lead`/`crm-mini` cũng được che; ghi chú và
lead gửi CRM giữ số thật; `vendor/bot-core-pii.mjs` là bundle từ v0.2.0.

Khắc phục (cách đã dùng): `redactIncidentPII` của thư viện
(`@vuihoc/bot-core/core`, `src/core/pii-redactor.ts`) — bắt SĐT VN, email,
CCCD, Telegram id, token, password — áp lên mọi chuỗi trước khi ghi log.
Đây là lớp bảo vệ Bot-Sales còn thiếu (spec User Story 8).

## 4. Helper agent-gating cho 3 plugin

Idiom "parse `agent:<id>:` từ sessionKey" đang bị chép tay ở nhiều plugin:
- `plugins/ghi-chu-cuoi-phien/index.mjs:33-37` (`laAgentSales`),
- `plugins/nap-skill/index.mjs:247-248`,
- `plugins/dinh-huong/index.mjs:242` (log `agentId`).

Thay bằng helper của thư viện (`@vuihoc/bot-core/openclaw`:
`parseAgentIdFromSessionKey`, `resolveAgentId`, `isAgentInScope`,
`parseAllowedAgentIds` — `src/openclaw/index.ts`), một chỗ cho cả 3 plugin.

## 5. Plugin phải dùng bundle vendored (ADR-0002)

Cả 3 plugin (`dinh-huong`, `nap-skill`, `ghi-chu-cuoi-phien`) là `.mjs` do
gateway nạp theo đường dẫn file. Muốn import `@vuihoc/bot-core/*`, mỗi plugin phải
`bun build … --target=node --format=esm --outfile <name>.bundle.mjs` và trỏ `main`
vào bundle (README §5; `docs/adr/0002-...`). Bare specifier không tự resolve khi
thiếu `node_modules/@vuihoc/bot-core` cạnh file plugin — đúng lớp lỗi deploy
ADR-0002 nêu.

## Phần sales-only — KHÔNG vào thư viện

Giữ nguyên trong bot (research §3): 7 playbook `skills/vuihoc-*` + SOP xlsx;
`routing.json` + logic match sản phẩm trong `dinh-huong`; ngữ nghĩa lead-capture
CRM (`/api/chatbot`, nguồn `Bitu`, tag BITU_*, 3-path lead sync `dong-bo-lead.mjs`,
cắt note ≤250 ký tự); tính tuổi→lớp (`tich-hop-web/form-lead.mjs`); RAG
`rag_knowledge/`; greeting nhanh + pre-inject skill (workaround độ trễ Codex).

Mâu thuẫn prose là OVERRIDE riêng của Bot-Sales, giữ ở SOUL/AGENTS của bot, không
đưa vào prose chung (`prose/AGENTS.shared.md` §Comments/§Mâu thuẫn): (1) xưng hô
"em/ba/mẹ" và **đổi theo văn phong phụ huynh**; (2) lời chào mở đầu (bỏ khi
form/CRM báo đã chào); (3) **chia nhiều tin ngắn** trong một lượt — ngoại lệ của
luật "một lượt một tin".

## Cách kiểm

Chủ bot tự chạy `bun test` trong Bot-Sales để đo baseline của chính nó trước, rồi
đối chiếu sau mỗi bước. Bật preload chặn gọi dịch vụ thật (README §4;
`test-preload` đã scrub `CRM_*`).
