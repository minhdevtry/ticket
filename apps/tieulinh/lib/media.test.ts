import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveMediaFilePath, findRecentInboundMedia } from "./media";

describe("media resolution", () => {
  const tmpDir = path.join(os.tmpdir(), `test-openclaw-${Date.now()}`);
  const inboundDir = path.join(tmpDir, "media", "inbound");

  beforeEach(() => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    fs.mkdirSync(inboundDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("resolves direct absolute path", async () => {
    const p = path.join(inboundDir, "test.png");
    fs.writeFileSync(p, "png-content");
    const resolved = await resolveMediaFilePath(p);
    expect(resolved).toBe(p);
  });

  test("resolves media://inbound/ URI", async () => {
    const p = path.join(inboundDir, "uuid-123.jpg");
    fs.writeFileSync(p, "jpg-content");
    const resolved = await resolveMediaFilePath("media://inbound/uuid-123.jpg");
    expect(resolved).toBe(p);
  });

  test("resolves [image ...] and <media:image> tags", async () => {
    const p = path.join(inboundDir, "screen.png");
    fs.writeFileSync(p, "image-content");
    const resolved1 = await resolveMediaFilePath(`[image ${p}]`);
    expect(resolved1).toBe(p);
    const resolved2 = await resolveMediaFilePath(`<media:image> [image ${p}]`);
    expect(resolved2).toBe(p);
  });

  test("findRecentInboundMedia returns recent files sorted by mtime", () => {
    const f1 = path.join(inboundDir, "old.jpg");
    const f2 = path.join(inboundDir, "new.jpg");
    fs.writeFileSync(f1, "1");
    fs.writeFileSync(f2, "2");
    const now = Date.now();
    fs.utimesSync(f1, (now - 5000) / 1000, (now - 5000) / 1000);
    fs.utimesSync(f2, now / 1000, now / 1000);

    const list = findRecentInboundMedia(10);
    expect(list.length).toBe(2);
    expect(list[0]).toBe(f2);
    expect(list[1]).toBe(f1);
  });

  test("resolves openclaw-staged-* subdirectories and input-* prefix fallback", async () => {
    const stagedDir = path.join(inboundDir, "openclaw-staged-16f9bb82-7bef-45cd-89c2-d36fd6733bdc");
    fs.mkdirSync(stagedDir, { recursive: true });
    const stagedFile = path.join(stagedDir, "input-f396cc75-3642-4aba-9aa2-0b99ef27c16b.jpg");
    fs.writeFileSync(stagedFile, "jpeg-staged");

    expect(await resolveMediaFilePath(stagedDir)).toBe(stagedFile);
    expect(findRecentInboundMedia(10)).toContain(stagedFile);

    const flatFile = path.join(inboundDir, "a1b2c3d4.jpg");
    fs.writeFileSync(flatFile, "jpeg-flat");
    expect(await resolveMediaFilePath("input-a1b2c3d4.jpg")).toBe(flatFile);
    expect(await resolveMediaFilePath("media://inbound/input-a1b2c3d4.jpg")).toBe(flatFile);
  });
});
