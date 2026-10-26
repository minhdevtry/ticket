/**
 * Tiểu Linh engine wiring — an EXAMPLE, not library source.
 *
 * Shows how a bot assembles the ticket-09 `IntakeEngine`: it supplies the
 * Vietnamese copy (`tieuLinhCopy`), its own field catalog + urgency rules
 * (DATA, imported, never read from disk — survives `bun build --compile`), and
 * concrete port implementations (an LLM extractor, the Itsaplan tracker port
 * from ticket 08's adapter, SQLite draft/binding stores, an ownership predicate
 * backed by the binding store). The library engine carries none of this.
 *
 * This file imports from `../../src/intake` the same way a published consumer
 * imports from `@vuihoc/bot-core/intake`.
 */
import type { Database } from "bun:sqlite";
import { makeOpenLazyDb } from "../../src/core/lazy-db";
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
} from "../../src/intake";
import { createCatalog, type FieldCatalog } from "../../src/intake/gate";
import type { UrgencyRules } from "../../src/intake/priority";
import type { ItsaplanClient } from "../../src/itsaplan";
import { tieuLinhCopy } from "./copy";

/**
 * Tiểu Linh's incident catalog (shape only — a real bot imports its full
 * `required-fields.json` or builds it from legacy validation rules). One
 * variant: a required problem description plus an optional department.
 */
export const tieuLinhCatalog: FieldCatalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Sự cố kỹ thuật",
        truong_mo_dau: "van_de",
        recap: ["van_de", "bo_phan"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Vấn đề",
            hoi: "Anh/chị mô tả giúp em sự cố đang gặp với ạ.",
          },
          bo_phan: {
            bat_buoc: false,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Bộ phận",
            hoi: "Anh/chị thuộc bộ phận nào ạ?",
          },
        },
      },
    },
  },
});

/** Tiểu Linh's urgency floors/ceilings (DATA). A real bot imports urgency-rules.json. */
export const tieuLinhUrgency: UrgencyRules = {
  levels: ["Low", "Medium", "High", "Urgent"],
  floors: [
    { when: { blocksPayment: true }, minLevel: "Urgent", reason: "Dòng tiền đang bị chặn." },
    { when: { scope: "entire_system" }, minLevel: "Urgent", reason: "Cả hệ thống." },
  ],
  ceilings: [
    {
      when: { singleDeviceOnly: true, hasWorkaround: true },
      maxLevel: "Low",
      reason: "Một thiết bị, có cách đi vòng.",
    },
  ],
};
/** Actors ignored by Tiểu Linh when searching for technical commenters to mention. */
export const DEFAULT_TIEULINH_IGNORED_ACTORS: string[] = [
  "tiểu linh",
  "tieulinh",
  "iris",
  "onyx",
  "bot-ticket-intake",
  "bot-iris-intake",
];

export interface TieuLinhWiring {
  client: ItsaplanClient;
  dbPath: string;
  projectKey: string; // "TECH"
  baseUrl: string;
  webUrl?: string;
  extractor: FieldExtractorPort;
  techReviewer?: TechReviewerPort;
  /**
   * Công tắc soát (F4). Mặc định của app Tiểu Linh: soát bằng **danh sách cố định**
   * (F2) — không tốn LLM. Muốn soát bằng LLM thì app tự nối `techReviewer` và đổi
   * thành "llm".
   */
  techReviewPolicy?: TechReviewPolicy;
  commands?: TicketCommandInterpreterPort;
  actions?: TicketActionExecutorPort;
  postCreate?: PostCreateHookPort;
}

/** Assemble the engine the way the Tiểu Linh bot does at startup. */
export function makeTieuLinhEngine(w: TieuLinhWiring): IntakeEngine {
  const openDb = makeOpenLazyDb({ applySchema: intakeApplySchema });
  const db: Database = openDb(w.dbPath);
  const drafts = new SqliteDraftRepository(db);
  const bindings = new SqliteChannelBindingStore(db);

  const deps: IntakeEngineDeps = {
    tracker: itsaplanTrackerPort({
      client: w.client,
      projectKey: w.projectKey,
      baseUrl: w.baseUrl,
      webUrl: w.webUrl,
    }),
    drafts,
    bindings,
    copy: makeCopyCatalog(tieuLinhCopy),
    clock: systemClock,
    media: passthroughMediaResolver,
    identifierPrefix: w.projectKey,
    extractor: w.extractor,
    catalog: tieuLinhCatalog,
    variant: "tech",
    urgencyRules: tieuLinhUrgency,
    techReviewer: w.techReviewer,
    techReviewPolicy: w.techReviewPolicy ?? "checklist",
    ownership: bindingOwnershipPort(bindings),
    commands: w.commands,
    actions: w.actions,
    postCreate: w.postCreate, // KG/Onyx/similar — supplied by the bot, never the library
    botName: "Tiểu Linh",
    ignoredActors: DEFAULT_TIEULINH_IGNORED_ACTORS,
  };
  return new IntakeEngine(deps);
}
