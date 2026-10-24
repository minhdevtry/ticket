import { decodeHtmlEntities } from "../formatting";

/**
 * Tín hiệu của NGƯỜI trên một ticket — nguồn chuẩn duy nhất cho ticket tương tự
 * (ADR-0007). Gợi ý do bot ghi (link, trường Related Tickets) không bao giờ là
 * tri thức: 1.382/1.621 link hiện có trên TECH là bot gắn, học lại chúng là tự
 * củng cố chính cái sai (TECH-920, 26/09).
 *
 * Module thuần: chỉ đọc timeline Itsaplan (`/issues/:id/timeline/items`).
 */

import { stripCommentHtml } from "../formatting";
/** Tiểu Linh, VUIHOC Tiểu Linh, `admin` (worker + script), Onyx, mọi tên có chữ bot. */
const SYSTEM_ACTOR = /ti[eể]u\s*linh|tieulinh|onyx|bot|^admin$/i;

export function isSystemActor(actorName: unknown): boolean {
  const name = String(actorName ?? "").trim();
  return !name || SYSTEM_ACTOR.test(name);
}

export interface PinnedKnowledge {
  /** Câu "Nguyên nhân" người viết, đã bỏ markdown. */
  cause?: string;
  /** Câu "Cách khắc phục" người viết. */
  fix?: string;
  /** Mã ticket khác được nhắc trong comment ghim — người coi là cùng nguyên nhân. */
  mentionedIds: string[];
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

const decodeEntities = decodeHtmlEntities;

const SECTION_LABELS = ["nguyen nhan", "cach khac phuc", "ticket tuong tu"] as const;
type SectionLabel = (typeof SECTION_LABELS)[number];

const stripMarkdown = (s: string) => stripCommentHtml(s).replace(/[*_`\\]/g, "");

/** Nội dung một mục `- **Nhãn:** …` (kể cả các dòng con) tới mục kế tiếp. */
function section(body: string, label: SectionLabel): string | undefined {
  let inside = false;
  const parts: string[] = [];
  for (const line of body.split("\n")) {
    const head = fold(stripMarkdown(line).replace(/>/g, "")).replace(/^[\s\-•]+/, "");
    const hit = SECTION_LABELS.find((l) => head.startsWith(l));
    if (hit) {
      if (inside) break;
      if (hit === label) {
        inside = true;
        const rest = stripMarkdown(line)
          .replace(/^[^:]*:/, "")
          .trim();
        if (rest) parts.push(rest);
      }
      continue;
    }
    if (inside) parts.push(line);
  }
  if (!inside) return undefined;
  const text = parts
    .map((p) =>
      stripMarkdown(decodeEntities(p))
        .trim()
        .replace(/^[-•]+\s*/, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" - ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

export function parsePinnedKnowledge(body: string, selfIdentifier?: string): PinnedKnowledge {
  const text = stripCommentHtml(decodeEntities(String(body ?? "")));
  const self = selfIdentifier?.toUpperCase();
  const mentioned = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]*-\d+)\b/g)) {
    if (m[1] !== self) mentioned.add(m[1]);
  }
  return {
    cause: section(text, "nguyen nhan"),
    fix: section(text, "cach khac phuc"),
    mentionedIds: [...mentioned].sort(),
  };
}

/** Comment ghim mới nhất của người trên ticket; null khi không có. */
export function pinnedKnowledgeOf(
  timeline: any[],
  selfIdentifier?: string,
): PinnedKnowledge | null {
  const pins = (timeline ?? [])
    .filter(
      (c) =>
        c?.kind === "comment" &&
        c.pinned &&
        !isSystemActor(c.actorName) &&
        typeof c.body === "string",
    )
    .sort((a, b) =>
      String(a.pinnedAt ?? a.createdAt ?? "").localeCompare(
        String(b.pinnedAt ?? b.createdAt ?? ""),
      ),
    );
  const pin = pins.at(-1);
  return pin ? parsePinnedKnowledge(pin.body, selfIdentifier) : null;
}

export interface HumanLinkSignals {
  /** Người coi là cùng nguyên nhân (link người gắn, mã người thêm vào Related Tickets). */
  positives: string[];
  /** Người đã gỡ (link_remove, mã người xoá khỏi Related Tickets) — cấm chung cụm. */
  negatives: string[];
}

const TICKET_KEY = /\b([A-Z][A-Z0-9_]*-[A-Z0-9-]*\d)\b/g;
const keysOf = (value: unknown) =>
  new Set(
    [
      ...String(value ?? "")
        .toUpperCase()
        .matchAll(TICKET_KEY),
    ].map((m) => m[1]),
  );

/**
 * Với mỗi mã, hành động cuối cùng của NGƯỜI quyết định dương hay âm. Hành động
 * của bot bị bỏ qua hoàn toàn — bot gắn lại cái người đã gỡ vẫn là âm.
 *
 * Trường Related Tickets tính theo chênh lệch: lần sửa của người chỉ nói về
 * những mã người thêm hoặc xoá so với giá trị ngay trước đó. Tech lead lưu lại
 * danh sách bot ghi (chỉ bỏ mã test) không có nghĩa là chị duyệt cả danh sách.
 */
export function humanLinkSignals(timeline: any[], selfIdentifier: string): HumanLinkSignals {
  const self = selfIdentifier.toUpperCase();
  const events = (timeline ?? [])
    .filter((e) => e?.kind === "activity" || e?.action)
    .slice()
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));

  const last = new Map<string, "add" | "remove">();
  const mark = (key: string, what: "add" | "remove") => {
    if (key && key !== self) last.set(key, what);
  };

  let fieldBefore = new Set<string>();
  for (const e of events) {
    const human = !isSystemActor(e.actorName);
    if (e.action === "link_add" || e.action === "link_remove") {
      const key = String(e.payload?.to?.value ?? "")
        .trim()
        .toUpperCase();
      if (human) mark(key, e.action === "link_add" ? "add" : "remove");
    } else if (
      e.action === "field" &&
      /related.*ticket/i.test(String(e.payload?.subject?.value ?? ""))
    ) {
      const now = keysOf(e.payload?.to?.value);
      if (human) {
        for (const k of now) if (!fieldBefore.has(k)) mark(k, "add");
        for (const k of fieldBefore) if (!now.has(k)) mark(k, "remove");
      }
      fieldBefore = now;
    }
  }

  const positives: string[] = [];
  const negatives: string[] = [];
  for (const [key, what] of last) (what === "add" ? positives : negatives).push(key);
  return { positives: positives.sort(), negatives: negatives.sort() };
}

export interface HumanKnowledge extends HumanLinkSignals {
  cause?: string;
  fix?: string;
}

/**
 * Mọi tín hiệu người của một ticket: comment ghim + link/trường người gắn, gỡ.
 * Mã nhắc trong comment ghim là dương; người đã gỡ thì vẫn thắng (âm).
 */
export function humanKnowledgeOf(timeline: any[], selfIdentifier: string): HumanKnowledge {
  const pinned = pinnedKnowledgeOf(timeline, selfIdentifier);
  const links = humanLinkSignals(timeline, selfIdentifier);
  const negatives = new Set(links.negatives);
  const positives = new Set(links.positives);
  for (const id of pinned?.mentionedIds ?? []) if (!negatives.has(id)) positives.add(id);
  return {
    cause: pinned?.cause,
    fix: pinned?.fix,
    positives: [...positives].sort(),
    negatives: [...negatives].sort(),
  };
}
