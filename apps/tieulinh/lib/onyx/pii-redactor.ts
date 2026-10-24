/**
 * Enhanced PII Redactor for Technical Incidents and Runbook Knowledge Ingestion.
 * Strips phone numbers, Telegram user IDs, national IDs (CCCD), passwords,
 * UltraViewer credentials, and sensitive API tokens while preserving
 * legitimate technical keywords, ticket IDs, room IDs, and IP addresses.
 */

export function redactIncidentPII(text: string): string {
  if (!text) return "";

  let cleaned = text;

  // 1. API Keys & Auth Tokens (sk-, itp_, on_, ghp_, gho_, Bearer)
  cleaned = cleaned.replace(
    /\b(?:Bearer\s+[a-zA-Z0-9_.-]{16,}|(?:itp|on|ghp|gho)_[a-zA-Z0-9_-]{16,}|sk-[a-zA-Z0-9_-]{16,})\b/gi,
    "[REDACTED_TOKEN]",
  );

  // 2. Passwords / Account credentials
  cleaned = cleaned.replace(
    /((?:pass|mật\s*khẩu|password)(?:\s*(?:là|is|:|=)\s*|\s+))([^\s,;]+)/gi,
    "$1[REDACTED_PASSWORD]",
  );

  // 3. Email addresses
  cleaned = cleaned.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]",
  );

  // 4. National ID / CCCD (12 continuous digits)
  cleaned = cleaned.replace(/\b\d{12}\b/g, "[REDACTED_CCCD]");

  // 5. Vietnamese phone numbers (mobile, 10 số) — BẮT ĐẦU BẰNG 0 HOẶC +84
  cleaned = cleaned.replace(
    /(?<!\d)(?:\+?84[.\s-]?|0)(?:3|5|7|8|9)(?:[.\s-]?\d){8}\b/g,
    "[REDACTED_PHONE]",
  );

  // 6. Telegram user IDs (10 số, không bắt đầu bằng 0 — không khớp pattern SĐT)
  cleaned = cleaned.replace(
    /(?<!\d)(?:776\d{7}|8\d{9}|9\d{9})\b/g,
    "[REDACTED_TELEGRAM]",
  );

  // 7. UltraViewer credentials (ultra: xxx xxx xxx - xxxxx hoặc "UltraViewer: ...")
  cleaned = cleaned.replace(
    /\b(?:ultra(?:\s*viewer)?\s*(?:id)?\s*[:\-]?\s*[\d\s.\-]{6,})/gi,
    "[REDACTED_ULTRAVIEWER]",
  );

  return cleaned;
}
