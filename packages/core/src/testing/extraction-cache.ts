/**
 * Extraction Cache (RFC 0002 PR 6, Acceptance Criterion 3).
 *
 * Caches field extraction outputs deterministically so that replaying conversations
 * yields identical results across multiple runs, even when offline (no network, no LLM).
 *
 * File storage is strictly private (0700 dir, 0600 file) per ADR-0005.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ExtractedFields, ExtractInput, FieldExtractorPort } from "../intake/ports";

export class ExtractionCacheMissError extends Error {
  constructor(key: string) {
    super(`Extraction cache miss in offline mode for key: ${key}`);
    this.name = "ExtractionCacheMissError";
  }
}

export interface CachedFieldExtractorOptions {
  /** Optional file path to persist cache entries (JSONL, 0600 file in 0700 dir). */
  filePath?: string;
  /**
   * If true, never calls the inner extractor; throws ExtractionCacheMissError on miss.
   * Useful to assert 100% deterministic offline replay without network/LLM.
   */
  offlineOnly?: boolean;
}

export function computeExtractKey(input: ExtractInput): string {
  const norm = {
    text: input.text.trim(),
    attachments: input.attachments ?? 0,
    draftTitle: (input.draftTitle ?? "").trim(),
    context: input.context ?? null,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
}

interface CacheRecord {
  k: string;
  v: ExtractedFields;
}

export class CachedFieldExtractor implements FieldExtractorPort {
  private cache = new Map<string, ExtractedFields>();
  private filePath?: string;
  private offlineOnly: boolean;

  constructor(
    private readonly inner: FieldExtractorPort,
    options: CachedFieldExtractorOptions = {},
  ) {
    this.filePath = options.filePath;
    this.offlineOnly = options.offlineOnly ?? false;

    if (this.filePath) {
      this.loadFromFile(this.filePath);
    }
  }

  setOffline(offline: boolean): void {
    this.offlineOnly = offline;
  }

  isOffline(): boolean {
    return this.offlineOnly;
  }

  size(): number {
    return this.cache.size;
  }

  has(input: ExtractInput): boolean {
    return this.cache.has(computeExtractKey(input));
  }

  get(input: ExtractInput): ExtractedFields | undefined {
    return this.cache.get(computeExtractKey(input));
  }

  set(input: ExtractInput, fields: ExtractedFields): void {
    const key = computeExtractKey(input);
    this.cache.set(key, fields);
    if (this.filePath) {
      this.persistRecord({ k: key, v: fields });
    }
  }

  clear(): void {
    this.cache.clear();
    if (this.filePath && existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", { mode: 0o600 });
    }
  }

  async extract(input: ExtractInput): Promise<ExtractedFields> {
    const key = computeExtractKey(input);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    if (this.offlineOnly) {
      throw new ExtractionCacheMissError(key);
    }

    const result = await this.inner.extract(input);
    this.cache.set(key, result);
    if (this.filePath) {
      this.persistRecord({ k: key, v: result });
    }
    return result;
  }

  private loadFromFile(path: string): void {
    ensurePrivateDir(dirname(path));
    if (!existsSync(path)) {
      writeFileSync(path, "", { mode: 0o600 });
      return;
    }
    try {
      chmodSync(path, 0o600);
    } catch {}

    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as CacheRecord;
        if (record.k && record.v) {
          this.cache.set(record.k, record.v);
        }
      } catch {}
    }
  }

  private persistRecord(record: CacheRecord): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {}
  }
}
