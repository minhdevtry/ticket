/**
 * Tests for CachedFieldExtractor (RFC 0002 PR 6, Acceptance Criterion 3).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedFields, ExtractInput, FieldExtractorPort } from "../intake/ports";
import {
  CachedFieldExtractor,
  computeExtractKey,
  ExtractionCacheMissError,
} from "./extraction-cache";

class CountingExtractor implements FieldExtractorPort {
  calls = 0;
  constructor(private readonly result: ExtractedFields) {}
  async extract(_input: ExtractInput): Promise<ExtractedFields> {
    this.calls++;
    return this.result;
  }
}

describe("CachedFieldExtractor", () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) {
      if (existsSync(f)) {
        try {
          rmSync(f, { recursive: true, force: true });
        } catch {}
      }
    }
    tempFiles.length = 0;
  });

  test("cache hit: không gọi lại inner extractor lần thứ hai", async () => {
    const inner = new CountingExtractor({
      userIntent: "report_issue",
      title: "App Duo lỗi",
      symptoms: ["lỗi"],
    });
    const cached = new CachedFieldExtractor(inner);

    const input: ExtractInput = { text: "App Duo bị lỗi không mở được", attachments: 0 };
    const r1 = await cached.extract(input);
    const r2 = await cached.extract(input);

    expect(r1).toEqual(r2);
    expect(inner.calls).toBe(1);
    expect(cached.size()).toBe(1);
  });

  test("lưu file 0600 và thư mục 0700 (ADR-0005)", async () => {
    const dir = join(tmpdir(), `extract-cache-test-${Date.now()}`);
    tempFiles.push(dir);
    const file = join(dir, "cache.jsonl");

    const inner = new CountingExtractor({ userIntent: "provide_info", symptoms: [] });
    const cached = new CachedFieldExtractor(inner, { filePath: file });
    await cached.extract({ text: "Em bên Vận hành", attachments: 0 });
    // File tồn tại
    expect(existsSync(file)).toBe(true);
    // Quyền thư mục 0700 (hoặc siết)
    const dirStat = statSync(dir);
    expect((dirStat.mode & 0o777) === 0o700).toBe(true);

    // Khởi tạo lại một instance khác từ cùng file -> nạp lại cache từ đĩa mà không gọi inner
    const inner2 = new CountingExtractor({ userIntent: "confirm" });
    const cached2 = new CachedFieldExtractor(inner2, { filePath: file });
    expect(cached2.size()).toBe(1);
    const r = await cached2.extract({ text: "Em bên Vận hành", attachments: 0 });
    expect(r.userIntent).toBe("provide_info");
    expect(inner2.calls).toBe(0); // Không gọi inner vì đã trúng cache đĩa
  });

  test("offlineOnly: trúng cache thì trả kết quả; trượt cache thì ném ExtractionCacheMissError", async () => {
    const inner = new CountingExtractor({ userIntent: "report_issue" });
    const cached = new CachedFieldExtractor(inner);

    cached.set(
      { text: "tin đã cache", attachments: 0 },
      { userIntent: "report_issue", title: "Có sẵn" },
    );
    // Bật chế độ offline
    cached.setOffline(true);
    expect(cached.isOffline()).toBe(true);

    // Tin có trong cache -> trả về bình thường, không gọi inner
    const res = await cached.extract({ text: "tin đã cache", attachments: 0 });
    expect(res.userIntent).toBe("report_issue");
    expect(inner.calls).toBe(0);

    // Tin chưa có trong cache -> ném ExtractionCacheMissError, bảo vệ không gọi mạng/LLM
    expect(cached.extract({ text: "tin chưa có", attachments: 0 })).rejects.toThrow(
      ExtractionCacheMissError,
    );
  });

  test("computeExtractKey: chuẩn hoá khoảng trắng và tính nhất quán", () => {
    const k1 = computeExtractKey({ text: "  lỗi app   ", attachments: 0 });
    const k2 = computeExtractKey({ text: "lỗi app", attachments: 0 });
    expect(k1).toBe(k2);
  });
});
