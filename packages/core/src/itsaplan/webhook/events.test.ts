import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  parseWebhookEnvelope,
  safeEqualToken,
  verifyItsaplanSignature,
  webhookDedupeKey,
  type ItsaplanWebhookEnvelope,
} from "./events";
import {
  MemoryWebhookDedupeStore,
  SqliteWebhookDedupeStore,
  webhookDedupeApplySchema,
} from "./dedupe-store";

function sign(secret: string, ts: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

describe("verifyItsaplanSignature (a6275e7)", () => {
  const body = JSON.stringify({ event: "comment.created", data: { issueId: 1 } });
  const now = 1_700_000_000;

  test("accepts a valid signature within tolerance", () => {
    const header = sign("whsec_abc", now, body);
    expect(verifyItsaplanSignature(header, body, ["whsec_abc"], now)).toBe(true);
  });

  test("rejects a wrong signature", () => {
    const header = sign("whsec_abc", now, body);
    expect(verifyItsaplanSignature(header, body, ["whsec_other"], now)).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifyItsaplanSignature(undefined, body, ["whsec_abc"], now)).toBe(false);
  });

  test("rejects a stale timestamp beyond tolerance", () => {
    const header = sign("whsec_abc", now - 10_000, body);
    expect(verifyItsaplanSignature(header, body, ["whsec_abc"], now)).toBe(false);
  });

  test("accepts when any one of several secrets matches (webhook does not filter project)", () => {
    const header = sign("whsec_second", now, body);
    expect(verifyItsaplanSignature(header, body, ["whsec_first", "whsec_second"], now)).toBe(true);
  });

  test("a tampered body invalidates a signature made for the original body", () => {
    const header = sign("whsec_abc", now, body);
    expect(verifyItsaplanSignature(header, `${body} `, ["whsec_abc"], now)).toBe(false);
  });
});

describe("safeEqualToken (Telegram secret_token)", () => {
  test("equal strings match, unequal do not", () => {
    expect(safeEqualToken("tok", "tok")).toBe(true);
    expect(safeEqualToken("tok", "nope")).toBe(false);
    expect(safeEqualToken("tok", "toklonger")).toBe(false);
  });
});

describe("webhookDedupeKey (event+issue+comment+timestamp)", () => {
  test("comment key uses issueId + comment id", () => {
    const env: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      data: { id: 9, issueId: 5 },
      createdAt: "",
      webhookTimestamp: 111,
    };
    expect(webhookDedupeKey(env)).toBe("comment.created|5|9|111");
  });

  test("two different events at the same timestamp get different keys", () => {
    const base = { action: "update", type: "Issue", createdAt: "", webhookTimestamp: 222 } as const;
    const a = webhookDedupeKey({ ...base, event: "issue.state_changed", data: { id: 5 } });
    const b = webhookDedupeKey({ ...base, event: "issue.updated", data: { id: 5 } });
    expect(a).not.toBe(b);
  });

  test("no webhookTimestamp → null (cannot dedupe)", () => {
    expect(
      webhookDedupeKey({
        action: "create",
        type: "Issue",
        event: "issue.created",
        data: { id: 1 },
        createdAt: "",
      }),
    ).toBeNull();
  });
});

describe("parseWebhookEnvelope", () => {
  test("good JSON → ok", () => {
    const r = parseWebhookEnvelope(JSON.stringify({ event: "issue.created", data: {} }));
    expect(r.ok).toBe(true);
  });
  test("bad JSON → error", () => {
    expect(parseWebhookEnvelope("{not json").ok).toBe(false);
  });
  test("JSON without event → error", () => {
    expect(parseWebhookEnvelope(JSON.stringify({ foo: 1 })).ok).toBe(false);
  });
});

describe("dedupe stores", () => {
  test("MemoryWebhookDedupeStore: first claim true, repeat false", () => {
    const s = new MemoryWebhookDedupeStore();
    expect(s.claim("k1")).toBe(true);
    expect(s.claim("k1")).toBe(false);
    expect(s.claim("k2")).toBe(true);
  });

  test("SqliteWebhookDedupeStore: durable claim, survives a fresh store over the same DB (CM hardening)", () => {
    const db = new Database(":memory:");
    webhookDedupeApplySchema(db, { wal: false });
    const a = new SqliteWebhookDedupeStore(db);
    expect(a.claim("evt|5|_|111")).toBe(true);
    expect(a.claim("evt|5|_|111")).toBe(false);
    // A sibling store over the SAME db (another worker/process) also sees it held.
    const b = new SqliteWebhookDedupeStore(db);
    expect(b.claim("evt|5|_|111")).toBe(false);
    expect(b.claim("evt|6|_|112")).toBe(true);
  });

  test("SqliteWebhookDedupeStore: an expired key may be re-claimed", () => {
    const db = new Database(":memory:");
    webhookDedupeApplySchema(db, { wal: false });
    const s = new SqliteWebhookDedupeStore(db, -1); // already expired on write
    expect(s.claim("k")).toBe(true);
    expect(s.claim("k")).toBe(true); // prior key expired → re-claimable
  });
});
