/**
 * `backoffice.reporter`: ai là "người báo" của một ticket, cho các luật cần biết (token huỷ
 * `reporter-comment`, `closeAfter`).
 *
 * itsaplan không trả người báo trên issue, và ở Tiểu Linh người báo sống trong CHAT, không phải một
 * user itsaplan. Quy tắc (có tài liệu, có test):
 *  - ticket đã có liên kết chat (kho binding của app): người comment trên itsaplan là NHÂN VIÊN, không
 *    bao giờ là người báo ⇒ `false`;
 *  - ticket chưa có liên kết (tạo thẳng trên itsaplan): không phân biệt được ⇒ `true` (thận trọng:
 *    coi mọi người là người báo, nên không luật nào tự hành động dựa trên "người báo im lặng").
 *
 * Hiện KHÔNG luật nào của app dùng nó: ADR-0006 cấm bot tự đóng ticket nên không có `closeAfter`. Giữ lại
 * làm điểm cắm cho luật nhắc/huỷ hẹn giờ sau này và vì `defineBot` đòi nó khi có luật cần người báo.
 */
import type { ReporterResolver } from "@vuihoc/bot-core/backoffice";
import type { TieulinhServices } from "./services";

export function reporterResolver(svc: TieulinhServices): ReporterResolver {
  return ({ issue }) => svc.bindings.getBindingByIssueId(issue.id) === null;
}
