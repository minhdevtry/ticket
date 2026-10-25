import { makeOpenLazyDb } from "@vuihoc/bot-core/core";
import { applySchema } from "./schema";

/**
 * Mở một kết nối SQLite lười, cache theo đường dẫn, áp schema của Tiểu Linh.
 *
 * Phần mở/cache/hạ cấp nằm ở `@vuihoc/bot-core/core` (`makeOpenLazyDb`); lõi
 * không biết schema của bot nào nên schema được tiêm vào ở đây.
 *
 * `onOpenError: "throw"`: giữ nguyên hành vi cũ của Tiểu Linh — file không mở
 * được thì ném cho caller (vd lookup ask-learning bắt rồi bỏ tính năng) thay vì
 * hạ xuống `:memory:` rỗng như mặc định của thư viện.
 */
export const openLazyDb = makeOpenLazyDb({ applySchema, onOpenError: "throw" });
