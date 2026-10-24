import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanTmp, tmpDir } from "../fixtures.ts";
import { ensureToken, syncWorkspace } from "./bootstrap.ts";

afterEach(cleanTmp);

function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("syncWorkspace", () => {
  it("chép file của bot và skill dùng chung, giữ dữ liệu chạy, xoá skill đã bỏ", () => {
    const root = tmpDir();
    const skills = join(root, "skills");
    const ws = join(root, "ws");
    put(join(skills, "tieulinh/AGENTS.md"), "agents");
    put(join(skills, "tieulinh/skills/incident-intake/SKILL.md"), "intake");
    put(join(skills, "_shared/skills/confirm/SKILL.md"), "confirm");
    put(join(skills, "_shared/AGENTS.md"), "không chép");
    put(join(ws, "skills/cu-da-xoa/SKILL.md"), "cũ");
    put(join(ws, "messages/state.json"), "{}");

    expect(syncWorkspace(skills, ws)).toBe(3);
    expect(readFileSync(join(ws, "AGENTS.md"), "utf8")).toBe("agents");
    expect(existsSync(join(ws, "skills/incident-intake/SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, "skills/confirm/SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, "skills/cu-da-xoa"))).toBe(false);
    expect(existsSync(join(ws, "messages/state.json"))).toBe(true);
    expect(existsSync(join(ws, "_shared"))).toBe(false);
  });
});

describe("ensureToken", () => {
  it("sinh token ngẫu nhiên 0600 một lần rồi giữ nguyên", () => {
    const p = join(tmpDir(), "gateway.token");
    const a = ensureToken(p);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(ensureToken(p)).toBe(a);
  });
});
