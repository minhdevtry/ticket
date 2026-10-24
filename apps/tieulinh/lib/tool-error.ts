/**
 * Adapter báo admin cho `describeToolFailure` của `@vuihoc/bot-core/core`.
 *
 * Thư viện không có Telegram: nó chỉ gọi hook `setToolFailureAlert`. Import file
 * này (một lần, ở barrel `mcp/shared/index.ts`) là nối hook vào `alertAdmin` của
 * Tiểu Linh để lỗi tool vẫn báo tới quản trị viên như trước.
 */
import { setToolFailureAlert, setToolFailureOptions } from "@vuihoc/bot-core/core";
import { alertAdmin } from "./telegram/alert";

setToolFailureAlert((key, message) => alertAdmin(key, message));

// Giữ mã lỗi đúng như cũ: LUÔN là mã ngắn theo thời điểm (duy nhất mỗi lần), không
// dùng `err.code` tự khai — mã cố định (vd ECONNRESET) làm hai sự cố trùng mã.
setToolFailureOptions({ useDeclaredErrorCode: false });
