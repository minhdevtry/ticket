/** Config the Onyx services need, passed in rather than read from a global. */
export interface OnyxServiceConfig {
  onyxBaseUrl: string;
  onyxApiKey: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  /** "openai" (mặc định), "anthropic", hay "openclaw" — xem worker/llm.ts#LlmConfig. */
  openaiApi?: "openai" | "anthropic" | "openclaw";
  itsaplanWebUrl: string;
  itsaplanProjectKey: string;
  docIdPrefix?: string;
}
