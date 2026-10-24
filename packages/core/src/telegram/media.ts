/**
 * Finding the media a user just sent (ảnh/file) so it can be attached to a ticket.
 *
 * NGUỒN: intake `lib/media.ts` (`findRecentInboundMedia`, `resolveMediaPath`,
 * `readLocalMedia`, `sniffImageContentType`) ∪ CM `lib/media.ts` — CM wins on
 * SAFETY: its `resolveMediaPath` rejects `..` / absolute / backslash traversal
 * tokens inside the inbound dir, which intake's did not. intake wins on REACH:
 * its magic-byte sniffer and recent-inbound scan. The two overlapping copies are
 * folded here.
 *
 * CHANGED from both: the inbound directory is INJECTED (`MediaFinderOptions.inboundDir`),
 * not read from `OPENCLAW_STATE_DIR` / `~/.openclaw` — the library never guesses
 * where a bot keeps its media. The allow-list roots are injected too.
 *
 * The result is shaped to satisfy the itsaplan `MediaResolver` port
 * (`src/itsaplan/attachments.ts`): `createInboundMediaResolver(...)` returns a
 * `{ resolve, isAllowed }` the attachments uploader can take directly.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** Max media file size read from disk. CM `MAX_ATTACHMENT_BYTES` floor; 20 MB. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface MediaFinderOptions {
  /** Absolute path to the inbound media directory (injected — no env guess). */
  inboundDir: string;
  /** Extra roots a resolved path is allowed to live under. Defaults to inboundDir only. */
  allowedRoots?: string[];
}

export interface LocalMediaFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
  sizeBytes: number;
}

/** A found attachment — enough for the uploader to read and name it. */
export interface InboundAttachment {
  /** Absolute path to the file. */
  path: string;
  filename: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** Sniff image format from header magic bytes (intake). */
export function sniffImageContentType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buf.length >= 6 &&
    (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  return null;
}

/** The roots a resolved file is allowed under: inboundDir plus any extra roots. */
function allowedRootsOf(opts: MediaFinderOptions): string[] {
  return [resolve(opts.inboundDir), ...(opts.allowedRoots ?? []).map((r) => resolve(r))];
}

/**
 * Is `fullPath` inside one of the allowed roots, after resolving symlinks?
 * Mirrors CM/intake `isAllowedPath` — a real-path containment check that blocks
 * `..` escapes and symlink hops out of the media dir.
 */
export function isAllowedPath(fullPath: string, opts: MediaFinderOptions): boolean {
  try {
    const real = realpathSync(fullPath);
    return allowedRootsOf(opts).some((root) => {
      const rel = relative(root, real);
      return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
    });
  } catch {
    return false;
  }
}

/**
 * Resolve a channel ref (`media://inbound/<id>`, `inbound/<id>`, a bare name, or
 * an absolute path) to an absolute path under the inbound dir — rejecting
 * traversal tokens (CM hardening). Returns null when it cannot resolve safely.
 */
export function resolveInboundRef(ref: string, opts: MediaFinderOptions): string | null {
  let s = String(ref ?? "").trim();
  s = s
    .replace(/^<media:\w+>\s*/i, "")
    .replace(/^\[(?:image|video|media|file)\s+/i, "")
    .replace(/^<(?:image|video|media|file)\s+/i, "")
    .replace(/[\]>]$/, "")
    .trim();
  if (!s) return null;

  const inboundDir = resolve(opts.inboundDir);

  if (s.startsWith("media://inbound/") || s.startsWith("inbound/")) {
    const id = s.replace(/^media:\/\/inbound\//, "").replace(/^inbound\//, "");
    if (id.includes("..") || id.startsWith("/") || id.includes("\\")) return null;
    const target = resolve(inboundDir, id);
    const rel = relative(inboundDir, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return target;
  }

  if (isAbsolute(s)) return s;

  if (s.includes("..")) return null;
  const candidate = resolve(inboundDir, s);
  const rel = relative(inboundDir, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

/** Read a resolved media file securely (allow-list + size cap + magic sniff). */
export function readLocalMedia(ref: string, opts: MediaFinderOptions): LocalMediaFile | null {
  try {
    const fullPath = resolveInboundRef(ref, opts);
    if (!fullPath || !existsSync(fullPath)) return null;
    if (!isAllowedPath(fullPath, opts)) return null;

    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MEDIA_BYTES) return null;

    const buffer = readFileSync(fullPath);
    const contentType = sniffImageContentType(buffer) ?? "application/octet-stream";
    return {
      buffer,
      contentType,
      filename: basename(fullPath) || "attachment",
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Find recent inbound media files (newest first) uploaded within
 * `maxAgeMinutes`, capped at `limit`. Non-files, empties, and anything older are
 * skipped. Source: intake `findRecentInboundMedia`.
 */
export function findRecentInboundMedia(
  opts: MediaFinderOptions,
  maxAgeMinutes = 10,
  limit = 5,
  now: () => number = Date.now,
): InboundAttachment[] {
  try {
    const inboundDir = resolve(opts.inboundDir);
    if (!existsSync(inboundDir)) return [];

    const cutoff = now() - maxAgeMinutes * 60 * 1000;
    return readdirSync(inboundDir)
      .map((name) => {
        const full = join(inboundDir, name);
        try {
          const st = statSync(full);
          if (!st.isFile() || st.size === 0 || st.mtimeMs < cutoff) return null;
          return { path: full, filename: name, sizeBytes: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is InboundAttachment => f !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** The single most recent inbound file, or null (intake `findLatestInboundImage`). */
export function findLatestInboundMedia(
  opts: MediaFinderOptions,
  maxAgeMinutes = 15,
  now: () => number = Date.now,
): InboundAttachment | null {
  return findRecentInboundMedia(opts, maxAgeMinutes, 1, now)[0] ?? null;
}

/**
 * The shape the itsaplan attachments uploader expects (`MediaResolver` port):
 * `resolve(ref) → absolute path | null` and an `isAllowed(absPath)` guard.
 * Lets a bot hand the uploader a media layer without the itsaplan layer
 * importing anything channel-coupled.
 */
export interface ItsaplanMediaResolver {
  resolve(ref: string): string | null;
  isAllowed(absPath: string): boolean;
}

/** Build an itsaplan `MediaResolver` backed by this inbound dir. */
export function createInboundMediaResolver(opts: MediaFinderOptions): ItsaplanMediaResolver {
  return {
    resolve: (ref) => {
      const p = resolveInboundRef(ref, opts);
      return p && existsSync(p) ? p : null;
    },
    isAllowed: (absPath) => isAllowedPath(absPath, opts),
  };
}
