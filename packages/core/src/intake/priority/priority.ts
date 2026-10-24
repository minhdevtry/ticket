/**
 * Priority floor/ceiling engine — the pure core of Tiểu Linh's `assess_priority`.
 *
 * Ported from intake-agents `mcp/shared/tools/assess-priority.ts`, with the MCP
 * tool wrapper (`defineTool`/`assessPriority`) and its zod `evidenceShape` left
 * behind in the bot: those bind the engine to a concrete evidence schema and to
 * the MCP SDK. The engine here takes the rule table as INJECTED DATA and the
 * evidence as a plain bag, so it is pure — no I/O, no clock, no SDK.
 *
 * The rule table (`levels`, `floors`, `ceilings`) is data the consumer supplies
 * (e.g. Tiểu Linh's `urgency-rules.json`); it is never baked in here.
 */

export interface UrgencyRuleFloor {
  when: Record<string, unknown>;
  minLevel: string;
  reason: string;
}

export interface UrgencyRuleCeiling {
  when: Record<string, unknown>;
  maxLevel: string;
  reason: string;
}

export interface UrgencyRules {
  levels: string[];
  floors: UrgencyRuleFloor[];
  ceilings: UrgencyRuleCeiling[];
  evidence?: Record<string, unknown>;
}

export interface PriorityVerdict {
  proposedLevel: string;
  allowedLevel: string;
  direction: "raised" | "lowered" | "kept";
  differsFromProposed: boolean;
  reasons: string[];
  floor: string;
  ceiling: string;
  floorOverrodeCeiling: boolean;
}

const matches = (when: Record<string, unknown>, evidence: Record<string, unknown>) =>
  Object.entries(when).every(([k, v]) => evidence[k] === v);

/**
 * Reconcile a proposed priority against the evidence floors and ceilings.
 *
 * Floors raise, ceilings cap, and a floor wins a tie (if a ceiling would pull
 * the level below a floor, the floor overrides — e.g. a payment-blocking bug
 * stays Urgent even with a workaround).
 */
export function evaluatePriorityRules(
  rules: UrgencyRules,
  proposedLevel: string,
  evidence: Record<string, unknown>,
): PriorityVerdict {
  const levels = rules.levels;
  const indexOf = (level: string) => levels.indexOf(level);

  let floor = 0;
  const floorReasons: string[] = [];
  for (const rule of rules.floors) {
    if (!matches(rule.when, evidence)) continue;
    floor = Math.max(floor, indexOf(rule.minLevel));
    floorReasons.push(rule.reason);
  }

  let ceiling = levels.length - 1;
  const ceilingReasons: string[] = [];
  for (const rule of rules.ceilings) {
    if (!matches(rule.when, evidence)) continue;
    ceiling = Math.min(ceiling, indexOf(rule.maxLevel));
    ceilingReasons.push(rule.reason);
  }

  const floorWins = ceiling < floor;
  if (floorWins) ceiling = floor;

  const proposed = indexOf(proposedLevel);
  const allowed = Math.min(Math.max(proposed, floor), ceiling);
  const direction = allowed > proposed ? "raised" : allowed < proposed ? "lowered" : "kept";

  return {
    proposedLevel,
    allowedLevel: levels[allowed],
    direction,
    differsFromProposed: direction !== "kept",
    reasons: direction === "raised" ? floorReasons : direction === "lowered" ? ceilingReasons : [],
    floor: levels[floor],
    ceiling: levels[ceiling],
    floorOverrodeCeiling: floorWins,
  };
}

export interface RequestedPriority {
  /** The level the reporter asked for. */
  level: string;
  /** Why they asked — required for the request to be honoured. */
  reason?: string;
}

/**
 * Fold a reporter-requested priority into the evidence-derived level.
 *
 * Rule (user decision 29/09, recorded in `urgency-rules.json._nguoi_bao_xin_gap`):
 * a reporter asking for a higher priority is honoured ONLY when they give a
 * reason, and ONLY when the requested level is strictly higher than the level
 * the evidence already supports. It never LOWERS an evidence-high level, and a
 * request with no reason is ignored here (the conversation layer may ask once
 * for a reason before calling again).
 *
 * Pure: ordering comes from the injected `levels`, not a hardcoded table. An
 * unknown level (not in `levels`) ranks below everything, so a bogus request
 * can never raise the level.
 *
 * Returns the level to stamp plus whether the request was the deciding factor.
 */
export function resolveRequestedPriority(
  levels: string[],
  evidenceLevel: string,
  requested?: RequestedPriority,
): { level: string; grantedByRequest: boolean } {
  const rank = (level: string) => levels.indexOf(level);
  const granted = requested?.reason ? requested.level : undefined;
  if (granted !== undefined && rank(granted) > rank(evidenceLevel)) {
    return { level: granted, grantedByRequest: true };
  }
  return { level: evidenceLevel, grantedByRequest: false };
}
