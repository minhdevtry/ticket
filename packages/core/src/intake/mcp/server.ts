import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createIntakeMcpServer } from "../../core/mcp-server";
import type { AnyMcpTool } from "../../core/mcp-tool";
import type { BotDefinition } from "../../bot/define";
import type { ItsaplanClient } from "../../itsaplan";
import type { IdentityToolsConfig } from "../../identity/tools";
import { itsaplanTrackerPort } from "../adapter";
import { SqliteChannelBindingStore } from "../create/binding-store";
import { SqliteDraftRepository, type DraftRepository } from "../draft/repository";
import { IntakeEngine } from "../engine/engine";
import {
  type ChannelBindingStore,
  type Clock,
  type CopyCatalog,
  type TrackerPort,
  systemClock,
} from "../ports";
import { intakeStepTool } from "./intake-step";
import { inspectTools } from "./inspect-tools";
import { lookupTools } from "./lookup-tools";
import { receptionistIdentityTools } from "./identity-tools";

export interface ReceptionistServerOptions {
  def: BotDefinition;
  engine?: IntakeEngine;
  db?: Database;
  drafts?: DraftRepository;
  bindings?: ChannelBindingStore;
  tracker?: TrackerPort;
  itsaplan?: ItsaplanClient;
  itsaplanBaseUrl?: string;
  copy?: CopyCatalog;
  clock?: Clock;
  identity?: IdentityToolsConfig;
  serverName?: string;
  serverVersion?: string;
  extraTools?: AnyMcpTool[];
}

export function createReceptionistMcpServer(options: ReceptionistServerOptions): McpServer {
  const { def } = options;
  const projectKey = def.tracker.project;

  const clock = options.clock ?? systemClock;
  const copy = options.copy ?? def.persona;

  let drafts = options.drafts;
  if (!drafts && options.db) {
    drafts = new SqliteDraftRepository(options.db);
  }

  let bindings = options.bindings;
  if (!bindings && options.db) {
    bindings = new SqliteChannelBindingStore(options.db);
  }

  let tracker = options.tracker;
  if (!tracker && options.itsaplan) {
    tracker = itsaplanTrackerPort({
      client: options.itsaplan,
      projectKey,
      baseUrl: options.itsaplanBaseUrl ?? "",
    });
  }

  let engine = options.engine;
  if (!engine) {
    const rec = def.receptionist;
    if (!rec?.catalog || !rec.priorityRules || !rec.extractor || !drafts || !tracker || !copy) {
      throw new Error(
        `createReceptionistMcpServer: thiếu thành phần dựng IntakeEngine cho "${def.id}". ` +
          "Cần (drafts, tracker, copy, receptionist.catalog, receptionist.priorityRules, receptionist.extractor)",
      );
    }
    const safeBindings = bindings ?? {
      saveBinding: () => {},
      getLatestBinding: () => null,
      findChatIdByIssueId: () => null,
      listBindingsForChat: () => [],
    };

    engine = new IntakeEngine({
      drafts,
      bindings: safeBindings,
      tracker,
      copy,
      clock,
      catalog: rec.catalog,
      urgencyRules: rec.priorityRules,
      extractor: rec.extractor,
      variant: rec.variant ?? "default",
      techReviewPolicy: rec.techReviewPolicy,
      techReviewer: rec.techReviewer,
      techReviewGuide: rec.techReviewGuide,
      learned: rec.learned,
      draftTtlMs: rec.policy?.draftTtlMs,
      confirm: rec.policy?.minConfirmDelayMs
        ? { minConfirmDelayMs: rec.policy.minConfirmDelayMs }
        : undefined,
      ownership: rec.ownership,
    });
  }

  const tools: AnyMcpTool[] = [intakeStepTool({ engine, drafts })];

  if (drafts) {
    tools.push(...inspectTools({ drafts }));
  }

  if (tracker) {
    tools.push(...lookupTools({ tracker, bindings, copy, projectKey }));
  }

  if (options.identity) {
    tools.push(...receptionistIdentityTools({ config: options.identity, drafts }));
  }

  if (options.extraTools && options.extraTools.length > 0) {
    tools.push(...options.extraTools);
  }

  const serverName = options.serverName ?? `intake-${def.id}`;
  const serverVersion = options.serverVersion ?? "0.1.0";

  return createIntakeMcpServer({
    name: serverName,
    version: serverVersion,
    tools,
  });
}
