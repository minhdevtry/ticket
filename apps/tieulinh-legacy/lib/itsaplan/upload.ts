import {
  type ItsaplanClient,
  type UploadedAttachment,
  type MediaResolver,
  formatAttachmentMarkdown as formatAttachmentMarkdownWith,
  spliceAttachmentsIntoDescription as spliceAttachmentsIntoDescriptionWith,
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
  // Không giới hạn kích thước (maxBytes: Infinity): bản cũ đọc mọi file.
  return uploadAttachmentsWith(client, issueId, baseUrl, paths, tieuLinhMediaResolver, {
    maxBytes: Number.POSITIVE_INFINITY,
  });
}

/** Markdown đính kèm, chèn tên file/URL NGUYÊN VĂN như bản cũ (thư viện mặc định có escape). */
export function formatAttachmentMarkdown(att: UploadedAttachment): string {
  return formatAttachmentMarkdownWith(att, { escape: false });
}

/** `spliceAttachmentsIntoDescription` không escape, như bản cũ. */
export function spliceAttachmentsIntoDescription(
  description: string,
  attachments: UploadedAttachment[],
): string {
  return spliceAttachmentsIntoDescriptionWith(description, attachments, { escape: false });
}
