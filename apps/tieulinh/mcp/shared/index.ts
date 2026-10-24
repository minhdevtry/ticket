// Nối hook báo admin của Tiểu Linh vào describeToolFailure của thư viện (side-effect).
import "../../lib/tool-error";
export { defineTool, type McpTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
export {
  createIntakeMcpServer,
  runOnStdio,
  runOnHttp,
  type IntakeMcpOptions,
  type HttpMcpOptions,
} from "@vuihoc/bot-core/core";
export { redactPii } from "./tools/redact-pii";
export { checkRequiredFields } from "./tools/check-required-fields";
export {
  getIssue,
  updateIssue,
  DEFAULT_ISSUE_VOCABULARY,
  type TrackerConfig,
  type IssueVocabulary,
} from "./tools/issues";
export {
  createIssue,
  reporterShape,
  type IssueDomain,
  type BuiltIssue,
  type Priority,
} from "./tools/create-issue";
export {
  checkIdentity,
  registerIdentity,
  approveUser,
  rejectUser,
  type IdentityConfig,
} from "./tools/identity";
export { assessPriority, type UrgencyRules } from "./tools/assess-priority";
export { searchKnowledge, type KnowledgeConfig } from "./tools/search-knowledge";
export {
  validateFields,
  validateOne,
  type ValidateFieldsResult,
  type ValidationRules,
  type FieldVerdict,
  type FieldRequirementsTable,
  type ProductMappingConfig,
} from "./tools/validate-fields";
export { escalateIssue, type EscalateVocabulary } from "./tools/escalate-issue";
export { queryKnowledgeGraph } from "./tools/query-knowledge-graph";
