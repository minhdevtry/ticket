/**
 * Nhắc quá hạn tiếp nhận (SLA) cho ticket chưa ai nhận, chạy theo `backoffice.schedule`.
 *
 * Khác legacy (bảng `sla_trackers` đăng ký lúc tạo ticket): quét KHÔNG TRẠNG THÁI. Mỗi nhịp đọc ticket
 * của dự án, chọn ticket chưa giao, còn ở cột chưa bắt đầu (backlog/unstarted), tạo sau mốc bắt đầu
 * theo dõi (`sla:since`, ghi một lần khi app khởi tạo lần đầu, để lần chạy đầu không xả cảnh báo cho
 * cả kho ticket cũ) và đã quá hạn theo ưu tiên. Mỗi ticket được nhắc đúng một lần (`sla:alerted:<id>`).
 * Không có bảng phải đồng bộ với itsaplan, nên ticket đổi ưu tiên/được giao giữa chừng tự đúng.
 *
 * Bot KHÔNG đổi cột, không giao việc: chỉ báo kênh trực ca (ADR-0006).
 */
import type { ScheduleHandler } from "@vuihoc/bot-core/backoffice";
import { slaAlertText } from "./copy";
import type { TieulinhConfig } from "./env";
import { SLA_SINCE_KEY, type TieulinhServices } from "./services";

/** Hạn tiếp nhận (giờ) theo ưu tiên. Ưu tiên không rõ tính như `medium`. */
export const SLA_HOURS: Record<string, number> = { urgent: 1, high: 2, medium: 4, low: 24 };

const HOUR_MS = 3_600_000;
const PAGE = 100;
const MAX_PAGES = 3;

export function slaHoursFor(priority: string | null | undefined): number {
  return SLA_HOURS[(priority ?? "").toLowerCase()] ?? (SLA_HOURS.medium as number);
}

export function slaSweep(svc: TieulinhServices): ScheduleHandler<TieulinhConfig> {
  let running = false;
  return async (ctx) => {
    if (running) {
      ctx.logger.warn("[sla] lượt quét trước chưa xong, bỏ qua lượt này");
      return;
    }
    running = true;
    try {
      const sendAlert = svc.channel.sendAlert?.bind(svc.channel);
      if (!sendAlert) {
        ctx.logger.warn("[sla] kênh không hỗ trợ cảnh báo trực ca, bỏ qua");
        return;
      }
      const since = Number(svc.kvGet(SLA_SINCE_KEY) ?? 0);
      const waiting = new Set(
        (await ctx.tracker.columns())
          .filter((c) => c.stateType === "backlog" || c.stateType === "unstarted")
          .map((c) => c.id),
      );
      const now = ctx.clock.now();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const issues = await ctx.tracker.listIssues({ limit: PAGE, page });
        for (const issue of issues) {
          if (issue.assigneeUserId || issue.archivedAt || !waiting.has(issue.columnId)) continue;
          const created = Date.parse(issue.createdAt);
          if (!Number.isFinite(created) || created < since) continue;
          const slaHours = slaHoursFor(issue.priority);
          if (now - created < slaHours * HOUR_MS) continue;
          const key = `sla:alerted:${issue.id}`;
          if (svc.kvGet(key) !== null) continue;
          try {
            await sendAlert(
              slaAlertText({
                identifier: issue.identifier,
                title: issue.title,
                priority: issue.priority ?? "medium",
                slaHours,
                elapsedHours: Math.floor((now - created) / HOUR_MS),
              }),
            );
            svc.kvSet(key, String(now));
          } catch (err) {
            // Chưa đánh dấu: nhịp sau thử lại.
            ctx.logger.error(
              `[sla] gửi cảnh báo ${issue.identifier} lỗi: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (issues.length < PAGE) break;
      }
    } finally {
      running = false;
    }
  };
}
