import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { fixtureCatalog } from "./catalog.fixture";
import { buildFieldSchema, buildWorkingMemorySchema, collectFillableFields, readRecordFromInput } from "./schema";

describe("collectFillableFields", () => {
  test("gathers fields from every variant, not just the first", () => {
    const fields = collectFillableFields(fixtureCatalog);
    expect(Object.keys(fields).sort()).toEqual([
      "he_thong",
      "phong_ban",
      "quy_mo",
      "tan_suat",
      "van_de",
    ]);
  });

  test("leaves out fields the system fills in", () => {
    // Offering `tieu_de` to the model invites it to invent one.
    expect(collectFillableFields(fixtureCatalog)).not.toHaveProperty("tieu_de");
    expect(collectFillableFields(fixtureCatalog)).not.toHaveProperty("ghi_chu_noi_bo");
  });

  test("prefers the definition that carries a label", () => {
    // `van_de` is "Vấn đề" in variant 1 and "Sự cố" in variant 2; either label
    // beats none, and the schema must not end up describing a field as itself.
    expect(collectFillableFields(fixtureCatalog).van_de.label).toBeTruthy();
  });
});

describe("buildFieldSchema", () => {
  const shape = buildFieldSchema(fixtureCatalog);
  const schema = z.object(shape);

  test("offers the variants as a closed choice, defaulting to the first", () => {
    expect(schema.parse({}).variant).toBe("1");
    expect(schema.safeParse({ variant: "9" }).success).toBe(false);
  });

  test("spells out the vocabulary so the model does not invent a value", () => {
    const description = shape.phong_ban.description ?? "";
    expect(description).toContain("chọn một: CS, Vận hành, Marketing");
  });

  test("tells the model when a field accepts several values", () => {
    expect(shape.he_thong.description).toContain("chọn một hoặc nhiều");
  });

  test("accepts a turn where the user answered nothing", () => {
    // Every captured field is optional: the gate decides what is missing, not
    // the schema, so a turn of pure conversation must still validate.
    expect(schema.safeParse({ variant: "1" }).success).toBe(true);
  });

  test("no longer asks the model to carry the bookkeeping", () => {
    // `questionCount` and `explicitlyMissing` used to be tool inputs. The model
    // dropping `questionCount` reset the retry budget and the bot asked the
    // same question forever.
    expect(shape).not.toHaveProperty("questionCount");
    expect(shape).not.toHaveProperty("explicitlyMissing");
    expect(shape).toHaveProperty("cannotAnswer");
  });
});

describe("readRecordFromInput", () => {
  test("keeps only what belongs to the catalog", () => {
    const read = readRecordFromInput(fixtureCatalog, {
      variant: "1",
      phong_ban: "CS",
      chatId: "-100123",
      questionCount: { phong_ban: 5 },
    });

    expect(read.rawValues).toEqual({ phong_ban: "CS" });
  });

  test("falls back to the first variant when the model names an unknown one", () => {
    expect(readRecordFromInput(fixtureCatalog, { variant: "khac" }).variant).toBe("1");
    expect(readRecordFromInput(fixtureCatalog, {}).variant).toBe("1");
  });

  test("distinguishes an unanswered field from one the user cannot answer", () => {
    const read = readRecordFromInput(fixtureCatalog, { cannotAnswer: ["he_thong"] });
    expect(read.rawValues).toEqual({});
    expect(read.cannotAnswer).toEqual(["he_thong"]);
  });
});

describe("buildWorkingMemorySchema", () => {
  test("accepts state that has not started yet", () => {
    expect(buildWorkingMemorySchema(fixtureCatalog).safeParse({}).success).toBe(true);
  });

  test("round-trips the state a conversation accumulates", () => {
    const parsed = buildWorkingMemorySchema(fixtureCatalog).parse({
      variant: "1",
      captured: { phong_ban: "CS" },
      askedCount: { he_thong: 2 },
      cannotAnswer: ["he_thong"],
    });

    expect(parsed.captured).toEqual({ phong_ban: "CS" });
    expect(parsed.askedCount).toEqual({ he_thong: 2 });
  });
});
