import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  formatAttachmentMarkdown,
  spliceAttachmentsIntoDescription,
  uploadAttachments,
  MAX_ATTACHMENT_BYTES,
  type MediaResolver,
} from "./attachments";
import type { ItsaplanClient } from "./client";

// Ported from intake `lib/itsaplan/attachments.test.ts` + CM `tests/itsaplan-project.test.ts`.
function fakeClient(
  uploadImpl: (filename: string) => { id: string; url: string; filename: string },
) {
  return {
    uploadAttachment: async (_issueId: number, filename: string) => uploadImpl(filename),
  } as unknown as ItsaplanClient;
}

describe("uploadAttachments", () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const f of tmp.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });
  function writeTmp(name: string): string {
    const p = path.join(
      os.tmpdir(),
      `attach-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`,
    );
    fs.writeFileSync(p, "fake-bytes");
    tmp.push(p);
    return p;
  }

  test("bỏ qua đường dẫn không tồn tại, không ném", async () => {
    const client = fakeClient(() => ({ id: "1", url: "/files/1", filename: "a.png" }));
    expect(
      await uploadAttachments(client, 1, "https://tracker.test", ["/khong-ton-tai.png"]),
    ).toEqual([]);
  });

  test("ghép baseUrl với url tương đối", async () => {
    const file = writeTmp("a.png");
    const client = fakeClient((filename) => ({ id: "1", url: "/files/1", filename }));
    const result = await uploadAttachments(client, 1, "https://tracker.test/", [file]);
    expect(result[0].url).toBe("https://tracker.test/files/1");
  });

  test("giữ nguyên url tương đối khi baseUrl loopback", async () => {
    const file = writeTmp("a.png");
    const client = fakeClient((filename) => ({ id: "1", url: "/attachments/fake/raw", filename }));
    const result = await uploadAttachments(client, 1, "http://127.0.0.1:3100", [file]);
    expect(result[0].url).toBe("/attachments/fake/raw");
  });

  test("giữ nguyên url tuyệt đối", async () => {
    const file = writeTmp("a.png");
    const client = fakeClient((filename) => ({
      id: "1",
      url: "https://cdn.test/files/1",
      filename,
    }));
    expect((await uploadAttachments(client, 1, "https://tracker.test", [file]))[0].url).toBe(
      "https://cdn.test/files/1",
    );
  });

  test("một file lỗi không chặn các file còn lại", async () => {
    const good = writeTmp("good.png");
    const client = {
      uploadAttachment: async (_id: number, filename: string) => {
        if (filename.includes("good")) return { id: "1", url: "/files/1", filename };
        throw new Error("boom");
      },
    } as unknown as ItsaplanClient;
    const result = await uploadAttachments(client, 1, "https://tracker.test", [
      good,
      "/khong-ton-tai.png",
    ]);
    expect(result).toHaveLength(1);
  });

  test("MediaResolver: resolve ref + từ chối path ngoài allow-list (CM hardening)", async () => {
    const file = writeTmp("inbound.jpg");
    const client = fakeClient((filename) => ({ id: "9", url: `/files/${filename}`, filename }));
    const media: MediaResolver = {
      resolve: (ref) => (ref === "media://inbound/inbound.jpg" ? file : ref),
      isAllowed: (abs) => abs === file,
    };
    // ref hợp lệ → upload
    const ok = await uploadAttachments(
      client,
      1,
      "https://tracker.test",
      ["media://inbound/inbound.jpg"],
      media,
    );
    expect(ok).toHaveLength(1);
    // path ngoài allow-list → bị từ chối
    const denied = writeTmp("secret.png");
    const blocked = await uploadAttachments(client, 1, "https://tracker.test", [denied], media);
    expect(blocked).toEqual([]);
  });
});

describe("formatAttachmentMarkdown", () => {
  test("ảnh / video / tệp khác", () => {
    expect(
      formatAttachmentMarkdown({ id: "1", filename: "photo.png", url: "https://x/photo.png" }),
    ).toBe("![photo.png](https://x/photo.png)");
    expect(
      formatAttachmentMarkdown({ id: "2", filename: "clip.mp4", url: "https://x/clip.mp4" }),
    ).toBe('<video src="https://x/clip.mp4" controls></video>');
  });
  test("escape ký tự markdown trong tên tệp (CM)", () => {
    const out = formatAttachmentMarkdown({
      id: "3",
      filename: "a[b]_c.png",
      url: "https://x/a.png",
    });
    expect(out).toContain("\\[b\\]");
  });
});

describe("spliceAttachmentsIntoDescription", () => {
  test("không đổi khi không có ảnh", () => {
    expect(spliceAttachmentsIntoDescription("mô tả gốc", [])).toBe("mô tả gốc");
  });
  test("chèn trước footer ---", () => {
    const out = spliceAttachmentsIntoDescription("Nội dung\n\n---\n\n*Nguồn*", [
      { id: "1", url: "https://x/1.png", filename: "1.png" },
    ]);
    expect(out).toContain("### 📸 Ảnh đính kèm");
    expect(out.indexOf("### 📸 Ảnh đính kèm")).toBeLessThan(out.indexOf("*Nguồn*"));
  });
  test("gộp vào mục ảnh có sẵn thay vì tạo mục thứ hai", () => {
    const desc = "### 📸 Ảnh đính kèm\n\n![cu.png](https://x/cu.png)\n\n---\n*Nguồn*";
    const out = spliceAttachmentsIntoDescription(desc, [
      { id: "2", url: "https://x/moi.png", filename: "moi.png" },
    ]);
    expect(out.match(/### 📸 Ảnh đính kèm/g)).toHaveLength(1);
    expect(out).toContain("moi.png");
  });
  test("render video thẻ <video>", () => {
    const out = spliceAttachmentsIntoDescription("Mô tả", [
      { id: "v1", url: "https://x/clip.mp4", filename: "clip.mp4", contentType: "video/mp4" },
    ]);
    expect(out).toContain('<video src="https://x/clip.mp4" controls></video>');
  });
});

describe("opts (hành vi intake cũ cho bot cần)", () => {
  const att = { id: "1", url: "/u/a b&c.png", filename: "anh_1.png", contentType: "image/png" };

  test("formatAttachmentMarkdown: mặc định escape, escape:false chèn nguyên văn", () => {
    expect(formatAttachmentMarkdown(att)).toBe("![anh\\_1.png](/u/a&#32;b&#38;c.png)");
    expect(formatAttachmentMarkdown(att, { escape: false })).toBe("![anh_1.png](/u/a b&c.png)");
  });

  test("`.map(formatAttachmentMarkdown)` (chỉ số làm tham số 2) vẫn escape mặc định", () => {
    expect([att].map(formatAttachmentMarkdown as (a: typeof att, i: number) => string)[0]).toBe(
      "![anh\\_1.png](/u/a&#32;b&#38;c.png)",
    );
  });

  test("spliceAttachmentsIntoDescription truyền escape xuống từng đính kèm", () => {
    expect(spliceAttachmentsIntoDescription("mô tả", [att], { escape: false })).toContain(
      "![anh_1.png](/u/a b&c.png)",
    );
    expect(spliceAttachmentsIntoDescription("mô tả", [att])).toContain("anh\\_1.png");
  });

  test("uploadAttachments: trần mặc định 20 MB bỏ file lớn; maxBytes: Infinity vẫn tải", async () => {
    const p = path.join(
      os.tmpdir(),
      `attach-big-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
    );
    fs.writeFileSync(p, "");
    fs.truncateSync(p, MAX_ATTACHMENT_BYTES + 1); // file thưa, không tốn đĩa
    try {
      const client = fakeClient((filename) => ({ id: "x", url: `/f/${filename}`, filename }));
      expect(await uploadAttachments(client, 1, "https://t.test", [p])).toHaveLength(0);
      const all = await uploadAttachments(client, 1, "https://t.test", [p], undefined, {
        maxBytes: Number.POSITIVE_INFINITY,
      });
      expect(all).toHaveLength(1);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("uploadAttachments: maxBytes tuỳ chỉnh nhỏ hơn mặc định", async () => {
    const p = path.join(
      os.tmpdir(),
      `attach-small-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fs.writeFileSync(p, "0123456789");
    try {
      const client = fakeClient((filename) => ({ id: "x", url: `/f/${filename}`, filename }));
      expect(
        await uploadAttachments(client, 1, "https://t.test", [p], undefined, { maxBytes: 5 }),
      ).toHaveLength(0);
      expect(
        await uploadAttachments(client, 1, "https://t.test", [p], undefined, { maxBytes: 10 }),
      ).toHaveLength(1);
    } finally {
      fs.unlinkSync(p);
    }
  });
});
