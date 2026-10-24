import * as fs from "node:fs";
import * as path from "node:path";
import type { ItsaplanClient } from "./client";
import { getLogger } from "../logger";
import { resolveMediaFilePath } from "../media";

export interface UploadedAttachment {
  id: string;
  url: string;
  filename: string;
  contentType?: string;
}

export function detectContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
    case ".quicktime":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

export function isVideoAttachment(filenameOrUrl: string): boolean {
  const clean = filenameOrUrl.split("?")[0].toLowerCase();
  return /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(clean);
}

export function formatAttachmentMarkdown(att: UploadedAttachment): string {
  if (
    isVideoAttachment(att.filename) ||
    isVideoAttachment(att.url) ||
    att.contentType?.startsWith("video/")
  ) {
    return `<video src="${att.url}" controls></video>`;
  }
  const ext = path.extname(att.filename).toLowerCase();
  if (
    [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ||
    att.contentType?.startsWith("image/")
  ) {
    return `![${att.filename}](${att.url})`;
  }
  return `[${att.filename}](${att.url})`;
}

/**
 * Uploads each local file path or Telegram file ref to an issue's attachment storage.
 *
 * A failed upload is logged and skipped rather than aborting the batch — one
 * bad path (deleted temp file, network blip) shouldn't cost the rest of the
 * ticket's attachments.
 */
export async function uploadAttachments(
  client: ItsaplanClient,
  issueId: number,
  baseUrl: string,
  paths: string[],
): Promise<UploadedAttachment[]> {
  const uploaded: UploadedAttachment[] = [];
  for (const rawPath of paths) {
    try {
      const filePath = await resolveMediaFilePath(rawPath);
      if (!filePath || !fs.existsSync(filePath)) {
        getLogger().warn(`[attachments] Không tìm thấy file hợp lệ từ ref: ${rawPath}`);
        continue;
      }
      const buffer = await fs.promises.readFile(filePath);
      const filename = path.basename(filePath);
      const contentType = detectContentType(filename);
      const res = await client.uploadAttachment(issueId, filename, buffer, contentType);
      const isLoopback =
        /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|192\.168\.\d+\.\d+)(?::\d+)?/i.test(
          baseUrl,
        );
      const fullUrl = res.url.startsWith("http")
        ? res.url
        : isLoopback
          ? res.url
          : `${baseUrl.replace(/\/+$/, "")}${res.url.startsWith("/") ? "" : "/"}${res.url}`;
      uploaded.push({ id: res.id, url: fullUrl, filename, contentType });
    } catch (err: any) {
      getLogger().warn(`[attachments] Lỗi upload đính kèm ${rawPath}: ${err?.message}`);
    }
  }
  return uploaded;
}

const IMAGE_HEADING = "### 📸 Ảnh đính kèm";

/**
 * Splices uploaded images and videos into a ticket description, before the trailing
 * `---` footer if there is one.
 *
 * Merges into an existing image heading rather than adding a second one —
 * this only matters on repeated updates (create always starts from a fresh
 * description), but one function means create and update can never drift on
 * the rule again.
 */
export function spliceAttachmentsIntoDescription(
  description: string,
  attachments: UploadedAttachment[],
): string {
  if (attachments.length === 0) return description;
  const mediaMarkdown = attachments.map(formatAttachmentMarkdown).join("\n\n");

  const heading = description.includes(IMAGE_HEADING)
    ? IMAGE_HEADING
    : description.includes("### 📸 Tệp đính kèm")
      ? "### 📸 Tệp đính kèm"
      : IMAGE_HEADING;

  if (description.includes(heading)) {
    return description.replace(`${heading}\n`, `${heading}\n\n${mediaMarkdown}\n`);
  }
  if (description.includes("---")) {
    const parts = description.split("---");
    const footer = parts.pop();
    return `${parts.join("---").trim()}\n\n${heading}\n\n${mediaMarkdown}\n\n---\n${(footer ?? "").trim()}`;
  }
  return `${description.trim()}\n\n${heading}\n\n${mediaMarkdown}`;
}
