/**
 * Smoke test KHÔNG qua gateway: bundle plugin mẫu bằng `bun build
 * --target=node --format=esm` ra MỘT file, rồi import file đó và chạy các hook
 * với một `api` giả. Chứng minh:
 *   1. kit bundle được thành một .mjs node/esm độc lập (không còn import ngoài);
 *   2. plugin tải và chạy đúng — ký _identity qua helper của kit.
 *
 * Chạy: `bun examples/openclaw-plugin-demo/smoke.mjs`
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.mjs");
const REPO = join(HERE, "..", "..");

// Bản bare-specifier `@vuihoc/bot-core/openclaw` chỉ resolve khi gói nằm trong
// node_modules — chính là layout một consumer có sau khi `bun install` git dep.
// Tự dựng self-link idempotent để smoke test chạy được ở worktree sạch.
const linkDir = join(REPO, "node_modules", "@vuihoc");
const linkPath = join(linkDir, "bot-core");
if (!existsSync(linkPath)) {
  mkdirSync(linkDir, { recursive: true });
  try {
    symlinkSync(REPO, linkPath, "dir");
  } catch {
    /* đã tồn tại giữa chừng — bỏ qua */
  }
}

const outDir = mkdtempSync(join(tmpdir(), "demo-bundle-"));
const outFile = join(outDir, "plugin.bundle.mjs");

function assert(cond, msg) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }
}

try {
  // 1. Bundle thành một file (giống cách vendor bản .mjs cho gateway).
  const build = spawnSync(
    "bun",
    ["build", ENTRY, "--target=node", "--format=esm", "--outfile", outFile],
    { encoding: "utf8" },
  );
  assert(build.status === 0, `bun build thất bại: ${build.stderr || build.stdout}`);

  // 2. Import file bundle đã dựng (KHÔNG resolver của bot — y như gateway nạp .mjs).
  const mod = await import(outFile);
  const plugin = mod.default;
  assert(plugin && typeof plugin.register === "function", "plugin không có register()");
  assert(plugin.id === "openclaw-plugin-demo", "id plugin sai");

  // 3. api giả: thu các hook plugin đăng ký.
  const hooks = new Map();
  const api = { on: (name, fn) => hooks.set(name, fn) };
  process.env.DEMO_IDENTITY_SECRET = "smoke-secret";
  process.env.DEMO_AGENT_IDS = "demo-agent";
  plugin.register(api);
  assert(hooks.has("before_agent_run") && hooks.has("before_tool_call"), "thiếu hook");

  const ctx = {
    agentId: "demo-agent",
    runId: "run-xyz",
    senderId: 555000001,
    sessionKey: "agent:demo-agent:x",
  };

  // 4. before_agent_run nhớ danh tính; before_tool_call ký _identity.
  await hooks.get("before_agent_run")({ runId: "run-xyz", senderId: 555000001 }, ctx);
  const res = await hooks.get("before_tool_call")(
    { toolName: "demo__do_thing", params: { x: 1 } },
    ctx,
  );
  assert(res && res.params, "before_tool_call không trả params");
  const token = res.params._identity;
  assert(typeof token === "string" && token.includes("."), "không ký được _identity");

  // 5. Verify token bằng chính kit (import TS trực tiếp qua Bun) — khớp chéo.
  const { verifyIdentityToken } = await import(
    join(HERE, "..", "..", "src", "openclaw", "identity-token.ts")
  );
  const payload = verifyIdentityToken(token, { toolName: "do_thing", secret: "smoke-secret" });
  assert(payload.u === "555000001", `payload.u sai: ${payload.u}`);

  // 6. Agent ngoài phạm vi KHÔNG bị ký.
  const outOfScope = await hooks.get("before_tool_call")(
    { toolName: "demo__do_thing", params: {} },
    { agentId: "khac", runId: "r2" },
  );
  assert(outOfScope === undefined, "lượt agent khác đáng lẽ bị bỏ qua");

  console.log(
    "SMOKE OK: bundle dựng được, plugin tải+chạy, _identity ký & verify khớp, agent-gating đúng.",
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
