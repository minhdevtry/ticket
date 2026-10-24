/** Tiện ích dùng chung của hai proxy (MiniMax, itsaplan). */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Log = (entry: Record<string, unknown>) => void;

export const MAX_BODY = 4 * 1024 * 1024;

export const json = (status: number, body: unknown) => Response.json(body, { status });
export const deny = (reason: string, status = 403) => json(status, { error: "denied", reason });

const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
  "proxy-authenticate",
  "trailer",
  "upgrade",
]);

export function passHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!HOP.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

export function pick(req: Request, names: string[]): Headers {
  const out = new Headers();
  for (const n of names) {
    const v = req.headers.get(n);
    if (v) out.set(n, v);
  }
  return out;
}

export function withAuth(h: Headers, key: string): Headers {
  h.set("x-api-key", key);
  h.set("authorization", `Bearer ${key}`);
  return h;
}

export async function readBody(req: Request, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength > max ? null : buf;
}

/** Chống DNS rebinding: Host (qua req.url) phải là tên loopback. */
export function hostOk(req: Request): boolean {
  try {
    const h = new URL(req.url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

export const isJson = (req: Request): boolean =>
  (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");

/** Trần số lệnh gọi trong 60 giây (cửa sổ trượt). */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private perMin: number,
    private now: () => number,
  ) {}
  take(): boolean {
    const t = this.now();
    while (this.hits.length && t - (this.hits[0] as number) > 60_000) this.hits.shift();
    if (this.hits.length >= this.perMin) return false;
    this.hits.push(t);
    return true;
  }
}

/** Bọc luồng phản hồi để nhả chỗ đồng thời khi luồng kết thúc, lỗi hoặc client bỏ giữa chừng. */
export function withRelease(body: ReadableStream<Uint8Array>, release: () => void) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
        } else controller.enqueue(value);
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/** Đường dẫn an toàn: ký tự cho phép, không `..`, không `//`, không mã hoá `/` `.` `\`. */
export function safePath(path: string): boolean {
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(path)) return false;
  if (path.includes("..") || path.includes("//")) return false;
  return true;
}
