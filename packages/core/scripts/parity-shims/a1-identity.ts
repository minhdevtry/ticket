/**
 * Parity shims for ticket A1 (identity) — contributed to
 * scripts/shadow-parity.ts via the `shims: Shim[]` export convention.
 *
 * The library identity layer (`@vuihoc/bot-core/identity`) differs from intake
 * in two deliberate ways: the per-user key is `userId` (not `telegramUserId`),
 * and the service is COPY-FREE (returns reason codes, not Vietnamese `message`
 * strings — the bot renders copy). Intake's code and tests assert the OLD field
 * name, so the one shim here is an ADAPTER that restores intake's exact surface
 * on top of the library — never a behaviour change, nothing weakened.
 *
 * SHIMMED
 * -------
 *   lib/storage/identity-repository.ts  →  ADAPTER
 *     The library `SqliteIdentityRepository` is keyed on `userId`. This shim's
 *     `IdentityRepository` wraps it and translates `telegramUserId` ⇄ `userId`
 *     on every method (in and out), re-exports `UserIdentity`/`IdentityStatus`
 *     with the `telegramUserId` field restored, and keeps the schema (the
 *     library's `IDENTITY_SCHEMA` is intake's `user_identities` /
 *     `approved_prefixes` columns verbatim). Drop-in for `new
 *     IdentityRepository(db)` + `saveUserIdentity({ telegramUserId })`.
 *     This is the load-bearing one: it is reached by the intake suite through
 *     `validate-fields.ts`, `check-required-fields.ts` and the
 *     `confirmation-and-binding` / `validate-fields.parity` tests.
 *
 * NOT SHIMMED — and WHY (documented, never faked)
 * -----------------------------------------------
 *   lib/storage/identity.service.ts
 *     In intake this service is imported ONLY by the (unshimmable) MCP tool
 *     below — no test reaches it directly. The library split it in two: logic
 *     moved to a copy-FREE `IdentityService` (reason codes), and the Vietnamese
 *     strings moved to a bot renderer (`examples/tieulinh/identity-copy.ts`).
 *     A shim restoring intake's baked `message` strings would be new glue
 *     (reason-code → string, async signature, cross-package copy import), not a
 *     re-export — and since no asserted test exercises it, swapping it buys no
 *     parity coverage while adding risk. The LOGIC it would delegate to is
 *     already proven by the repository shim's data paths. Left unchanged.
 *
 *   mcp/shared/tools/identity.ts
 *     intake's `checkIdentity` MCP tool is a FUSION the library deliberately
 *     does not reproduce: it binds its own `openLazyDb`, then returns
 *     `latestTicket` (intake TicketBindingRepository) and `pendingDraft`
 *     (intake draft-session repository) ALONGSIDE the approval result, and
 *     takes a `telegramUserId` input field. The library `check_identity` tool
 *     is channel-neutral, copy-injected, keyed on `userId`, and does NO
 *     binding/draft lookup — those belong to the write engine (tickets 08/09)
 *     behind separate ports. A shim would have to re-implement the binding +
 *     draft fusion and rename the input field: that is a behaviour change, not
 *     a parity swap. Left unchanged; its underlying register/approve/reject
 *     logic is covered by shim coverage of the repository data paths.
 */
import type { Shim } from "./types";
import { LIB_PKG } from "./types";

const IDENTITY = `${LIB_PKG}/identity`;

export const shims: Shim[] = [
  {
    file: "lib/storage/identity-repository.ts",
    from: IDENTITY,
    note: "ADAPTER: wraps library SqliteIdentityRepository (keyed on userId) and translates telegramUserId⇄userId on every method; schema is the library's IDENTITY_SCHEMA (== intake user_identities/approved_prefixes columns verbatim)",
    body: (imp) =>
      `// SHIM → ${imp} (field-name adapter: telegramUserId ⇄ userId). Logic unchanged.\n` +
      `import {\n` +
      `  SqliteIdentityRepository as LibRepo,\n` +
      `  type UserIdentity as LibUserIdentity,\n` +
      `  type IdentityStatus as LibStatus,\n` +
      `} from "${imp}";\n` +
      `import type { Database } from "bun:sqlite";\n\n` +
      `export type IdentityStatus = LibStatus;\n\n` +
      `export interface UserIdentity {\n` +
      `  telegramUserId: string;\n` +
      `  nameCode: string;\n` +
      `  fullName?: string;\n` +
      `  username?: string;\n` +
      `  status: IdentityStatus;\n` +
      `  approvedBy?: string;\n` +
      `  pendingReport?: string;\n` +
      `  department?: string;\n` +
      `  createdAt?: string;\n` +
      `  updatedAt?: string;\n` +
      `}\n\n` +
      `function toLegacy(u: LibUserIdentity | null): UserIdentity | null {\n` +
      `  if (!u) return null;\n` +
      `  const { userId, ...rest } = u;\n` +
      `  return { telegramUserId: userId, ...rest };\n` +
      `}\n\n` +
      `export class IdentityRepository {\n` +
      `  private readonly inner: LibRepo;\n` +
      `  constructor(db: Database) { this.inner = new LibRepo(db); }\n` +
      `  getUserIdentity(telegramUserId: string) { return toLegacy(this.inner.getUserIdentity(telegramUserId)); }\n` +
      `  getUserIdentityByNameCode(nameCode: string) { return toLegacy(this.inner.getUserIdentityByNameCode(nameCode)); }\n` +
      `  saveUserIdentity(i: { telegramUserId: string; nameCode: string; fullName?: string; username?: string; status?: IdentityStatus; approvedBy?: string; pendingReport?: string; department?: string }) {\n` +
      `    const { telegramUserId, ...rest } = i;\n` +
      `    this.inner.saveUserIdentity({ userId: telegramUserId, ...rest });\n` +
      `  }\n` +
      `  updateDepartment(telegramUserId: string, department: string) { this.inner.updateDepartment(telegramUserId, department); }\n` +
      `  approveUserIdentity(telegramUserId: string, approvedBy: string) { this.inner.approveUserIdentity(telegramUserId, approvedBy); }\n` +
      `  rejectUserIdentity(telegramUserId: string) { this.inner.rejectUserIdentity(telegramUserId); }\n` +
      `  savePendingReport(telegramUserId: string, reportJson: string) { this.inner.savePendingReport(telegramUserId, reportJson); }\n` +
      `  getPendingReport(telegramUserId: string) { return this.inner.getPendingReport(telegramUserId); }\n` +
      `  clearPendingReport(telegramUserId: string) { this.inner.clearPendingReport(telegramUserId); }\n` +
      `  isPrefixApproved(prefix: string) { return this.inner.isPrefixApproved(prefix); }\n` +
      `  approvePrefix(prefix: string, approvedBy: string) { this.inner.approvePrefix(prefix, approvedBy); }\n` +
      `  listPendingIdentities() { return this.inner.listPendingIdentities().map((u) => toLegacy(u)!); }\n` +
      `}\n`,
  },
];
