/**
 * `@vuihoc/bot-core/bot` — bot kit: `defineBot` (khai báo), `createBot` (runtime),
 * `runBot` (chạy tới khi có tín hiệu). Thiết kế: `docs/rfc/0001-bot-kit.md`.
 */
export * from "./define";
export * from "./create";
export * from "./run";
export * from "./health-server";
export * from "./logging";
export {
  createReceptionistMcpServer,
  exportSkillPack,
  intakeStepTool,
  inspectTools,
  lookupTools,
  receptionistIdentityTools,
  type ReceptionistServerOptions,
  type SkillPack,
  type SkillPackFile,
  type SkillPackOptions,
} from "../intake/mcp";
