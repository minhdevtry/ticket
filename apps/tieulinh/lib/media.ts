import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, basename, extname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { sniffImageContentType } from "@vuihoc/bot-core/telegram";

// Nhận diện định dạng ảnh theo magic bytes (`sniffImageContentType`) nằm ở thư viện.

export interface LocalMediaFile {
  buffer: Buffer;
  contentType: string; // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  filename: string;
  sizeBytes: number;
}

const ALLOWED_ROOTS = [
  resolve(homedir(), ".openclaw"),
  resolve(homedir(), "Documents"),
  resolve(homedir(), "Downloads"),
  "/tmp",
];

function isAllowedPath(fullPath: string): boolean {
  try {
    const real = realpathSync(fullPath);
    return ALLOWED_ROOTS.some((root) => {
      const rel = relative(root, real);
      return rel && !rel.startsWith("..") && !isAbsolute(rel);
    });
  } catch {
    return false;
  }
}

/**
 * Resolve path or URI reference to local file path
 */
export function resolveMediaPath(ref: string): string {
  let s = String(ref ?? "").trim();
  s = s
    .replace(/^\[image\s+/i, "")
    .replace(/^<image\s+/i, "")
    .replace(/[\]>]$/, "")
    .trim();

  const openclawDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  const inboundDir = join(openclawDir, "media", "inbound");

  if (s.startsWith("media://inbound/")) {
    const fileId = s.replace(/^media:\/\/inbound\//, "");
    return join(inboundDir, fileId);
  }

  if (s.startsWith("inbound/")) {
    return join(inboundDir, s.replace(/^inbound\//, ""));
  }

  if (!isAbsolute(s)) {
    // Try inside inbound dir
    const inboundCandidate = join(inboundDir, s);
    if (existsSync(inboundCandidate)) {
      return inboundCandidate;
    }
  }

  return s;
}

/**
 * Read local media file securely
 */
export function readLocalMedia(filePathOrRef: string): LocalMediaFile | null {
  try {
    const fullPath = resolveMediaPath(filePathOrRef);
    if (!existsSync(fullPath)) return null;
    if (!isAllowedPath(fullPath)) return null;

    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) {
      return null;
    }

    const buffer = readFileSync(fullPath);
    const contentType = sniffImageContentType(buffer) || "image/png";
    const filename = basename(fullPath) || "screenshot.png";

    return {
      buffer,
      contentType,
      filename,
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Find the most recent inbound image from Telegram in ~/.openclaw/media/inbound
 * (uploaded within the last maxAgeMinutes, default 15 mins)
 */
export function findLatestInboundImage(maxAgeMinutes: number = 15): string | null {
  const media = findRecentInboundMedia(maxAgeMinutes, 1);
  return media[0] ?? null;
}

/**
 * Find recent inbound media files (images/videos) in ~/.openclaw/media/inbound
 */
export function findRecentInboundMedia(maxAgeMinutes: number = 10, limit: number = 5): string[] {
  try {
    const openclawDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
    const inboundDir = join(openclawDir, "media", "inbound");
    if (!existsSync(inboundDir)) return [];

    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;

    const candidates: { full: string; mtime: number; isFile: boolean; size: number }[] = [];
    for (const name of readdirSync(inboundDir)) {
      const full = join(inboundDir, name);
      try {
        const st = statSync(full);
        if (st.isFile() && st.size > 0 && now - st.mtimeMs < maxAgeMs) {
          candidates.push({ full, mtime: st.mtimeMs, isFile: true, size: st.size });
        } else if (st.isDirectory() && name.startsWith("openclaw-staged-")) {
          for (const sub of readdirSync(full)) {
            if (sub.startsWith(".")) continue;
            const subFull = join(full, sub);
            const subSt = statSync(subFull);
            if (subSt.isFile() && subSt.size > 0 && now - subSt.mtimeMs < maxAgeMs) {
              candidates.push({
                full: subFull,
                mtime: subSt.mtimeMs,
                isFile: true,
                size: subSt.size,
              });
            }
          }
        }
      } catch {
        // ignore unreadable entries
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.slice(0, limit).map((f) => f.full);
  } catch {
    return [];
  }
}

/**
 * Resolve path, URI reference, or Telegram file ID to an existing local media file.
 * Automatically checks ~/.openclaw/media/inbound for matched file size or downloads from Telegram API.
 */
export async function resolveMediaFilePath(ref: string): Promise<string | null> {
  if (!ref || typeof ref !== "string") return null;
  let s = ref.trim();

  // Strip wrappers: e.g. <media:image> [image telegram:file/...], [image ...], <video ...>
  s = s
    .replace(/^<media:\w+>\s*/i, "")
    .replace(/^\[(?:image|video|media|file)\s+/i, "")
    .replace(/^<(?:image|video|media|file)\s+/i, "")
    .replace(/[\]>]$/, "")
    .trim();

  const openclawDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  const inboundDir = join(openclawDir, "media", "inbound");

  // 1. Direct file on disk (or openclaw-staged-* directory)
  if (existsSync(s)) {
    try {
      const st = statSync(s);
      if (st.isFile()) return s;
      if (st.isDirectory() && basename(s).startsWith("openclaw-staged-")) {
        for (const sub of readdirSync(s)) {
          if (sub.startsWith(".")) continue;
          const subFull = join(s, sub);
          if (statSync(subFull).isFile()) return subFull;
        }
      }
    } catch {}
  }

  // 2. URI schemes: media://inbound/... or inbound/... or bare filename (with optional input- prefix)
  if (s.startsWith("media://inbound/")) {
    const rel = s.replace(/^media:\/\/inbound\//, "");
    for (const cand of [
      join(inboundDir, rel),
      join(inboundDir, basename(rel).replace(/^input-/, "")),
    ]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }
  if (s.startsWith("inbound/")) {
    const rel = s.replace(/^inbound\//, "");
    for (const cand of [
      join(inboundDir, rel),
      join(inboundDir, basename(rel).replace(/^input-/, "")),
    ]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }
  if (!isAbsolute(s)) {
    for (const cand of [
      join(inboundDir, s),
      join(inboundDir, basename(s).replace(/^input-/, "")),
    ]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }

  // 3. Telegram file reference: telegram:file/<fileId>, telegram:<fileId>, or raw file_id
  const tgMatch = s.match(/(?:telegram:(?:file\/)?)?([A-Za-z0-9_-]{20,})/);
  if (tgMatch && (s.includes("telegram") || tgMatch[1].length > 30)) {
    const fileId = tgMatch[1];
    const botToken = process.env.TELEGRAM_BOT_TOKEN_TIEULINH || process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return null;

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.ok && data.result) {
          const fileSize = data.result.file_size;
          const remotePath = data.result.file_path; // e.g. "photos/file_401.jpg" or "videos/file_402.mp4"
          const ext = remotePath ? extname(remotePath) : ".jpg";

          // Match by file size in ~/.openclaw/media/inbound (downloaded recently)
          if (fileSize && existsSync(inboundDir)) {
            const files = readdirSync(inboundDir);
            for (const f of files) {
              const full = join(inboundDir, f);
              try {
                const st = statSync(full);
                if (st.isFile() && st.size === fileSize) {
                  return full;
                }
              } catch {}
            }
          }

          // If not found locally in inboundDir, download it directly from Telegram
          if (remotePath) {
            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
            const fileRes = await fetch(downloadUrl);
            if (fileRes.ok) {
              const arrayBuf = await fileRes.arrayBuffer();
              const buffer = Buffer.from(arrayBuf);
              mkdirSync(inboundDir, { recursive: true });
              const targetName = `tg_${createHash("md5").update(fileId).digest("hex")}${ext}`;
              const targetPath = join(inboundDir, targetName);
              writeFileSync(targetPath, buffer);
              return targetPath;
            }
          }
        }
      }
    } catch {}
  }

  // 4. Fallback: try resolveMediaPath
  const fallback = resolveMediaPath(s);
  if (existsSync(fallback) && statSync(fallback).isFile()) {
    return fallback;
  }

  return null;
}
