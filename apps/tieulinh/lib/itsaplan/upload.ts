import {
  type ItsaplanClient,
  type MediaResolver,
  type UploadedAttachment,
  uploadAttachments as uploadAttachmentsWith,
} from "@vuihoc/bot-core/itsaplan";
import { resolveMediaFilePath } from "../media";

/**
 * Cầu nối media của Tiểu Linh cho `uploadAttachments` của thư viện: thư viện
 * không biết thư mục `~/.openclaw/media/inbound` hay việc tải `getFile` từ
 * Telegram, nên nhận một `MediaResolver` được tiêm vào. Không có `isAllowed`,
 * giữ đúng hành vi cũ (đọc mọi file `resolveMediaFilePath` trả về).
 */
export const tieuLinhMediaResolver: MediaResolver = { resolve: resolveMediaFilePath };

export function uploadAttachments(
  client: ItsaplanClient,
  issueId: number,
  baseUrl: string,
  paths: string[],
): Promise<UploadedAttachment[]> {
  return uploadAttachmentsWith(client, issueId, baseUrl, paths, tieuLinhMediaResolver);
}
