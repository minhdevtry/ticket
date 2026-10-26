/**
 * Lắp ráp IntakeEngine cho Tiểu Linh sử dụng dữ liệu domain và copy của app.
 */
import type { Database } from "bun:sqlite";
import { makeOpenLazyDb } from "@vuihoc/bot-core/core";
import {
  IntakeEngine,
  type IntakeEngineDeps,
  makeCopyCatalog,
  systemClock,
  bindingOwnershipPort,
  SqliteDraftRepository,
  SqliteChannelBindingStore,
  intakeApplySchema,
  itsaplanTrackerPort,
  passthroughMediaResolver,
  type FieldExtractorPort,
  type TechReviewerPort,
  type TechReviewPolicy,
  type TicketCommandInterpreterPort,
  type TicketActionExecutorPort,
  type PostCreateHookPort,
  type LearnedItemsPort,
  type UrgencyRules,
  type ValidationRules,
  type FieldRequirementsTable,
} from "@vuihoc/bot-core/intake";
import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import { createAskLearnedLookup } from "./ask-learning/lookup";
import { tieulinhReceptionistCopy } from "./copy";
import { buildTieulinhCatalog } from "./domain/validate";
import fieldRequirements from "./domain/required_fields.json";
import urgencyRules from "./domain/urgency-rules.json";
import validationRules from "./domain/validation-rules.json";

export const tieulinhCatalog = buildTieulinhCatalog(
  validationRules as unknown as ValidationRules,
  fieldRequirements as unknown as FieldRequirementsTable,
);
export const tieulinhUrgency = urgencyRules as unknown as UrgencyRules;

export const DEFAULT_TIEULINH_IGNORED_ACTORS: string[] = [
  "tiểu linh",
  "tieulinh",
  "iris",
  "onyx",
  "bot-ticket-intake",
  "bot-iris-intake",
];

export interface TieulinhWiring {
  client: ItsaplanClient;
  dbPath: string;
  projectKey: string;
  baseUrl: string;
  webUrl?: string;
  extractor: FieldExtractorPort;
  techReviewer?: TechReviewerPort;
  techReviewPolicy?: TechReviewPolicy;
  askLearnDbPath?: string;
  learned?: LearnedItemsPort;
  commands?: TicketCommandInterpreterPort;
  actions?: TicketActionExecutorPort;
  postCreate?: PostCreateHookPort;
  copy?: Record<string, string>;
}

export function makeTieulinhEngine(w: TieulinhWiring): IntakeEngine {
  const openDb = makeOpenLazyDb({ applySchema: intakeApplySchema });
  const db: Database = openDb(w.dbPath);
  const drafts = new SqliteDraftRepository(db);
  const bindings = new SqliteChannelBindingStore(db);

  const copyDict = w.copy ?? tieulinhReceptionistCopy;
  const learnedPort =
    w.learned ?? (w.askLearnDbPath ? createAskLearnedLookup(w.askLearnDbPath) : undefined);

  const deps: IntakeEngineDeps = {
    tracker: itsaplanTrackerPort({
      client: w.client,
      projectKey: w.projectKey,
      baseUrl: w.baseUrl,
      webUrl: w.webUrl,
    }),
    drafts,
    bindings,
    copy: makeCopyCatalog(copyDict),
    clock: systemClock,
    media: passthroughMediaResolver,
    identifierPrefix: w.projectKey,
    extractor: w.extractor,
    catalog: tieulinhCatalog,
    variant: "tech",
    urgencyRules: tieulinhUrgency,
    techReviewer: w.techReviewer,
    techReviewPolicy: w.techReviewPolicy ?? "checklist",
    learned: learnedPort,
    ownership: bindingOwnershipPort(bindings),
    commands: w.commands,
    actions: w.actions,
    postCreate: w.postCreate,
    botName: "Tiểu Linh",
    ignoredActors: DEFAULT_TIEULINH_IGNORED_ACTORS,
  };

  return new IntakeEngine(deps);
}
