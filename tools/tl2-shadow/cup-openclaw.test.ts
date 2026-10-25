import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanTmp, tmpDir } from "./fixtures.ts";

afterEach(cleanTmp);

const SCRIPT = join(import.meta.dir, "../../deploy/colab/cup-openclaw.sh");

/** Dựng một repo git tạm có `files`, chép script vào, chạy `--dry-run`. */
function run(files: string[], args: string[] = []) {
  const repo = tmpDir();
  const dest = join(repo, "deploy/colab/cup-openclaw.sh");
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

describe("cup-openclaw.sh: chốt chặn secret (M1)", () => {
  it("repo sạch (kể cả .env.example) đi tiếp tới dry-run", () => {
    const r = run([".env.example", "apps/a/index.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry-run");
  });

  for (const bad of [
    ".env",
    "apps/tieulinh-legacy/.env",
    ".env.production",
    "deploy/server.pem",
    "config/prod.key",
    "id_ed25519",
    "data/app.sqlite",
    "secrets/token.txt",
    "dump.sql",
    "gateway.token",
    ".npmrc",
  ]) {
    it(`chặn ${bad}`, () => {
      const r = run([bad]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("giống secret");
    });
  }

  it("chốt chặn hoạt động với nhiều file (không bị SIGPIPE làm mất tác dụng)", () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/dir${i}/file${i}.ts`);
    const r = run([...many, ".env"]);
    expect(r.code).toBe(1);
  });

  it("từ chối --model/--api chứa ký tự lạ", () => {
    expect(run([], ["--model", "a;rm -rf /"]).code).toBe(2);
    expect(run([], ["--api", "khac"]).code).toBe(2);
  });
});
