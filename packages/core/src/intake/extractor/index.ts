/**
 * `@vuihoc/bot-core/intake` — extractor module.
 *
 * Implements field extraction from free-form reporter messages, Vietnamese heuristics,
 * post-LLM normalization, and fallback mechanisms (RFC 0002 §1.5 E1-E5, A14).
 */

export * from "./taxonomy";
export * from "./heuristics";
export * from "./schema";
export * from "./merger";
export * from "./llm-extractor";
