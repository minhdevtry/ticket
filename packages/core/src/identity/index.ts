/**
 * `@vuihoc/bot-core/identity` — the user-identity lifecycle (ticket A1):
 * register / approve / reject / relink, with a library-owned SQLite schema, a
 * copy-free service, the anti-takeover relink guard, and an optional MCP tool
 * factory. All user-facing copy is injected by the bot (see
 * examples/tieulinh/identity-copy.ts); the library ships none.
 */
export {
  type IdentityStatus,
  type UserIdentity,
  type IdentityRepository,
  IDENTITY_SCHEMA,
  identityApplySchema,
  SqliteIdentityRepository,
} from "./repository";

export {
  type RegistrationReason,
  type IdentityCheckResult,
  type RegistrationResult,
  type ApprovalMutationResult,
  type IdentityServiceOptions,
  NAME_CODE_REGEX,
  IdentityService,
} from "./service";

export {
  type RelinkReason,
  type RelinkResult,
  type RelinkInput,
  type RelinkOptions,
  type RelinkWithBindingsResult,
  relinkIdentity,
  relinkIdentityAndBindings,
} from "./relink";

export {
  type IdentityCopyRenderer,
  type IdentityToolsConfig,
  checkIdentityTool,
  registerIdentityTool,
  approveUserTool,
  rejectUserTool,
  relinkIdentityTool,
  identityTools,
} from "./tools";
