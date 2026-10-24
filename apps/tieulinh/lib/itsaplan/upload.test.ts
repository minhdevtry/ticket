import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  formatAttachmentMarkdown,
  spliceAttachmentsIntoDescription,
  uploadAttachments,
} from "./upload";
import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

function fakeClient(
  uploadImpl: (filename: string) => { id: string; url: string; filename: string },
) {
  return {
    uploadAttachment: async (_issueId: number, filename: string) => uploadImpl(filename),
  } as unknown as ItsaplanClient;
}

describe("uploadAttachments", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  function writeTmpFile(name: string): string {
    const p = path.join(os.tmpdir(), `attachments-test-${Date.now()}-${name}`);
    fs.writeFileSync(p, "fake-bytes");
    tmpFiles.push(p);
    return p;
  }

  test("bỏ qua đường dẫn không tồn tại, không ném lỗi", async () => {
    const client = fakeClient(() => ({ id: "1", url: "/files/1", filename: "a.png" }));
    const result = await uploadAttachments(client, 1, "https://tracker.test", [
      "/khong-ton-tai.png",
    ]);
    expect(result).toEqual([]);
  });

  test("ghép baseUrl với url tương đối do tool trả về", async () => {
    const file = writeTmpFile("a.png");
    const client = fakeClient((filename) => ({ id: "1", url: "/files/1", filename }));
    const result = await uploadAttachments(client, 1, "https://tracker.test/", [file]);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://tracker.test/files/1");
  });

  test("giữ nguyên url tương đối khi baseUrl là loopback nội bộ để tránh Mixed Content", async () => {
    const file = writeTmpFile("a.png");
    const client = fakeClient((filename) => ({ id: "1", url: "/attachments/fake/raw", filename }));
    const result = await uploadAttachments(client, 1, "http://127.0.0.1:3100", [file]);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("/attachments/fake/raw");
  });

  test("giữ nguyên url đã là tuyệt đối", async () => {
    const file = writeTmpFile("a.png");
    const client = fakeClient((filename) => ({
      id: "1",
      url: "https://cdn.test/files/1",
      filename,
    }));
    const result = await uploadAttachments(client, 1, "https://tracker.test", [file]);
    expect(result[0].url).toBe("https://cdn.test/files/1");
  });

  test("upload lỗi một file không chặn các file còn lại", async () => {
    const good = writeTmpFile("good.png");
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

  test("tải lên thành công file từ inbound/ hoặc media://inbound/", async () => {
    const inboundFile = writeTmpFile("inbound_photo.jpg");
    const client = fakeClient((filename) => ({ id: "10", url: `/files/${filename}`, filename }));
    const result = await uploadAttachments(client, 1, "https://tracker.test", [inboundFile]);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toContain("inbound_photo.jpg");
  });
});

describe("spliceAttachmentsIntoDescription", () => {
  test("không đổi gì khi không có ảnh", () => {
    expect(spliceAttachmentsIntoDescription("mô tả gốc", [])).toBe("mô tả gốc");
  });

  test("chèn mục ảnh mới trước footer khi mô tả có ---", () => {
    const desc = "Nội dung chính\n\n---\n\n*Nguồn: test*";
    const out = spliceAttachmentsIntoDescription(desc, [
      { id: "1", url: "https://x/1.png", filename: "1.png" },
    ]);
    expect(out).toContain("### 📸 Ảnh đính kèm");
    expect(out).toContain("![1.png](https://x/1.png)");
    expect(out.indexOf("### 📸 Ảnh đính kèm")).toBeLessThan(out.indexOf("*Nguồn: test*"));
  });

  test("gộp vào mục ảnh đã có sẵn thay vì tạo mục thứ hai", () => {
    const desc = "### 📸 Ảnh đính kèm\n\n![cu.png](https://x/cu.png)\n\n---\n*Nguồn*";
    const out = spliceAttachmentsIntoDescription(desc, [
      { id: "2", url: "https://x/moi.png", filename: "moi.png" },
    ]);
    expect(out.match(/### 📸 Ảnh đính kèm/g)).toHaveLength(1);
    expect(out).toContain("cu.png");
    expect(out).toContain("moi.png");
  });

  test("nối vào cuối khi mô tả không có footer ---", () => {
    const out = spliceAttachmentsIntoDescription("chỉ có nội dung", [
      { id: "1", url: "https://x/1.png", filename: "1.png" },
    ]);
    expect(out).toContain("chỉ có nội dung");
    expect(out).toContain("### 📸 Ảnh đính kèm");
  });

  test("render video dưới dạng thẻ <video controls> thay vì ảnh ![]()", () => {
    const out = spliceAttachmentsIntoDescription("Mô tả sự cố", [
      { id: "v1", url: "https://x/clip.mp4", filename: "clip.mp4", contentType: "video/mp4" },
      { id: "i1", url: "https://x/screen.png", filename: "screen.png", contentType: "image/png" },
    ]);
    expect(out).toContain('<video src="https://x/clip.mp4" controls></video>');
    expect(out).toContain("![screen.png](https://x/screen.png)");
  });
});

describe("adapter Tiểu Linh: không trần kích thước, không escape markdown (như cũ)", () => {
  test("uploadAttachments tải cả file lớn hơn 20 MB (thư viện mặc định bỏ qua)", async () => {
    const p = path.join(
      os.tmpdir(),
      `tl-big-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
    );
    fs.writeFileSync(p, "");
    fs.truncateSync(p, 20 * 1024 * 1024 + 1);
    try {
      const client = fakeClient((filename) => ({ id: "v", url: `/f/${filename}`, filename }));
      const result = await uploadAttachments(client, 1, "https://tracker.test", [p]);
      expect(result).toHaveLength(1);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("formatAttachmentMarkdown / splice chèn tên file và URL nguyên văn", () => {
    const att = { id: "1", url: "/u/a b&c.png", filename: "anh_1.png", contentType: "image/png" };
    expect(formatAttachmentMarkdown(att)).toBe("![anh_1.png](/u/a b&c.png)");
    expect(spliceAttachmentsIntoDescription("mô tả", [att])).toContain(
      "![anh_1.png](/u/a b&c.png)",
    );
    expect([att].map(formatAttachmentMarkdown)[0]).toBe("![anh_1.png](/u/a b&c.png)");
  });
});
