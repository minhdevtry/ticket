/**
 * Bóc tách metadata sự cố (System/Product/Category/...) từ description ticket.
 * Tách khỏi worker/kg-sync.ts (nơi hàm này sống trước 27/09) sang lib/kg/ để
 * lib/kg/similar-context.ts dùng lại được — worker không được phụ thuộc ngược
 * vào lib, còn lib thì cả worker lẫn scripts đều gọi tới.
 */

// Map nhãn tiếng Việt trong khối "## Thông tin sự cố" (xem ticket-formatter.ts)
// sang tên field của TicketGraphNode — dùng khi ticket không có (hoặc thiếu)
// khối JSON ẩn <!-- vuihoc-meta -->, vốn là trường hợp phổ biến với các ticket
// được sinh ra trước khi metaComment được thêm vào pipeline.
const METADATA_LABEL_MAP: Array<[RegExp, string]> = [
  [/^sản\s*phẩm$/i, "product"],
  [/^hệ\s*thống$/i, "system"],
  [/^phân\s*loại\s*lỗi$/i, "category"],
  [/^bộ\s*phận$/i, "reportingDept"],
  [/^tài\s*khoản\s*hs/i, "studentAccount"],
  [/^mã\s*khách\s*hàng$/i, "customerId"],
  [/^thiết\s*bị$/i, "deviceType"],
  [/^hệ\s*điều\s*hành$/i, "deviceOs"],
  [/^phiên\s*bản\s*app$/i, "appVersion"],
  [/^trình\s*duyệt$/i, "browser"],
  [/^mã\s*giao\s*dịch$/i, "transactionId"],
  [/^mã\s*bài\s*tập$/i, "assignmentId"],
  [/^phòng\s*học/i, "roomCode"],
  [/^ưu\s*tiên$/i, "priority"],
];

/**
 * Bóc tách metadata từ khối Markdown "## Thông tin sự cố" hiển thị công khai
 * trong description (không phải comment ẩn). Dùng làm fallback khi ticket
 * không có <!-- vuihoc-meta -->.
 */
function parseIncidentMetaFromMarkdown(description: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const blockMatch = description.match(/##\s*Thông tin sự cố\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/);
  if (!blockMatch) return meta;

  const lineRe = /^-\s*([^:\n]+):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(blockMatch[1]))) {
    const label = m[1].trim();
    let value = m[2].trim();
    for (const [re, field] of METADATA_LABEL_MAP) {
      if (re.test(label)) {
        if (field === "priority") value = value.split(/\s*\(/)[0].trim();
        if (!meta[field]) meta[field] = value;
        break;
      }
    }
  }
  return meta;
}

/**
 * Bóc tách metadata sự cố (System/Product/Category/...) từ description.
 * Ưu tiên khối JSON ẩn <!-- vuihoc-meta --> (đáng tin cậy nhất); những field
 * còn thiếu được bù bằng cách parse khối Markdown "## Thông tin sự cố" hiển
 * thị công khai — cần thiết vì phần lớn ticket thật trên Itsaplan (kể cả
 * ticket do chính pipeline này tạo trước khi có metaComment) không có khối
 * JSON ẩn đó.
 */
export function parseIncidentMeta(description: string): Record<string, any> {
  let meta: Record<string, any> = {};
  const metaMatch = description.match(/<!--\s*vuihoc-meta:\s*(\{.*?\})\s*-->/);
  if (metaMatch) {
    try {
      meta = JSON.parse(metaMatch[1]);
    } catch {}
  }

  const fallback = parseIncidentMetaFromMarkdown(description);
  for (const key of Object.keys(fallback)) {
    if (meta[key] === undefined || meta[key] === null || meta[key] === "") {
      meta[key] = fallback[key];
    }
  }
  return meta;
}
