import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  identityApplySchema,
  SqliteIdentityRepository,
  IdentityService,
  relinkIdentity,
  relinkIdentityAndBindings,
  type IdentityRepository,
} from ".";
import { SqliteChannelBindingStore } from "../intake/create/binding-store";
import { intakeApplySchema } from "../intake/draft/schema";

let db: Database;
let repo: SqliteIdentityRepository;

beforeEach(() => {
  db = new Database(":memory:");
  identityApplySchema(db, { wal: false });
  repo = new SqliteIdentityRepository(db);
});
afterEach(() => db.close());

// ── repository round-trip ──────────────────────────────────────────────────
describe("SqliteIdentityRepository (:memory:)", () => {
  test("save + read round-trips with the userId rename over telegram_user_id", () => {
    repo.saveUserIdentity({
      userId: "123",
      nameCode: "TE_usera",
      fullName: "Lan",
      status: "pending",
    });
    const got = repo.getUserIdentity("123");
    expect(got?.userId).toBe("123");
    expect(got?.nameCode).toBe("TE_usera");
    expect(got?.fullName).toBe("Lan");
    expect(got?.status).toBe("pending");
    // name-code lookup is case-insensitive
    expect(repo.getUserIdentityByNameCode("te_usera")?.userId).toBe("123");
  });

  test("upsert: chuỗi rỗng KHÔNG ghi đè fullName/username/pendingReport/approvedBy/department đã lưu (|| như intake)", () => {
    repo.saveUserIdentity({
      userId: "9",
      nameCode: "TE_x",
      fullName: "Lan",
      username: "lan_u",
      pendingReport: '{"a":1}',
      status: "approved",
      approvedBy: "admin",
      department: "IT",
    });
    repo.saveUserIdentity({
      userId: "9",
      nameCode: "TE_x",
      fullName: "",
      username: "",
      pendingReport: "",
      approvedBy: "",
      department: "",
    });
    const got = repo.getUserIdentity("9");
    expect(got?.fullName).toBe("Lan");
    expect(got?.username).toBe("lan_u");
    expect(got?.pendingReport).toBe('{"a":1}');
    expect(got?.approvedBy).toBe("admin");
    expect(got?.department).toBe("IT");
  });

  test("approve / reject / department / pending report mutate the row", () => {
    repo.saveUserIdentity({ userId: "1", nameCode: "TE_a" });
    repo.approveUserIdentity("1", "admin");
    expect(repo.getUserIdentity("1")?.status).toBe("approved");
    repo.rejectUserIdentity("1");
    expect(repo.getUserIdentity("1")?.status).toBe("rejected");
    repo.updateDepartment("1", "IT");
    expect(repo.getUserIdentity("1")?.department).toBe("IT");
    repo.savePendingReport("1", '{"x":1}');
    expect(repo.getPendingReport("1")).toBe('{"x":1}');
    repo.clearPendingReport("1");
    expect(repo.getPendingReport("1")).toBeNull();
  });

  test("prefix approval + listPending", () => {
    repo.saveUserIdentity({ userId: "1", nameCode: "TE_a", status: "pending" });
    repo.saveUserIdentity({ userId: "2", nameCode: "PO_b", status: "approved" });
    expect(repo.listPendingIdentities().map((i) => i.userId)).toEqual(["1"]);
    expect(repo.isPrefixApproved("TE")).toBe(false);
    repo.approvePrefix("te", "admin");
    expect(repo.isPrefixApproved("TE")).toBe(true);
  });
});

// ── registration ────────────────────────────────────────────────────────────
describe("IdentityService.registerIdentity", () => {
  test("valid registration (requireApproval default false)", () => {
    const svc = new IdentityService(repo);
    const r = svc.registerIdentity({ userId: "1", nameCode: "te_usera" });
    expect(r.success).toBe(true);
    expect(r.autoApproved).toBe(true);
    expect(r.reason).toBe("auto_approved_open");
    expect(r.nameCode).toBe("TE_usera"); // normalized prefix upper-cased
    expect(repo.getUserIdentity("1")?.status).toBe("approved");
  });

  test("invalid format is refused with a reason code and no copy", () => {
    const svc = new IdentityService(repo);
    const r = svc.registerIdentity({ userId: "1", nameCode: "notacode" });
    expect(r.success).toBe(false);
    expect(r.reason).toBe("invalid_format");
    // structured only — no Vietnamese leaked into the service result
    expect(Object.keys(r)).not.toContain("message");
  });

  test("conflict: name_code already bound to a different user", () => {
    const svc = new IdentityService(repo);
    svc.registerIdentity({ userId: "1", nameCode: "TE_usera" });
    const r = svc.registerIdentity({ userId: "2", nameCode: "TE_usera" });
    expect(r.success).toBe(false);
    expect(r.reason).toBe("conflict");
    // same user re-registering their own code is NOT a conflict
    const same = svc.registerIdentity({ userId: "1", nameCode: "TE_usera" });
    expect(same.success).toBe(true);
  });

  test("auto-approve: admin", () => {
    const svc = new IdentityService(repo, { adminIds: ["9"] });
    const r = svc.registerIdentity({ userId: "9", nameCode: "OP_boss" });
    expect(r.autoApproved).toBe(true);
    expect(r.reason).toBe("auto_approved_admin");
    expect(repo.getUserIdentity("9")?.status).toBe("approved");
    expect(repo.getUserIdentity("9")?.approvedBy).toBe("admin");
  });

  test("auto-approve: approved prefix", () => {
    repo.approvePrefix("TE", "admin");
    const svc = new IdentityService(repo, { requireApproval: true });
    const r = svc.registerIdentity({ userId: "1", nameCode: "TE_usera" });
    expect(r.autoApproved).toBe(true);
    expect(r.reason).toBe("auto_approved_prefix");
    expect(repo.getUserIdentity("1")?.approvedBy).toBe("prefix_rule");
  });

  test("pending registration when requireApproval is true", () => {
    const svc = new IdentityService(repo, { requireApproval: true });
    const r = svc.registerIdentity({ userId: "1", nameCode: "TE_usera" });
    expect(r.success).toBe(true);
    expect(r.autoApproved).toBe(false);
    expect(r.reason).toBe("pending");
    expect(repo.getUserIdentity("1")?.status).toBe("pending");
  });
});

// ── approve / reject ──────────────────────────────────────────────────────────
describe("IdentityService.approveUser / rejectUser", () => {
  test("approve a pending user; reject sets rejected; not_found on unknown", () => {
    const svc = new IdentityService(repo, { requireApproval: true });
    svc.registerIdentity({ userId: "1", nameCode: "TE_a" });
    const a = svc.approveUser("1", "admin42");
    expect(a.success).toBe(true);
    expect(a.identity?.status).toBe("approved");
    expect(repo.getUserIdentity("1")?.approvedBy).toBe("admin42");
    const rj = svc.rejectUser("1");
    expect(rj.identity?.status).toBe("rejected");
    const miss = svc.approveUser("999", "admin");
    expect(miss.success).toBe(false);
    expect(miss.reason).toBe("not_found");
  });
});

// ── checkUserApproval ─────────────────────────────────────────────────────────
describe("IdentityService.checkUserApproval", () => {
  test("admin always approved; unknown user not approved; approved user approved", () => {
    const svc = new IdentityService(repo, { adminIds: ["9"], requireApproval: true });
    expect(svc.checkUserApproval("9").isApproved).toBe(true);
    expect(svc.checkUserApproval("unknown").isApproved).toBe(false);
    svc.registerIdentity({ userId: "1", nameCode: "TE_a" });
    svc.approveUser("1", "admin");
    expect(svc.checkUserApproval("1").isApproved).toBe(true);
  });

  test("rejected user reports isRejected", () => {
    const svc = new IdentityService(repo, { requireApproval: true });
    svc.registerIdentity({ userId: "1", nameCode: "TE_a" });
    svc.rejectUser("1");
    const c = svc.checkUserApproval("1");
    expect(c.isRejected).toBe(true);
    expect(c.isApproved).toBe(false);
  });

  test("prefix auto-promote on check: a pending user is promoted when its prefix is approved", () => {
    const svc = new IdentityService(repo, { requireApproval: true });
    svc.registerIdentity({ userId: "1", nameCode: "TE_a" }); // pending
    expect(svc.checkUserApproval("1").isPending).toBe(true);
    repo.approvePrefix("TE", "admin");
    const c = svc.checkUserApproval("1");
    expect(c.isApproved).toBe(true);
    // persisted, not just computed
    expect(repo.getUserIdentity("1")?.status).toBe("approved");
    expect(repo.getUserIdentity("1")?.approvedBy).toBe("prefix_rule");
  });

  test("a rejected user is NOT revived by a prefix approval", () => {
    const svc = new IdentityService(repo, { requireApproval: true });
    svc.registerIdentity({ userId: "1", nameCode: "TE_a" });
    svc.rejectUser("1");
    repo.approvePrefix("TE", "admin");
    expect(svc.checkUserApproval("1").isRejected).toBe(true);
  });
});

// ── normalize / extract ───────────────────────────────────────────────────────
describe("name-code normalize / validate / extract", () => {
  const svc = () => new IdentityService(repo);

  test("validateNameCodeFormat with default and custom pattern", () => {
    const s = svc();
    expect(s.validateNameCodeFormat("TE_usera")).toBe(true);
    expect(s.validateNameCodeFormat("x")).toBe(false);
    const custom = new IdentityService(repo, { nameCodePattern: /^GV\d+$/ });
    expect(custom.validateNameCodeFormat("GV12")).toBe(true);
    expect(custom.validateNameCodeFormat("TE_usera")).toBe(false);
  });

  test("normalizeNameCode upper-cases the prefix, strips a leading @", () => {
    const s = svc();
    expect(s.normalizeNameCode("@te_usera")).toBe("TE_usera");
    expect(s.normalizeNameCode("Te_LanNT")).toBe("TE_LanNT");
  });

  test("extractPrefix", () => {
    expect(svc().extractPrefix("TE_usera")).toBe("TE");
    expect(svc().extractPrefix("nounder")).toBe("");
  });

  test("extractNameCodeFromText finds a code in a sentence", () => {
    const s = svc();
    expect(s.extractNameCodeFromText("TE_usera")).toBe("TE_usera");
    expect(s.extractNameCodeFromText("mã của em là te_usera nhé")).toBe("TE_usera");
    expect(s.extractNameCodeFromText("không có mã ở đây")).toBeNull();
  });
});

// ── relink: history preservation + anti-takeover guard ──────────────────────
describe("relinkIdentity", () => {
  const authAdmins = ["admin1"];
  const okApprover = (a: string) => a === "admin1" || a === "lead1";

  function seedApproved() {
    const svc = new IdentityService(repo);
    svc.registerIdentity({ userId: "100", nameCode: "TE_usera", fullName: "Lan" });
    svc.approveUser("100", "admin1");
    repo.updateDepartment("100", "IT"); // history keyed by name_code
  }

  test("preserves history (department, name_code) while rebinding the userId", () => {
    seedApproved();
    const r = relinkIdentity(
      repo,
      { nameCode: "te_usera", newUserId: "200", approver: "lead1" },
      { isAuthorizedApprover: okApprover, protectedAdminIds: authAdmins },
    );
    expect(r.success).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.identity?.userId).toBe("200");
    expect(r.identity?.department).toBe("IT"); // preserved
    expect(r.identity?.status).toBe("approved"); // preserved
    expect(repo.getUserIdentity("100")).toBeNull(); // old id gone
    expect(repo.getUserIdentityByNameCode("TE_usera")?.userId).toBe("200");
  });

  test("GUARD: an unauthorized approver (free string) cannot relink — the anti-takeover fix", () => {
    seedApproved();
    const r = relinkIdentity(
      repo,
      { nameCode: "TE_usera", newUserId: "200", approver: "attacker" },
      { isAuthorizedApprover: okApprover, protectedAdminIds: authAdmins },
    );
    expect(r.success).toBe(false);
    expect(r.reason).toBe("unauthorized_approver");
    expect(repo.getUserIdentityByNameCode("TE_usera")?.userId).toBe("100"); // unchanged
  });

  test("GUARD: cannot relink ONTO a protected admin id", () => {
    seedApproved();
    const r = relinkIdentity(
      repo,
      { nameCode: "TE_usera", newUserId: "admin1", approver: "admin1" },
      { isAuthorizedApprover: okApprover, protectedAdminIds: authAdmins },
    );
    expect(r.success).toBe(false);
    expect(r.reason).toBe("target_is_admin");
  });

  test("GUARD: a non-numeric id cannot take the primary key", () => {
    seedApproved();
    const r = relinkIdentity(
      repo,
      { nameCode: "TE_usera", newUserId: "@someusername", approver: "admin1" },
      { isAuthorizedApprover: okApprover, protectedAdminIds: authAdmins },
    );
    expect(r.success).toBe(false);
    expect(r.reason).toBe("non_numeric_new_user_id");
  });

  test("not_found for an unknown name_code (authorized approver)", () => {
    const r = relinkIdentity(
      repo,
      { nameCode: "ZZ_nobody", newUserId: "200", approver: "admin1" },
      { isAuthorizedApprover: okApprover },
    );
    expect(r.success).toBe(false);
    expect(r.reason).toBe("not_found");
  });

  test("works against a fake repo implementing the port (injected deps)", () => {
    const rows = new Map<string, { userId: string; nameCode: string }>();
    rows.set("TE_X", { userId: "1", nameCode: "TE_X" });
    const fake: Pick<IdentityRepository, "getUserIdentityByNameCode" | "relinkUserId"> = {
      getUserIdentityByNameCode: (nc) => {
        const r = rows.get(nc.toUpperCase());
        return r ? { userId: r.userId, nameCode: r.nameCode, status: "approved" } : null;
      },
      relinkUserId: (nc, id) => {
        const r = rows.get(nc.toUpperCase());
        if (!r) return false;
        r.userId = id;
        return true;
      },
    };
    const r = relinkIdentity(
      fake as IdentityRepository,
      { nameCode: "te_x", newUserId: "77", approver: "admin1" },
      { isAuthorizedApprover: (a) => a === "admin1" },
    );
    expect(r.success).toBe(true);
    expect(r.identity?.userId).toBe("77");
  });
});

// ── A1: đổi tài khoản Telegram — relink identity + rebind binding theo user id ──
describe("relinkIdentityAndBindings (A1 — nhất quán lưu theo id)", () => {
  const authAll = { isAuthorizedApprover: () => true };

  test("relink OK → binding ticket chuyển sang user id mới, lịch sử giữ theo người", () => {
    // dùng chung một DB cho cả identity + binding (hai bảng)
    intakeApplySchema(db, { wal: false });
    const bindings = new SqliteChannelBindingStore(db);

    // người GV mã TE_usera, tài khoản cũ 111, có 2 ticket
    repo.saveUserIdentity({ userId: "111", nameCode: "TE_usera", status: "approved" });
    bindings.saveBinding({ issueId: 1, chatId: "c", identifier: "OP-1", reporterUserId: "111" });
    bindings.saveBinding({ issueId: 2, chatId: "c", identifier: "OP-2", reporterUserId: "111" });

    // đổi sang tài khoản mới 222
    const r = relinkIdentityAndBindings(
      repo,
      bindings,
      { nameCode: "TE_usera", newUserId: "222", approver: "admin" },
      authAll,
    );

    expect(r.success).toBe(true);
    expect(r.identity?.userId).toBe("222"); // định danh sang id mới
    expect(r.reboundBindings).toBe(2); // 2 ticket theo sang
    // tra ticket theo người (id mới) vẫn ra — lịch sử không mất
    expect(bindings.getLatestBindingByUserId("222")?.identifier).toBe("OP-2");
    expect(bindings.getLatestBindingByUserId("111")).toBeNull();
    // name_code vẫn trỏ đúng người
    expect(repo.getUserIdentityByNameCode("TE_usera")?.userId).toBe("222");
  });

  test("approver không hợp lệ → không relink, không chuyển binding", () => {
    intakeApplySchema(db, { wal: false });
    const bindings = new SqliteChannelBindingStore(db);
    repo.saveUserIdentity({ userId: "111", nameCode: "TE_x", status: "approved" });
    bindings.saveBinding({ issueId: 9, chatId: "c", identifier: "OP-9", reporterUserId: "111" });

    const r = relinkIdentityAndBindings(
      repo,
      bindings,
      { nameCode: "TE_x", newUserId: "222", approver: "ai đó" },
      { isAuthorizedApprover: () => false },
    );
    expect(r.success).toBe(false);
    expect(r.reason).toBe("unauthorized_approver");
    expect(r.reboundBindings).toBe(0);
    expect(bindings.getLatestBindingByUserId("111")?.identifier).toBe("OP-9"); // nguyên vẹn
  });

  test("không truyền bindings → chỉ relink định danh, reboundBindings = 0", () => {
    repo.saveUserIdentity({ userId: "111", nameCode: "TE_y", status: "approved" });
    const r = relinkIdentityAndBindings(
      repo,
      undefined,
      { nameCode: "TE_y", newUserId: "222", approver: "admin" },
      authAll,
    );
    expect(r.success).toBe(true);
    expect(r.reboundBindings).toBe(0);
    expect(repo.getUserIdentityByNameCode("TE_y")?.userId).toBe("222");
  });
});
