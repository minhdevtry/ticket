/**
 * Nhắc quá hạn tiếp nhận (SLA) cho ticket chưa ai nhận, chạy theo `backoffice.schedule`.
 *
 * Khác legacy (bảng `sla_trackers` đăng ký lúc tạo ticket): quét KHÔNG TRẠNG THÁI. Mỗi nhịp đọc ticket
 * của dự án, chọn ticket chưa giao, còn ở cột chưa bắt đầu (backlog/unstarted), tạo sau mốc bắt đầu
 * theo dõi (`sla:since`, ghi một lần khi app khởi tạo lần đầu, để lần chạy đầu không xả cảnh báo cho
 * cả kho ticket cũ) và đã quá hạn theo ưu tiên. Mỗi ticket được nhắc đúng một lần (`ctx.keys`).
 * Không có bảng phải đồng bộ với itsaplan, nên ticket đổi ưu tiên/được giao giữa chừng tự đúng.
 *
 * Cách đọc danh sách (đã đối chiếu mã nguồn itsaplan fork): `GET /projects/:key/issues` sắp theo
 * `updatedAt` GIẢM dần, chỉ có `limit` (tối đa 500) và KHÔNG có `page`. Nên không phân trang mà lọc
 * theo từng cột chờ và theo cửa sổ `createdFrom..createdTo` bắt đầu từ `sla:since`; cửa sổ nào trả
 * đủ 500 dòng thì chia đôi và đọc lại, nên không bỏ sót vì trần số dòng.
 *
 * Chỉ đánh dấu "đã nhắc" khi kênh đã giao cảnh báo (`sendAlert` không ném và không trả `false`).
 * Bot KHÔNG đổi cột, không giao việc: chỉ báo kênh trực ca (ADR-0006).
 */
import type { ScheduleHandler } from "@vuihoc/bot-core/backoffice";
import { type ItsaplanIssue, issueWebUrl } from "@vuihoc/bot-core/itsaplan";
import { slaAlertText } from "./copy";
import type { TieulinhConfig } from "./env";
import { KEYS_TTL_MS, SLA_ALERTED_KEYS, SLA_SINCE_KEY, type TieulinhServices } from "./services";

/** Hạn tiếp nhận (giờ) theo ưu tiên. Ưu tiên không rõ tính như `medium`. */
export const SLA_HOURS: Record<string, number> = { urgent: 1, high: 2, medium: 4, low: 24 };

const HOUR_MS = 3_600_000;
/** Trần `limit` của itsaplan; cửa sổ trả đủ số này thì chia đôi. */
export const SLA_PAGE = 500;

export function slaHoursFor(priority: string | null | undefined): number {
  return SLA_HOURS[(priority ?? "").toLowerCase()] ?? (SLA_HOURS.medium as number);
}

type ListFn = (o: {
  limit: number;
  columnId: number;
  createdFrom: string;
  createdTo: string;
}) => Promise<ItsaplanIssue[]>;

/** Mọi ticket của một cột tạo trong `[from, to)`, chia đôi cửa sổ khi chạm trần `limit`. */
async function readWindow(
  list: ListFn,
  columnId: number,
  from: number,
  to: number,
  onTruncated: () => void,
): Promise<ItsaplanIssue[]> {
  const rows = await list({
    limit: SLA_PAGE,
    columnId,
    createdFrom: new Date(from).toISOString(),
    createdTo: new Date(to).toISOString(),
  });
  if (rows.length < SLA_PAGE) return rows;
  if (to - from <= 1) {
    onTruncated();
    return rows;
  }
  const mid = from + Math.floor((to - from) / 2);
  return [
    ...(await readWindow(list, columnId, from, mid, onTruncated)),
    ...(await readWindow(list, columnId, mid, to, onTruncated)),
  ];
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
      const waiting = (await ctx.tracker.columns()).filter(
        (c) => c.stateType === "backlog" || c.stateType === "unstarted",
      );
      const now = ctx.clock.now();
      const alerted = ctx.keys(SLA_ALERTED_KEYS, { ttlMs: KEYS_TTL_MS });
      const seen = new Set<number>();
      for (const column of waiting) {
        const issues = await readWindow(
          (o) => ctx.tracker.listIssues(o),
          column.id,
          since,
          now + 1,
          () =>
            ctx.logger.warn(`[sla] hơn ${SLA_PAGE} ticket cùng một mili giây ở cột ${column.name}`),
        );
        for (const issue of issues) {
          if (seen.has(issue.id)) continue;
          seen.add(issue.id);
          if (issue.assigneeUserId || issue.archivedAt) continue;
          const created = Date.parse(issue.createdAt);
          if (!Number.isFinite(created) || created < since) continue;
          const slaHours = slaHoursFor(issue.priority);
          if (now - created < slaHours * HOUR_MS) continue;
          const key = String(issue.id);
          if (alerted.has(key)) continue;
          try {
            const delivered = await sendAlert(
              slaAlertText({
                identifier: issue.identifier,
                title: issue.title,
                priority: issue.priority ?? "medium",
                slaHours,
                elapsedHours: Math.floor((now - created) / HOUR_MS),
                url: issueWebUrl(
                  svc.config.ITSAPLAN_WEB_URL,
                  ctx.tracker.projectKey,
                  issue.identifier,
                  undefined,
                  svc.config.TIEULINH_TEAM,
                ),
              }),
            );
            if (delivered === false) {
              // Kênh không giao được (vd chưa có chat trực ca): chưa đánh dấu, nhịp sau thử lại.
              ctx.logger.warn(`[sla] kênh chưa giao cảnh báo ${issue.identifier}, sẽ thử lại`);
              continue;
            }
            alerted.add(key);
          } catch (err) {
            // Chưa đánh dấu: nhịp sau thử lại.
            ctx.logger.error(
              `[sla] gửi cảnh báo ${issue.identifier} lỗi: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      running = false;
    }
  };
}
