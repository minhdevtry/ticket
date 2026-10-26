/**
 * Replay Oracle for IntakeEngine (RFC 0002 §4.3, PR 6).
 *
 * In shadow replay mode (Tier 1), past turns (1..t-1) are replayed through TL2's
 * extractor and merger so TL2 accumulates the fields and rawText, but the control
 * branch is forced to match what TL1 did:
 * - If TL1 asked field A -> lastAskedFields = [A]
 * - If TL1 showed summary -> status = "ready_for_confirmation", summaryShownAt set
 * - If TL1 asked split/merge or new/continue -> pending state set
 * - If TL1 created ticket -> status = "created"
 *
 * The oracle is OPTIONAL and defaults to disabled. When disabled, the engine behaves
 * 100% identically to production. When enabled, it only overrides the draft's control
 * state — the business logic (extraction, merging, gates) is still evaluated by the engine.
 */
import type { IntakeDraft, PendingNewIncident, PendingSplit } from "../draft/types";
import type { StepInput, StepOutput } from "./types";

export type ReplayOracleAction =
  | {
      action: "ask_missing_field";
      field?: string;
      fields?: string[];
    }
  | {
      action: "confirm_summary";
      summaryShownAt?: string;
    }
  | {
      action: "awaiting_user_confirmation";
      summaryShownAt?: string;
    }
  | {
      action: "ticket_created";
      issueIdentifier?: string;
      issueId?: number;
    }
  | {
      action: "canceled";
    }
  | {
      action: "ask_split_or_merge";
      pendingSplit?: PendingSplit;
    }
  | {
      action: "ask_new_or_continue";
      pendingNewIncident?: PendingNewIncident;
    }
  | {
      action: "custom";
      override: Partial<IntakeDraft>;
    };

export interface ReplayOracleContext {
  chatId: string;
  input: StepInput;
  draft: IntakeDraft | null;
  output: StepOutput;
}

export interface ReplayOraclePort {
  getControlAction(
    context: ReplayOracleContext,
  ): Promise<ReplayOracleAction | null | undefined> | ReplayOracleAction | null | undefined;
}

/**
 * Pure function: applies a forced control decision to a draft, updating
 * control fields without discarding extracted user content or identifiers.
 */
export function applyReplayControlOverride(
  draft: IntakeDraft,
  decision: ReplayOracleAction,
  nowIso: string,
): IntakeDraft {
  const updated: IntakeDraft = {
    ...draft,
    updatedAt: nowIso,
  };

  switch (decision.action) {
    case "ask_missing_field": {
      const fieldList = decision.fields ?? (decision.field ? [decision.field] : []);
      updated.status = "collecting";
      if (fieldList.length > 0) {
        updated.lastAskedFields = fieldList;
        if (updated.record) {
          const qc = { ...updated.record.questionCount };
          for (const f of fieldList) {
            qc[f] = (qc[f] ?? 0) + 1;
          }
          updated.record = { ...updated.record, questionCount: qc };
        }
      }
      break;
    }
    case "confirm_summary": {
      updated.status = "ready_for_confirmation";
      updated.summaryShownAt = decision.summaryShownAt ?? nowIso;
      break;
    }
    case "awaiting_user_confirmation": {
      updated.status = "ready_for_confirmation";
      if (!updated.summaryShownAt) {
        updated.summaryShownAt = decision.summaryShownAt ?? nowIso;
      }
      break;
    }
    case "ticket_created": {
      updated.status = "created";
      updated.issueIdentifier = decision.issueIdentifier ?? "TECH-REPLAY";
      updated.issueId = decision.issueId ?? 9999;
      updated.issueCreatedAt = nowIso;
      break;
    }
    case "canceled": {
      updated.status = "canceled";
      break;
    }
    case "ask_split_or_merge": {
      updated.status = "collecting";
      updated.pendingSplit = decision.pendingSplit ?? {
        blocks: [],
        mediaPaths: draft.ticket.mediaPaths ?? [],
        askedAt: nowIso,
      };
      break;
    }
    case "ask_new_or_continue": {
      updated.status = "collecting";
      updated.pendingNewIncident = decision.pendingNewIncident ?? {
        message: "",
        mediaPaths: draft.ticket.mediaPaths ?? [],
        askedAt: nowIso,
      };
      updated.parkedPayload = {
        text: updated.pendingNewIncident.message,
        mediaPaths: updated.pendingNewIncident.mediaPaths,
      };
      break;
    }
    case "custom": {
      Object.assign(updated, decision.override);
      break;
    }
  }

  return updated;
}

/**
 * Scripted oracle helper: yields a sequence of actions across turns.
 */
export class ScriptedReplayOracle implements ReplayOraclePort {
  private index = 0;
  constructor(private readonly sequence: (ReplayOracleAction | null | undefined)[]) {}

  getControlAction(): ReplayOracleAction | null {
    const next = this.sequence[this.index++];
    return next ?? null;
  }
}
