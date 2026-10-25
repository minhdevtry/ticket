import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanTmp, tmpDir } from "./fixtures.ts";

afterEach(cleanTmp);

const SCRIPT = join(import.meta.dir, "../../deploy/colab/cup-tieulinh.sh");

/** Dựng một repo git tạm có `files`, chép script vào, chạy `--dry-run`. */
function run(files: string[], args: string[] = []) {
  const repo = tmpDir();
  const dest = join(repo, "deploy/colab/cup-tieulinh.sh");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(SCRIPT, dest);
  for (const f of ["README.md", ...files]) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), "x");
  }
  const git = (...a: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
      cwd: repo,
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  const r = Bun.spawnSync(["bash", dest, "--dry-run", ...args], { cwd: repo });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("cup-tieulinh.sh", () => {
  it("repo sạch (kể cả .env.example) đi tới dry-run, chỉ đẩy code đã commit", () => {
    const r = run([".env.example", "apps/a/index.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry-run");
    expect(r.out).toContain("chỉ code đã commit");
  });

  for (const bad of [
    ".env",
    "apps/tieulinh/.env",
    "data/app.sqlite",
    "gateway.token",
    "secrets/x",
  ]) {
    it(`chặn ${bad}`, () => {
      const r = run([bad]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("giống secret");
    });
  }

  it("từ chối --model chứa ký tự lạ, ref không tồn tại và tham số lạ", () => {
    expect(run([], ["--model", "a;rm -rf /"]).code).toBe(2);
    expect(run([], ["-r", "khong-co-ref"]).code).toBe(2);
    expect(run([], ["--khac"]).code).toBe(2);
  });
});
