/**
 * Adapter báo admin cho `describeToolFailure` của `@vuihoc/bot-core/core`.
 *
 * Thư viện không có Telegram: nó chỉ gọi hook `setToolFailureAlert`. Import file
 * này (một lần, ở barrel `mcp/shared/index.ts`) là nối hook vào `alertAdmin` của
 * Tiểu Linh để lỗi tool vẫn báo tới quản trị viên như trước.
 */
import { setToolFailureAlert } from "@vuihoc/bot-core/core";
import { alertAdmin } from "./telegram/alert";

setToolFailureAlert((key, message) => alertAdmin(key, message));
