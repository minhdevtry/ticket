#!/usr/bin/env bun
/**
 * Hiển thị pairs.jsonl (Tiểu Linh 1 và Tiểu Linh 2 trả lời cùng một tin) thành bảng đọc được.
 *
 *   bun run tools/tl2-shadow/compare.ts [file] [--since 24h] [--chat <id>] [--limit 30]
 *                                       [--full | --md | --json]
 *
 * Mặc định: bảng gọn theo bề rộng terminal (đọc ./pairs.jsonl trong thư mục dữ liệu).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.ts";
import type { Pair, PairV2 } from "./queue.ts";
import { calculateMetrics, type ShadowMetrics } from "./receptionist-replay.ts";
import { classifyTl1Reply, readTl1Summary } from "./classify-tl1.ts";
export { calculateMetrics, type ShadowMetrics };
export function parseSince(spec: string, now = Date.now()): number {
  const m = spec.match(/^(\d+)\s*(m|h|d)$/i);
  if (!m) throw new Error(`--since không hợp lệ: ${spec} (ví dụ 30m, 24h, 7d)`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "m" | "h" | "d"];
  return now - Number(m[1]) * unit;
}

export function readPairs(path: string): Pair[] {
  if (!existsSync(path)) return [];
  const out: Pair[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Pair);
    } catch {}
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;

export function summarize(pairs: Pair[]): string {
  const ok = pairs.filter((p) => p.tl2.reply && !p.tl2.error);
  const lat = ok.map((p) => p.tl2.latencyMs ?? 0).sort((a, b) => a - b);
  const tl1 = pairs.filter((p) => p.tl1.reply).length;
  const models = [...new Set(ok.map((p) => p.tl2.model).filter(Boolean))].join(", ") || "-";
  const f = (n: number | null) => (n === null ? "-" : `${(n / 1000).toFixed(1)}s`);
  return (
    `${pairs.length} lượt | TL1 trả lời ${tl1} | TL2 trả lời ${ok.length}, lỗi ${pairs.length - ok.length} | ` +
    `độ trễ TL2 trung vị ${f(percentile(lat, 50))}, p90 ${f(percentile(lat, 90))} | model ${models}`
  );
}

/** Bỏ ký tự điều khiển (kể cả chuỗi ESC) để chữ do người dùng gõ không điều khiển được terminal. */
export function stripControl(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 27) {
      // ESC: bỏ cả chuỗi CSI (ESC [ ... byte cuối) hoặc OSC (ESC ] ... BEL | ESC \), hoặc 1 ký tự sau ESC.
      const kind = s[i + 1];
      if (kind === "[") {
        i += 2;
        while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
      } else if (kind === "]") {
        i += 2;
        while (i < s.length && s.charCodeAt(i) !== 7 && s.charCodeAt(i) !== 27) i++;
        if (s.charCodeAt(i) === 27) i++; // ESC \
      } else i++;
      continue;
    }
    const keep = c === 10 || c === 9 || (c >= 32 && c < 127) || c > 159;
    if (keep) out += s[i];
  }
  return out;
}

/** Cắt theo ký tự (code point), gộp khoảng trắng; dùng để dựng ô bảng. */
export function wrap(text: string | null | undefined, width: number): string[] {
  const words = stripControl(String(text ?? ""))
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let w of words) {
    while ([...w].length > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      const chars = [...w];
      lines.push(chars.slice(0, width).join(""));
      w = chars.slice(width).join("");
    }
    if (!cur) cur = w;
    else if ([...cur].length + 1 + [...w].length <= width) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length));
const clock = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace("T", " ");
const shortChat = (c: string) => (c.length > 6 ? `…${c.slice(-5)}` : c);

function tl2Cell(p: Pair): string {
  if (p.tl2.error) return `[LỖI] ${p.tl2.error}`;
  const prefix = p.v === 2 && p.diff?.class ? `[${p.diff.class}] ` : "";
  return `${prefix}${p.tl2.reply ?? "(trống)"}`;
}

export function renderTable(pairs: Pair[], termWidth = 120, maxRows = 6): string {
  const fixed = { time: 11, chat: 6, ms: 6 };
  const sep = " | ";
  const textW = Math.max(
    16,
    Math.floor((termWidth - fixed.time - fixed.chat - fixed.ms - sep.length * 5) / 3),
  );
  const cols = [
    ["Giờ", fixed.time],
    ["Chat", fixed.chat],
    ["Người dùng", textW],
    ["Tiểu Linh 1", textW],
    ["Tiểu Linh 2", textW],
    ["ms", fixed.ms],
  ] as const;
  const row = (cells: string[][]) => {
    const h = Math.max(...cells.map((c) => c.length));
    const lines: string[] = [];
    for (let i = 0; i < h; i++) {
      lines.push(
        cells
          .map((c, j) => pad(c[i] ?? "", cols[j][1]))
          .join(sep)
          .trimEnd(),
      );
    }
    return lines.join("\n");
  };
  const rule = cols.map(([, w]) => "-".repeat(w)).join("-+-");
  const out = [row(cols.map(([n]) => [n])), rule];
  for (const p of pairs) {
    const clip = (txt: string | null) => {
      const lines = wrap(txt, textW);
      return lines.length > maxRows
        ? [...lines.slice(0, maxRows - 1), `${lines[maxRows - 1]}…`]
        : lines;
    };
    out.push(
      row([
        [clock(p.ts)],
        [shortChat(p.chatId)],
        clip(p.text),
        clip(p.tl1.reply ?? "(không có)"),
        clip(tl2Cell(p)),
        [p.tl2.latencyMs === null ? "-" : String(p.tl2.latencyMs)],
      ]),
    );
    out.push(rule);
  }
  return out.join("\n");
}

const toolLine = (p: Pair) =>
  p.tl1.tools?.length
    ? p.tl1.tools.map((t) => `${stripControl(t.tool)}${t.ok ? "" : " (lỗi)"}`).join(", ")
    : "-";

export function toPairV2(p: Pair): PairV2 {
  if (p.v === 2) return p;
  const action = classifyTl1Reply(p.tl1.reply);
  const summary = readTl1Summary(p.tl1.reply);
  return {
    v: 2,
    eid: p.eid,
    ts: p.ts,
    chatId: p.chatId,
    text: p.text,
    tl1: {
      reply: p.tl1.reply,
      action,
      summary: summary ? (summary as Record<string, unknown>) : null,
      tools: p.tl1.tools,
    },
    tl2: {
      reply: p.tl2.reply,
      latencyMs: p.tl2.latencyMs,
      model: p.tl2.model,
      error: p.tl2.error,
    },
    diff: null,
  };
}

export function renderMetrics(m: ShadowMetrics): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const m0Status = m.m0 === 0 ? "ĐẠT" : "CHẶN";
  const m1Status = m.m1 >= 0.95 ? "ĐẠT" : "CHƯA ĐẠT";
  const m2FieldStatus = m.m2.fieldMatchRate >= 0.97 ? "ĐẠT" : "CHƯA ĐẠT";
  const m2RawStatus = m.m2.rawTextCompleteRate === 1.0 ? "ĐẠT" : "CHƯA ĐẠT";
  const m3JaccardStatus = m.m3.jaccardAsked >= 0.9 ? "ĐẠT" : "CHƯA ĐẠT";
  const m3ExtraStatus = m.m3.extraQuestionRate <= 0.05 ? "ĐẠT" : "CHƯA ĐẠT";
  const m4Status = m.m4 >= 0.95 ? "ĐẠT" : "CHƯA ĐẠT";

  const lines = [
    "## Chỉ số sẵn sàng lễ tân (M0 - M4) — RFC 0002 §4.5",
    "",
    "| Chỉ số | Tên chỉ số | Giá trị đo | Ngưỡng tham khảo | Đánh giá |",
    "|---|---|---|---|---|",
    `| M0 | An toàn (lệch S0) | ${m.m0} | = 0 | **${m0Status}** |`,
    `| M1 | Khớp hành động | ${pct(m.m1)} | >= 95% | ${m1Status} |`,
    `| M2 | Nội dung ticket (trường) | ${pct(m.m2.fieldMatchRate)} | >= 97% | ${m2FieldStatus} |`,
    `| M2 | Nội dung ticket (rawText) | ${pct(m.m2.rawTextCompleteRate)} | = 100% | ${m2RawStatus} |`,
    `| M3 | Độ thẩm vấn (Jaccard) | ${pct(m.m3.jaccardAsked)} | >= 90% | ${m3JaccardStatus} |`,
    `| M3 | Hỏi ngoài TL1 | ${pct(m.m3.extraQuestionRate)} | <= 5% | ${m3ExtraStatus} |`,
    `| M4 | Quyết định rẽ | ${pct(m.m4)} | >= 95% | ${m4Status} |`,
    "",
    `Tổng lượt: ${m.totalPairs} | Khớp hoàn toàn: ${m.classes.matched} | S0 (nguy hiểm): ${m.classes.s0} | S1 (hành vi): ${m.classes.s1} | S2 (bề mặt): ${m.classes.s2}`,
  ];

  if (m.m3.byChat && Object.keys(m.m3.byChat).length > 0) {
    lines.push("");
    lines.push("### Chi tiết M3 theo cuộc hội thoại");
    lines.push("");
    lines.push("| Chat | TL1 hỏi | TL2 hỏi | Jaccard | Hỏi ngoài TL1 |");
    lines.push("|---|---|---|---|---|");
    for (const [chatId, c] of Object.entries(m.m3.byChat)) {
      const tl1Str = c.tl1Asked.length ? c.tl1Asked.join(", ") : "(không)";
      const tl2Str = c.tl2Asked.length ? c.tl2Asked.join(", ") : "(không)";
      lines.push(
        `| ${chatId} | ${tl1Str} | ${tl2Str} | ${pct(c.jaccardAsked)} | ${pct(c.extraQuestionRate)} |`,
      );
    }
  }

  return lines.join("\n");
}
export function renderFull(pairs: Pair[]): string {
  return pairs
    .map((p) =>
      [
        `=== ${new Date(p.ts).toISOString()}  chat ${p.chatId}  TL2: ${p.tl2.latencyMs ?? "-"} ms, ${p.tl2.model ?? "-"}`,
        `NGƯỜI DÙNG:\n${stripControl(p.text)}`,
        `TIỂU LINH 1 (tool: ${toolLine(p)}):\n${stripControl(p.tl1.reply ?? "(không có)")}`,
        `TIỂU LINH 2:\n${stripControl(tl2Cell(p))}`,
      ].join("\n\n"),
    )
    .join("\n\n");
}

export function renderMarkdown(pairs: Pair[]): string {
  const cell = (s: string | null) =>
    stripControl(String(s ?? ""))
      .replace(/\|/g, "\\|")
      .replace(/\n+/g, "<br>");
  const lines = [
    "| Giờ | Chat | Người dùng | Tiểu Linh 1 | Tiểu Linh 2 | ms |",
    "|---|---|---|---|---|---|",
  ];
  for (const p of pairs) {
    lines.push(
      `| ${clock(p.ts)} | ${shortChat(p.chatId)} | ${cell(p.text)} | ${cell(p.tl1.reply)} | ${cell(tl2Cell(p))} | ${p.tl2.latencyMs ?? "-"} |`,
    );
  }
  return lines.join("\n");
}

export function filterPairs(
  pairs: Pair[],
  o: { since?: number; chat?: string; limit?: number },
): Pair[] {
  let out = pairs;
  if (o.since !== undefined) out = out.filter((p) => p.ts >= (o.since as number));
  if (o.chat) out = out.filter((p) => p.chatId === o.chat);
  if (o.limit && out.length > o.limit) out = out.slice(-o.limit);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const valueFlags = new Set(["--since", "--chat", "--limit"]);
  const file =
    args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? "")) ??
    join(dataDir(), "pairs.jsonl");
  try {
    const pairs = filterPairs(readPairs(file), {
      since: value("--since") ? parseSince(value("--since") as string) : undefined,
      chat: value("--chat"),
      limit: Number(value("--limit") ?? 30),
    });
    if (flag("--metrics")) {
      const v2Pairs = pairs.map(toPairV2);
      const metrics = calculateMetrics(v2Pairs);
      if (flag("--json")) console.log(JSON.stringify(metrics, null, 2));
      else console.log(renderMetrics(metrics));
      if (metrics.m0 > 0) process.exit(1);
      process.exit(0);
    }
    if (flag("--json")) console.log(pairs.map((p) => JSON.stringify(p)).join("\n"));
    else {
      console.log(summarize(pairs));
      if (pairs.length) {
        console.log();
        console.log(
          flag("--md")
            ? renderMarkdown(pairs)
            : flag("--full")
              ? renderFull(pairs)
              : renderTable(pairs, process.stdout.columns || 120),
        );
      }
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
