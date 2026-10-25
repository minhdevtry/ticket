/**
 * LLM = người phán xử DUY NHẤT cho câu hỏi "2 ticket có cùng nguyên nhân gốc rễ
 * hay không" (KG chỉ biết sự thật đã xác nhận, Onyx/BM25 chỉ sinh ứng viên).
 * Xác minh TỪNG CẶP (ticket mới, 1 ứng viên) — nghiên cứu độc lập (researcher A,
 * báo cáo nghiên cứu nội bộ, mục 4) thử gộp nhiều ứng viên
 * vào 1 prompt/câu hỏi thì mô hình chấp nhận hàng loạt chỉ vì cùng chủ đề bề mặt
 * (vd cùng "trùng tài khoản" nhưng khác cơ chế cụ thể) — tệ hơn hẳn so 1-1.
 *
 * Bản thân JSON model trả về KHÔNG được tin tuyệt đối: `confidence` model tự
 * báo không tương quan đáng tin với đúng/sai (sai lệch HỆ THỐNG, không phải
 * nhiễu ngẫu nhiên — thử lại nhiều nhiệt độ vẫn ra cùng kết luận sai). Vì vậy
 * quyết định cuối dùng thêm chốt chặn xác định (quote-gate.ts) + yêu cầu cụm đã
 * lặp lại ≥ 2 lần (similar-ticket-source.ts), không tin một mình LLM.
 */
import { complete, extractJson, type LlmConfig } from "../../worker/llm";
import type { CorpusTicket } from "./similar-finder";
import { extractQuotedErrors } from "./quote-gate";

export type Confidence = "high" | "medium" | "low";

/**
 * Chế độ hỏi LLM. Đo 29/09 (script tạm scripts/tmp/eval-recent.ts trên 105
 * ticket TECH thật tạo từ 20/09, đáp án = tín hiệu người humanKnowledgeOf; +
 * lại benchmark mù cũ):
 * - "mechanism" (MẶC ĐỊNH — giữ nguyên sau khi đo): đòi cùng CƠ CHẾ gây lỗi —
 *   ticket mới lúc báo hiếm khi đủ chi tiết để khẳng định, khiến nhiều case
 *   không được gắn/gợi ý (vd TECH-975 vs cụm TECH-670, 14/14 false 27/09).
 *   Recent-real: trả lời 42/90 (47%), đúng 73%, đủ 87%, gắn sai 0/15. Dev:
 *   8/18, đúng 88%, gắn sai 0/34. Test: 7/20, đúng 69%, gắn sai 1/47.
 * - "applicability": hỏi ở cấp người xử lý thật sự dùng — cách xử lý/nguyên
 *   nhân ĐÃ XÁC NHẬN của cụm ứng viên có ÁP DỤNG được cho ticket mới không
 *   (cùng dạng lỗi, cùng cách xử lý), dựa trên hiện tượng mô tả — không đòi
 *   ticket mới phải tự nêu cơ chế. Đo được: trả lời/đúng/đủ đều tăng (recent-real
 *   48/90 53%, đúng 81%, đủ 92%; test 10/20, đúng 86%, đủ 90%) NHƯNG gắn sai
 *   tăng đều trên CẢ BA bộ đo (recent-real 0/15->3/15, dev 0/34->3/34, test
 *   1/47->2/47 — gộp lại tỉ lệ gắn sai 1/96 (1%) -> 8/96 (8%), tăng ~8 lần).
 *   Vi phạm nguyên tắc "thà bỏ sót còn hơn gắn sai" (docs/adr/0007) một cách hệ
 *   thống, không phải nhiễu mẫu nhỏ — vd TECH-914 (nguyên nhân thật: "HS xóa
 *   nhầm tài khoản") bị gắn nhầm sang cụm TECH-670/975 ("sai hạn học") chỉ vì
 *   trùng chữ "chưa cập nhật khóa học" bề mặt. VÌ VẬY CHƯA đổi mặc định — để
 *   dành làm cờ thử nghiệm, không bật production khi chưa có cách giữ độ phủ
 *   mà không tăng gắn sai (vd xiết lại quy tắc "trùng A khác trùng B" hoặc thêm
 *   một lớp gate riêng cho "applicability").
 */
export type JudgeMode = "mechanism" | "applicability";

export interface VerifyResult {
  sameRootCause: boolean;
  confidence: Confidence;
  newCauseGuess?: string;
  candidateCause?: string;
  matchingMechanism?: string;
}

const VERIFY_SYSTEM_PROMPT_MECHANISM = `Bạn là chuyên gia hỗ trợ kỹ thuật cấp cao, chuyên xác định 2 ticket hỗ trợ có thật sự CÙNG
NGUYÊN NHÂN GỐC RỄ (root cause) hay không, để quyết định có nên gắn link "ticket tương tự" cho nhân viên xử lý
tham khảo hay không. Hậu quả của việc gắn SAI rất nghiêm trọng (làm nhân viên xử lý sai hướng), còn bỏ sót thì
không sao (nhân viên vẫn tự xử lý được). Vì vậy nguyên tắc là: THÀ BỎ SÓT CÒN HƠN GẮN SAI.

Lưu ý quan trọng về dữ liệu: kho ticket có RẤT NHIỀU trường hợp chung một CHỦ ĐỀ RỘNG (ví dụ: "không tạo được đơn do
trùng tài khoản Vuihoc giữa 2 hồ sơ cùng tên", hay "lỗi khi chuyển gói/chuyển phí trên Tutor") nhưng người xử lý coi
phần lớn các ca này là ĐỘC LẬP với nhau (mỗi ca có một tình huống/cơ chế cụ thể khác nhau). Chỉ vì 2 ticket cùng
"chủ đề rộng" / cùng hệ thống / cùng loại triệu chứng bề mặt KHÔNG đủ để kết luận same_root_cause=true.

QUY TẮC QUAN TRỌNG NHẤT — dùng "thông báo lỗi nguyên văn" làm chữ ký nhận diện: nhiều ticket có kèm một câu thông
báo lỗi được hệ thống hiển thị y nguyên (thường nằm trong dấu ngoặc kép). Đây là chữ ký ĐẶC TRƯNG NHẤT để phân biệt
đúng loại lỗi, đáng tin hơn nhiều so với việc chỉ đọc chủ đề chung. Áp dụng:
  - Nếu CẢ 2 ticket đều có thông báo lỗi nguyên văn, và 2 câu đó rõ ràng LÀ CÙNG MỘT THÔNG BÁO (chỉ khác tên
    người/mã số/số liệu cụ thể) → đây là bằng chứng mạnh cho same_root_cause=true (nếu không có gì mâu thuẫn khác).
  - Nếu CẢ 2 ticket đều có thông báo lỗi nguyên văn nhưng nội dung câu đó KHÁC NHAU (không chỉ khác số liệu, mà
    khác cả cấu trúc/ý nghĩa câu) → same_root_cause PHẢI là false, dù chủ đề/hệ thống có giống nhau đến đâu.
  - Nếu ticket CŨ có thông báo lỗi nguyên văn nhưng ticket MỚI không hề nhắc tới nó (hoặc mô tả quá ngắn/chung
    chung, không đủ để khẳng định cùng cơ chế cụ thể) → same_root_cause=false, confidence="low" hoặc "medium".
  - Nếu không ticket nào có thông báo lỗi nguyên văn, mới xét tới các chi tiết cơ chế cụ thể khác (đúng cùng một
    kịch bản kỹ thuật/nghiệp vụ dẫn đến lỗi) để quyết định — chỉ trả lời true khi rất chắc chắn.

QUY TẮC THỨ HAI — phân biệt "BÁO LỖI hệ thống" với "YÊU CẦU NGHIỆP VỤ thông thường": trước khi so sánh nguyên
nhân, hãy tự hỏi mỗi ticket là loại nào: (a) BÁO LỖI — có hành vi SAI/BỊ CHẶN của hệ thống (thông báo lỗi, popup
chặn thao tác, dữ liệu tính sai...), hay (b) YÊU CẦU NGHIỆP VỤ — người dùng chỉ đang ĐỀ NGHỊ/YÊU CẦU xử lý một
tác vụ bình thường (đổi gói, chuyển sản phẩm, cập nhật thông tin...) mà KHÔNG có lỗi/chặn nào xảy ra, chỉ là việc
cần nhân sự thao tác tay. Một ticket loại (a) và một ticket loại (b) — dù cùng nhắc tới cùng nghiệp vụ/sản phẩm —
KHÔNG được coi là cùng nguyên nhân gốc rễ: same_root_cause=false trong trường hợp này.

Luôn trả lời bằng đúng 1 object JSON, không thêm chữ nào khác, theo schema:
{"new_cause_guess": "phán đoán ngắn gọn nguyên nhân của ticket MỚI dựa trên thông tin đang có",
 "candidate_cause": "nguyên nhân gốc rễ đã xác nhận của ticket ỨNG VIÊN (rút từ dữ liệu được cung cấp)",
 "matching_mechanism": "mô tả cơ chế cụ thể trùng khớp giữa 2 ticket, hoặc null nếu không có",
 "same_root_cause": true hoặc false,
 "confidence": "high" | "medium" | "low"}`;

const VERIFY_SYSTEM_PROMPT_APPLICABILITY = `Bạn là chuyên gia hỗ trợ kỹ thuật cấp cao. Ticket ỨNG VIÊN dưới đây đã xử lý XONG, có NGUYÊN NHÂN/CÁCH KHẮC
PHỤC đã được người xử lý XÁC NHẬN. Nhiệm vụ của bạn: xét xem CÁCH XỬ LÝ/NGUYÊN NHÂN ĐÃ XÁC NHẬN đó có ÁP DỤNG ĐƯỢC
cho ticket MỚI hay không — tức dựa trên HIỆN TƯỢNG (triệu chứng, hệ thống, tình huống cụ thể) mà ticket MỚI mô tả,
ticket mới có khả năng cao CÙNG DẠNG LỖI với ứng viên và sẽ được xử lý bằng ĐÚNG CÁCH đó — để quyết định có nên gắn
link "ticket tương tự" cho nhân viên xử lý tham khảo hay không. Hậu quả gắn SAI rất nghiêm trọng (làm nhân viên xử
lý sai hướng), còn bỏ sót thì không sao (nhân viên vẫn tự xử lý được). Vì vậy nguyên tắc: THÀ BỎ SÓT CÒN HƠN GẮN SAI.

Khác với việc đòi ticket mới phải TỰ NÊU đúng cơ chế kỹ thuật gây lỗi (ticket mới lúc vừa báo hầu như không bao giờ
có đủ chi tiết đó — người báo chỉ thấy hiện tượng, chưa biết nguyên nhân): bạn chỉ cần xét hiện tượng ticket mới mô
tả có khớp với DẠNG LỖI/TÌNH HUỐNG CỤ THỂ mà cụm ứng viên này đại diện hay không, dù ticket mới chưa tự giải thích
được vì sao nó xảy ra.

Lưu ý quan trọng về dữ liệu: kho ticket có RẤT NHIỀU trường hợp chung một CHỦ ĐỀ RỘNG (ví dụ: "không tạo được đơn do
trùng tài khoản Vuihoc giữa 2 hồ sơ cùng tên", hay "lỗi khi chuyển gói/chuyển phí trên Tutor") nhưng người xử lý coi
phần lớn các ca này là ĐỘC LẬP với nhau (mỗi ca một tình huống/cách xử lý cụ thể khác nhau). "Trùng A" (chủ đề rộng,
ví dụ cùng là trùng tài khoản) KHÔNG có nghĩa "trùng B" (đúng tình huống/cơ chế cụ thể mà cụm ứng viên này mô tả).
Chỉ cùng chủ đề rộng / cùng hệ thống / cùng loại triệu chứng bề mặt KHÔNG đủ để kết luận same_root_cause=true.

QUY TẮC QUAN TRỌNG NHẤT — "thông báo lỗi nguyên văn" (chữ trong ngoặc kép) vẫn là chữ ký đáng tin nhất khi có:
  - Nếu CẢ 2 ticket đều có, và rõ ràng LÀ CÙNG MỘT THÔNG BÁO (chỉ khác tên người/mã số/số liệu cụ thể) → bằng chứng
    mạnh cho same_root_cause=true (nếu không có gì mâu thuẫn khác).
  - Nếu CẢ 2 ticket đều có nhưng nội dung câu đó KHÁC NHAU (không chỉ khác số liệu, mà khác cả cấu trúc/ý nghĩa) →
    same_root_cause PHẢI là false, dù chủ đề/hệ thống có giống nhau đến đâu.
  - Nếu không có thông báo lỗi nguyên văn để đối chiếu (một trong hai, hoặc cả hai không có) → chuyển sang QUY TẮC
    THỨ BA dưới đây, KHÔNG tự động hạ xuống false chỉ vì thiếu quote.

QUY TẮC THỨ HAI — phân biệt "BÁO LỖI hệ thống" với "YÊU CẦU NGHIỆP VỤ thông thường": trước khi so sánh, hãy tự hỏi
mỗi ticket là loại nào: (a) BÁO LỖI — có hành vi SAI/BỊ CHẶN của hệ thống (thông báo lỗi, popup chặn thao tác, dữ
liệu tính sai...), hay (b) YÊU CẦU NGHIỆP VỤ — người dùng chỉ đang ĐỀ NGHỊ/YÊU CẦU xử lý một tác vụ bình thường (đổi
gói, chuyển sản phẩm, cập nhật thông tin...) mà KHÔNG có lỗi/chặn nào xảy ra, chỉ là việc cần nhân sự thao tác tay.
Một ticket loại (a) và một ticket loại (b) — dù cùng nhắc tới cùng nghiệp vụ/sản phẩm — KHÔNG được coi là cùng
nguyên nhân gốc rễ: same_root_cause=false trong trường hợp này.

QUY TẮC THỨ BA — khi không có thông báo lỗi nguyên văn để đối chiếu: hỏi "hiện tượng cụ thể mà ticket mới mô tả
(triệu chứng, hệ thống/màn hình, bối cảnh xảy ra) có khớp với DẠNG LỖI/TÌNH HUỐNG CỤ THỂ mà nguyên nhân-cách khắc
phục đã xác nhận của ứng viên mô tả hay không?" — không phải "ticket mới có tự nêu đúng cơ chế không". Nếu hiện
tượng khớp rõ về dạng lỗi và tình huống cụ thể (không chỉ chủ đề rộng) → same_root_cause=true, cách xử lý của ứng
viên áp dụng được; confidence "high" nếu khớp nhiều chi tiết cụ thể, "medium" nếu khớp nhưng còn thiếu vài chi tiết
để chắc chắn 100%. Nếu ticket mới quá ngắn/chung chung, hoặc chỉ khớp chủ đề rộng chứ không khớp tình huống cụ thể
cụm này mô tả → same_root_cause=false, confidence "low" hoặc "medium".

Luôn trả lời bằng đúng 1 object JSON, không thêm chữ nào khác, theo schema:
{"new_cause_guess": "phán đoán ngắn gọn hiện tượng/nguyên nhân của ticket MỚI dựa trên thông tin đang có",
 "candidate_cause": "nguyên nhân gốc rễ đã xác nhận của ticket ỨNG VIÊN (rút từ dữ liệu được cung cấp)",
 "matching_mechanism": "mô tả điểm khớp cụ thể về hiện tượng/tình huống giữa 2 ticket, hoặc null nếu không có",
 "same_root_cause": true hoặc false (cách xử lý đã xác nhận của ứng viên có áp dụng được cho ticket mới không),
 "confidence": "high" | "medium" | "low"}`;

const VERIFY_SYSTEM_PROMPTS: Record<JudgeMode, string> = {
  mechanism: VERIFY_SYSTEM_PROMPT_MECHANISM,
  applicability: VERIFY_SYSTEM_PROMPT_APPLICABILITY,
};

export interface OnyxSnippet {
  rootCause?: string;
  resolution?: string;
}

function buildCandidateBlock(
  cand: CorpusTicket,
  candQuotes: string[],
  onyxSnippet?: OnyxSnippet,
): string {
  const quotes = candQuotes.length ? candQuotes.map((q) => `"${q}"`).join(" | ") : "(không có)";
  const extra =
    onyxSnippet?.rootCause || onyxSnippet?.resolution
      ? `\nTóm tắt bổ sung (nguồn Onyx, đã ingest sẵn — có thể trùng ý với trên): Nguyên nhân: ${onyxSnippet.rootCause ?? "(không có)"}. Cách khắc phục: ${onyxSnippet.resolution ?? "(không có)"}.`
      : "";
  // Ngữ cảnh giàu (description/humanNotes — chỉ có khi caller điền, xem
  // similar-finder.ts::CorpusTicket): mô tả gốc + TOÀN BỘ ghi chú xử lý của
  // người (không chỉ câu Nguyên nhân/Cách khắc phục cô đọng) — khớp đúng
  // ngữ cảnh researcher A đưa cho LLM, giúp mô hình đủ căn cứ báo "high"
  // hơn là chỉ thấy 2 câu kết luận trần trụi.
  if (cand.description !== undefined || cand.humanNotes !== undefined) {
    const desc = (cand.description ?? cand.symptomsText ?? "").slice(0, 900);
    const notes = (cand.humanNotes ?? "").slice(0, 1400);
    return `Tiêu đề: ${cand.title}\nHệ thống/Sản phẩm: ${cand.system || "?"} / ${cand.product || "?"}\nThông báo lỗi nguyên văn tìm thấy: ${quotes}\nMô tả gốc: ${desc}\nGhi chú xử lý của người (không phải bot): ${notes || "(không có)"}${extra}`;
  }
  // Chế độ gọn (production: KG chỉ lưu symptomsText/humanCause/humanFix).
  const cause = cand.humanCause?.trim() || "(chưa có kết luận nguyên nhân)";
  const fix = cand.humanFix?.trim() || "(không có)";
  return `Tiêu đề: ${cand.title}\nThông báo lỗi nguyên văn tìm thấy: ${quotes}\nMô tả/triệu chứng: ${(cand.symptomsText ?? "").slice(0, 1200)}\nNguyên nhân đã xác nhận (người viết): ${cause}\nCách khắc phục (người viết): ${fix}${extra}`;
}

function buildUserPrompt(
  newText: string,
  newQuotes: string[],
  candidateId: string,
  candidateBlock: string,
): string {
  const q = newQuotes.length ? newQuotes.map((x) => `"${x}"`).join(" | ") : "(không có)";
  return `TICKET MỚI (đang cần xử lý, CHƯA có kết luận nguyên nhân):\n${newText}\nThông báo lỗi nguyên văn tìm thấy trong ticket mới: ${q}\n\nTICKET ỨNG VIÊN ${candidateId} (đã xử lý xong):\n${candidateBlock}\n\nSo sánh 2 ticket trên và trả lời đúng JSON theo schema đã nêu.`;
}

/**
 * Câu trích dẫn nguyên văn có thể tìm thấy ở BẤT KỲ trường nào mô tả ứng viên
 * (kể cả ngữ cảnh giàu description/humanNotes hay tóm tắt Onyx) — dùng chung
 * cho cả prompt LLM lẫn quote-gate (similar-ticket-source.ts) để không lệch nhau.
 */
export function candidateQuotesOf(candidate: CorpusTicket, onyxSnippet?: OnyxSnippet): string[] {
  return extractQuotedErrors(
    candidate.title,
    candidate.symptomsText,
    candidate.description,
    candidate.humanNotes,
    candidate.humanCause,
    candidate.humanFix,
    onyxSnippet?.rootCause,
    onyxSnippet?.resolution,
  );
}

/** Xác minh 1 cặp (ticket mới, 1 ứng viên cũ). Lỗi gọi LLM/parse JSON -> null (không chấp nhận ứng viên đó). */
export async function verifyCandidate(
  llm: LlmConfig,
  newText: string,
  candidate: CorpusTicket,
  onyxSnippet?: OnyxSnippet,
  /** Lần hỏi lại (≥ 2) để kiểm độ ổn định — chỉ thêm 1 dòng đánh dấu, nội dung giữ nguyên. */
  attempt = 1,
  /** "mechanism" (mặc định, tương thích cũ) hoặc "applicability" — xem JudgeMode ở trên. */
  judgeMode: JudgeMode = "mechanism",
): Promise<VerifyResult | null> {
  const newQuotes = extractQuotedErrors(newText);
  const candQuotes = candidateQuotesOf(candidate, onyxSnippet);
  const userPrompt =
    buildUserPrompt(
      newText,
      newQuotes,
      candidate.identifier,
      buildCandidateBlock(candidate, candQuotes, onyxSnippet),
    ) + (attempt > 1 ? `\n\n(Kiểm tra độc lập lần ${attempt})` : "");
  try {
    const raw = await complete(llm, VERIFY_SYSTEM_PROMPTS[judgeMode], userPrompt);
    const parsed = extractJson<Record<string, unknown>>(raw);
    if (!parsed) return null;
    const confidence =
      parsed.confidence === "high" || parsed.confidence === "medium"
        ? (parsed.confidence as Confidence)
        : "low";
    return {
      sameRootCause: Boolean(parsed.same_root_cause),
      confidence,
      newCauseGuess:
        typeof parsed.new_cause_guess === "string" ? parsed.new_cause_guess : undefined,
      candidateCause:
        typeof parsed.candidate_cause === "string" ? parsed.candidate_cause : undefined,
      matchingMechanism:
        typeof parsed.matching_mechanism === "string" ? parsed.matching_mechanism : undefined,
    };
  } catch {
    return null;
  }
}

export interface ClusterCard {
  clusterId: string;
  cause?: string;
  fix?: string;
  sampleIds: string[];
}

const QUESTION_SYSTEM_PROMPT = `Bạn giúp nhân viên xử lý ticket kỹ thuật phân biệt NHANH giữa nhiều khả năng
nguyên nhân gốc rễ cho một sự cố mới, khi hệ thống không đủ chắc chắn ticket mới thuộc khả năng nào. Dựa vào các
"thẻ nguyên nhân" (mỗi thẻ là 1 nguyên nhân đã từng xác nhận, kèm ví dụ ticket cũ), hãy đặt ĐÚNG MỘT câu hỏi ngắn
gọn, cụ thể, bằng tiếng Việt, giúp nhân viên tra cứu (CRM, lịch sử, màn hình cụ thể) để xác định ticket mới khớp
với thẻ nào. KHÔNG liệt kê lại toàn bộ các khả năng, chỉ hỏi điều cần kiểm tra. Trả lời đúng 1 object JSON:
{"question": "câu hỏi ngắn gọn"}`;

const FALLBACK_QUESTION =
  "Có nhiều khả năng nguyên nhân giống nhau về triệu chứng nhưng chưa chắc cùng cơ chế — anh/chị đối chiếu thêm CRM/lịch sử xử lý trước khi áp dụng gợi ý ticket cũ nhé.";

function buildQuestionPrompt(newText: string, cards: ClusterCard[]): string {
  const cardsText = cards
    .map(
      (c, i) =>
        `Thẻ ${i + 1} (ví dụ: ${c.sampleIds.join(", ")}):\nNguyên nhân: ${c.cause ?? "(không có)"}\nCách khắc phục: ${c.fix ?? "(không có)"}`,
    )
    .join("\n\n");
  return `TICKET MỚI:\n${newText}\n\nCÁC THẺ NGUYÊN NHÂN CÓ THỂ KHỚP:\n${cardsText}\n\nĐặt câu hỏi phân biệt theo đúng schema JSON đã nêu.`;
}

/** Ứng viên chấp nhận rơi vào ≥ 2 cụm khác nhau: không ghi gì, hỏi 1 câu phân biệt thay vì đoán liều. */
export async function askDiscriminatingQuestion(
  llm: LlmConfig,
  newText: string,
  cards: ClusterCard[],
): Promise<string> {
  try {
    const raw = await complete(llm, QUESTION_SYSTEM_PROMPT, buildQuestionPrompt(newText, cards));
    const parsed = extractJson<{ question?: string }>(raw);
    const q = parsed?.question?.trim();
    return q || FALLBACK_QUESTION;
  } catch {
    return FALLBACK_QUESTION;
  }
}
