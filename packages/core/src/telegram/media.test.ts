/** Inbound media finder + engine adapters. Uses a real temp dir under $PARITY_SCRATCH. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findRecentInboundMedia,
  findLatestInboundMedia,
  resolveInboundRef,
  readLocalMedia,
  isAllowedPath,
  sniffImageContentType,
  createInboundMediaResolver,
  type MediaFinderOptions,
} from "./media";
import { inboundMediaResolver, toTelegramButtons } from "./adapter";

const SCRATCH = process.env.PARITY_SCRATCH || tmpdir();
let inboundDir: string;
let opts: MediaFinderOptions;

beforeEach(() => {
  inboundDir = mkdtempSync(join(SCRATCH, "tg-media-"));
  opts = { inboundDir };
});
afterEach(() => {
  rmSync(inboundDir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0, 0]);

function writeInbound(name: string, buf: Buffer, ageMinutes = 0): string {
  const p = join(inboundDir, name);
  writeFileSync(p, buf);
  if (ageMinutes > 0) {
    const t = new Date(Date.now() - ageMinutes * 60_000);
    utimesSync(p, t, t);
  }
  return p;
}

describe("inbound media finder (intake findRecentInboundMedia ∪ CM hardening)", () => {
  test("found: returns recent files newest-first within the age window", () => {
    writeInbound("old.png", PNG, 30); // outside 10-min window
    writeInbound("a.png", PNG, 2);
    writeInbound("b.jpg", JPEG, 1);
    const found = findRecentInboundMedia(opts, 10, 5);
    expect(found.map((f) => f.filename)).toEqual(["b.jpg", "a.png"]); // newest first, old excluded
  });

  test("not found: empty when dir missing or no recent files", () => {
    expect(findRecentInboundMedia({ inboundDir: join(inboundDir, "nope") })).toEqual([]);
    writeInbound("stale.png", PNG, 120);
    expect(findRecentInboundMedia(opts, 10)).toEqual([]);
    expect(findLatestInboundMedia(opts, 10)).toBeNull();
  });

  test("CM hardening: resolveInboundRef rejects traversal tokens", () => {
    expect(resolveInboundRef("media://inbound/../../etc/passwd", opts)).toBeNull();
    expect(resolveInboundRef("inbound/..\\windows", opts)).toBeNull();
    expect(resolveInboundRef("../escape.png", opts)).toBeNull();
    // A clean inbound ref resolves under the dir.
    const good = resolveInboundRef("media://inbound/pic.png", opts);
    expect(good).toBe(join(inboundDir, "pic.png"));
  });

  test("isAllowedPath confines reads to the inbound dir", () => {
    const inside = writeInbound("in.png", PNG);
    expect(isAllowedPath(inside, opts)).toBe(true);
    expect(isAllowedPath("/etc/passwd", opts)).toBe(false);
  });

  test("readLocalMedia sniffs content type and enforces the allow-list", () => {
    writeInbound("shot.png", PNG);
    const m = readLocalMedia("media://inbound/shot.png", opts);
    expect(m?.contentType).toBe("image/png");
    expect(m?.filename).toBe("shot.png");
    expect(readLocalMedia("media://inbound/missing.png", opts)).toBeNull();
  });

  test("sniffImageContentType reads magic bytes", () => {
    expect(sniffImageContentType(PNG)).toBe("image/png");
    expect(sniffImageContentType(JPEG)).toBe("image/jpeg");
    expect(sniffImageContentType(Buffer.from("not an image"))).toBeNull();
  });

  test("createInboundMediaResolver satisfies the itsaplan MediaResolver port", () => {
    const p = writeInbound("doc.png", PNG);
    const r = createInboundMediaResolver(opts);
    expect(r.resolve("media://inbound/doc.png")).toBe(p);
    expect(r.resolve("media://inbound/gone.png")).toBeNull();
    expect(r.isAllowed(p)).toBe(true);
    expect(r.isAllowed("/etc/passwd")).toBe(false);
  });
});

describe("intake engine adapters", () => {
  test("inboundMediaResolver passes explicit paths through de-duplicated", () => {
    const r = inboundMediaResolver(opts);
    expect(r.resolve(["/a", "/a", "/b"], [])).toEqual(["/a", "/b"]);
  });

  test("inboundMediaResolver falls back to recent inbound on a text-only hint", () => {
    writeInbound("hint.png", PNG, 1);
    const r = inboundMediaResolver(opts);
    // Reporter only said "em gửi ảnh rồi" — no explicit path, but a hint.
    const resolved = r.resolve([], ["em gửi ảnh rồi ạ"]);
    expect(resolved).toEqual([join(inboundDir, "hint.png")]);
    // No hint and no explicit path ⇒ nothing.
    expect(r.resolve([], [])).toEqual([]);
    expect(r.resolve([], ["   "])).toEqual([]);
  });

  test("toTelegramButtons converts callbackData → callback_data", () => {
    expect(
      toTelegramButtons([[{ text: "Có", callbackData: "yes" }], [{ text: "Không", callbackData: "no" }]]),
    ).toEqual([
      [{ text: "Có", callback_data: "yes" }],
      [{ text: "Không", callback_data: "no" }],
    ]);
  });
});
